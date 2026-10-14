// End-to-end mint against a Counterparty Core v11.5 regtest node, where
// `require_reveal_source_signature` is active from block 0.
//
//   CP=http://localhost:24000/v2 BTC_CLI="bitcoin-cli -datadir=..." node scripts/regtest-e2e.js
//
// Each case mints one numeric counter through Angel's own code (compose with
// the wallet's pubkey -> planMint preflight -> wallet signs commit + reveal ->
// verifySignedReveal -> broadcast) and then asks the node for the asset. The
// wallets are stood in for by the libraries and calls they sign with:
//
//   xcp      @scure/btc-signer, BIP342 sighash + signSchnorr with the source key
//            (XCP Wallet's src/core/bitcoin/taprootRevealSigner.ts)
//   horizon  bitcoinjs-lib v6 `psbt.signInput(i, ECPair)` with the address's
//            untweaked key (Horizon's TransactionServiceImpl.signPsbt)
//
// A last case replays the pre-0.10 page-held-key reveal to show the node ignores it.

import { execFileSync } from 'node:child_process'
import { p2tr, p2wpkh, SigHash, TaprootControlBlock, Transaction } from '@scure/btc-signer'
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes, signSchnorr } from '@scure/btc-signer/utils.js'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from 'tiny-secp256k1'
import * as Mint from '../src/mint.js'

const CP = process.env.CP || 'http://localhost:24000/v2'
const [cli, ...cliArgs] = (process.env.BTC_CLI || 'bitcoin-cli -regtest').split(' ')
const btc = (...a) => execFileSync(cli, [...cliArgs, ...a], { encoding: 'utf8' }).trim()
const btcJson = (...a) => JSON.parse(btc(...a))
const NET = Mint.networkParams('regtest')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function cp(path, init) {
  const r = await fetch(CP + path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok || body.error) throw new Error(`${path}: ${body.error || r.status}`)
  return body.result
}
const compose = (address, params) => cp(`/addresses/${address}/compose/issuance`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
})

async function waitForHeight(h) {
  for (let i = 0; i < 120; i++) {
    const r = await cp('/')
    if (r.counterparty_height >= h) return
    await sleep(1000)
  }
  throw new Error(`Counterparty did not reach block ${h}`)
}
const mine = async (n = 1) => {
  btc('-rpcwallet=miner', '-generate', String(n))
  await waitForHeight(Number(btc('getblockcount')))
}

async function fund(address) {
  btc('-rpcwallet=miner', 'sendtoaddress', address, '0.01')
  await mine()
  const { unspents } = btcJson('scantxoutset', 'start', JSON.stringify([`addr(${address})`]))
  const spk = Mint.addressScript(address, 'regtest')
  return unspents.map(u => `${u.txid}:${u.vout}:${Math.round(u.amount * 1e8)}:${spk}`).join(',')
}

// --- wallets ----------------------------------------------------------------
function xcpWallet(kind) {
  const priv = randomPrivateKeyBytes()
  const pub = pubECDSA(priv, true)
  const pay = kind === 'p2tr' ? p2tr(pubSchnorr(priv), undefined, NET) : p2wpkh(pub, NET)
  return {
    name: `xcp-${kind}`, address: pay.address,
    // xcp_getAddresses: active.publicKey (compressed)
    publicKey: Mint.bytesToHex(pub),
    signMint(commitPsbt, revealPsbt) {
      const commit = Transaction.fromPSBT(Mint.hexToBytes(commitPsbt))
      // a wallet fills in its own key-path data for a P2TR input; scure tweaks from it
      for (let i = 0; i < commit.inputsLength; i++) {
        if (kind === 'p2tr') commit.updateInput(i, { tapInternalKey: pubSchnorr(priv) }, true)
        commit.signIdx(priv, i, [SigHash.ALL])
      }
      // taprootRevealSigner.ts: preimageWitnessV1 over the leaf, signSchnorr with the source key
      const reveal = Transaction.fromPSBT(Mint.hexToBytes(revealPsbt))
      const input = reveal.getInput(0)
      const [cb, leafV] = input.tapLeafScript[0]
      const leaf = leafV.subarray(0, -1)
      const msg = reveal.preimageWitnessV1(0, [input.witnessUtxo.script], SigHash.DEFAULT, [input.witnessUtxo.amount], undefined, leaf, Mint.LEAF_VERSION)
      reveal.updateInput(0, { tapScriptSig: [[{ pubKey: pubSchnorr(priv), leafHash: Mint.tapLeafHash(leaf) }, signSchnorr(msg, priv)]] }, true)
      void cb
      return [Mint.bytesToHex(commit.toPSBT()), Mint.bytesToHex(reveal.toPSBT())]
    },
  }
}

function horizonWallet(kind) {
  const pair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
  const xOnly = Buffer.from(pair.publicKey.subarray(1, 33))
  const address = kind === 'p2tr'
    ? bitcoin.payments.p2tr({ internalPubkey: xOnly, network: bitcoin.networks.regtest }).address
    : bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pair.publicKey), network: bitcoin.networks.regtest }).address
  return {
    name: `horizon-${kind}`, address,
    // getAddresses: publicKey = the signing key's compressed pubkey
    publicKey: Buffer.from(pair.publicKey).toString('hex'),
    signMint(commitPsbt, revealPsbt) {
      const sign = (hex, sighashTypes, signer, keyPath) => {
        const psbt = bitcoin.Psbt.fromHex(hex, { network: bitcoin.networks.regtest })
        for (let i = 0; i < psbt.inputCount; i++) {
          if (keyPath) psbt.updateInput(i, { tapInternalKey: xOnly })
          psbt.signInput(i, signer, sighashTypes)
        }
        return psbt.toHex()
      }
      // Horizon signs every input with the same ECPair. A P2TR key-path commit
      // needs bitcoinjs' tweaked signer; the reveal gets the untweaked one.
      const commitSigner = kind === 'p2tr' ? pair.tweak(bitcoin.crypto.taggedHash('TapTweak', xOnly)) : pair
      return [sign(commitPsbt, [0, 1], commitSigner, kind === 'p2tr'), sign(revealPsbt, [0], pair)]
    },
  }
}

// --- a mint, exactly as web/index.html does it ---------------------------------
const PNG = Mint.hexToBytes('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201f2fd3a5c0000000049454e44ae426082')

async function mintWith(wallet) {
  const inputs_set = await fund(wallet.address)
  const asset = Mint.randomNumericAsset()
  const composed = await compose(wallet.address, {
    asset, quantity: '1', divisible: 'false', lock: 'true', sat_per_vbyte: '2', verbose: 'true',
    inputs_set, exclude_utxos_with_balances: 'true',
    description: Mint.encodeContent(PNG, 'image/png'), mime_type: 'image/png',
    encoding: 'taproot', inscription: 'false', multisig_pubkey: wallet.publicKey,
  })
  const plan = Mint.planMint(composed, wallet.address, wallet.publicKey, 'regtest')
  const [c, r] = wallet.signMint(plan.commitPsbt, plan.revealPsbt)
  const commit = Mint.finalize(c), reveal = Mint.finalize(r)
  Mint.verifySignedReveal(composed, plan.checked, commit.hex, reveal.hex)
  btc('sendrawtransaction', commit.hex)
  btc('sendrawtransaction', reveal.hex)
  await mine()
  return { asset, commitTxid: commit.txid, revealTxid: reveal.txid }
}

/** The pre-0.10 page: random leaf key under NUMS, signed by the page (git show 89a6485:src/mint.js). */
async function legacyMint() {
  const pair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
  const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pair.publicKey), network: bitcoin.networks.regtest }).address
  const inputs_set = await fund(address)
  const asset = Mint.randomNumericAsset()
  const composed = await compose(address, {
    asset, quantity: '1', divisible: 'false', lock: 'true', sat_per_vbyte: '2', verbose: 'true', inputs_set,
    description: Mint.encodeContent(PNG, 'image/png'), mime_type: 'image/png', encoding: 'taproot', inscription: 'false',
    multisig_pubkey: Buffer.from(pair.publicKey).toString('hex'),
  })
  // re-key: same leaf, last 32 bytes before OP_CHECKSIG swapped for a page-held key
  const pagePriv = randomPrivateKeyBytes()
  const leaf = Mint.hexToBytes(composed.envelope_script)
  leaf.set(pubSchnorr(pagePriv), leaf.length - 33)
  const NUMS = Mint.hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')
  const commitPay = p2tr(NUMS, { script: leaf }, NET, true)
  // the preflight refuses it
  let refused = null
  const reKeyed = {
    ...composed, envelope_script: Mint.bytesToHex(leaf), reveal_lock_scripts: [Mint.bytesToHex(commitPay.script)],
    reveal_control_block: Mint.bytesToHex(TaprootControlBlock.encode(commitPay.tapLeafScript[0][0])),
  }
  try { Mint.preflightReveal(reKeyed, address, Buffer.from(pair.publicKey).toString('hex'), 'regtest') }
  catch (e) { refused = e.message }
  // ...so build it the old way: commit pays the re-keyed address, the page signs the reveal
  const core = Transaction.fromRaw(Mint.hexToBytes(composed.rawtransaction), { allowUnknownOutputs: true })
  const ctx = new Transaction({ allowUnknownOutputs: true })
  for (let i = 0; i < core.inputsLength; i++) {
    const inp = core.getInput(i)
    ctx.addInput({ txid: inp.txid, index: inp.index, witnessUtxo: { script: Mint.hexToBytes(composed.lock_scripts[i]), amount: BigInt(composed.inputs_values[i]) } })
  }
  for (let i = 0; i < core.outputsLength; i++) {
    const o = core.getOutput(i)
    ctx.addOutput({ script: i === 0 ? commitPay.script : o.script, amount: o.amount })
  }
  const psbt = bitcoin.Psbt.fromBuffer(Buffer.from(ctx.toPSBT()), { network: bitcoin.networks.regtest })
  psbt.signAllInputs(pair); psbt.finalizeAllInputs()
  const commitHex = psbt.extractTransaction().toHex()
  const commitTxid = psbt.extractTransaction().getId()
  const coreReveal = Transaction.fromRaw(Mint.hexToBytes(composed.reveal_rawtransaction), { allowUnknownOutputs: true })
  const rtx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true })
  rtx.addInput({ txid: commitTxid, index: 0, witnessUtxo: { script: commitPay.script, amount: core.getOutput(0).amount }, tapLeafScript: commitPay.tapLeafScript })
  for (let i = 0; i < coreReveal.outputsLength; i++) rtx.addOutput(coreReveal.getOutput(i))
  rtx.signIdx(pagePriv, 0); rtx.finalize()
  btc('sendrawtransaction', commitHex)
  btc('sendrawtransaction', rtx.hex)
  await mine()
  return { asset, commitTxid, revealTxid: rtx.id, refused }
}

const cases = [xcpWallet('p2wpkh'), xcpWallet('p2tr'), horizonWallet('p2wpkh'), horizonWallet('p2tr')]
const results = []
for (const w of cases) {
  const m = await mintWith(w)
  const a = await cp(`/assets/${m.asset}`).catch(e => ({ error: e.message }))
  const issuances = await cp(`/transactions/${m.revealTxid}`).catch(e => ({ error: e.message }))
  results.push({ wallet: w.name, source: w.address, ...m, asset_api: a, reveal_tx_api: { tx_hash: issuances.tx_hash, block_index: issuances.block_index, source: issuances.source, valid: issuances.valid, transaction_type: issuances.transaction_type } })
}
const legacy = await legacyMint()
const legacyAsset = await cp(`/assets/${legacy.asset}`).then(() => 'FOUND (unexpected)', e => e.message)
results.push({ wallet: 'legacy page-held key (pre-0.10)', ...legacy, asset_api: legacyAsset })
console.log(JSON.stringify(results, null, 2))
const ok = results.slice(0, 4).every(r => r.asset_api?.issuer === r.source) && /not found/i.test(legacyAsset) && !!legacy.refused
console.log(ok ? 'E2E OK' : 'E2E FAILED')
process.exit(ok ? 0 : 1)

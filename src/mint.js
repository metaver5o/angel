/**
 * Angel mint — the PSBT half, bundled into web/mint.js (`npm run build`).
 *
 * The protocol is Counterparty's: a counter is an asset whose *description is
 * the file*, carried in Core's native v11 taproot envelope. Core composes the
 * pair — a commit paying a taproot output whose leaf holds the file, and a
 * reveal that spends it through that leaf and issues the asset.
 *
 * Since Core 11.5 (`require_reveal_source_signature`, mainnet block 969,320) a
 * reveal counts only when the leaf is closed by a key of the source address and
 * the reveal is signed with it (CounterpartyXCP/counterparty-core#3536). So the
 * leaf is Core's, untouched, and the wallet signs both transactions:
 *
 *   - the commit's internal key is the NUMS point, so the file's output can
 *     only ever be spent through the leaf — by the source key;
 *   - the reveal is built and signed before the commit is broadcast, so no
 *     commit goes out without a reveal that Counterparty will read.
 *
 * Ported from counters.fun (apps/web/src/lib/inscribe), trimmed to this one
 * path. A pre-11.5 compose (`signed_reveal_rawtransaction`, a throwaway key) is
 * refused: its reveal is ignored by the network.
 */

import { Address, OutScript, RawTx, SigHash, Transaction, p2tr, taprootNumsKey, utils as btcUtils } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { schnorr } from '@noble/curves/secp256k1.js'

export const LEAF_VERSION = 0xc0
/** Past this the public network will not relay the reveal at any fee rate. */
export const STANDARD_WITNESS_LIMIT_WU = 400_000
const DUST = 546
const OP_PUSH32 = 0x20
const OP_CHECKSIG = 0xac
const SIGHASH_ALL_SIG_BYTES = 65

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------
export function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(b)) throw new Error('invalid hex')
    out[i] = b
  }
  return out
}
export function bytesToHex(bytes) {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// content → Counterparty `description`
// ---------------------------------------------------------------------------
const TEXTUAL_APPLICATION = new Set([
  'application/xml', 'application/javascript', 'application/ecmascript', 'application/x-javascript',
  'application/json', 'application/manifest+json', 'application/x-python-code', 'application/x-sh',
  'application/x-csh', 'application/x-tex', 'application/x-latex', 'application/postscript',
  'application/yaml', 'application/x-yaml', 'application/sql',
])
const EXTENSION_TYPES = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', css: 'text/css', csv: 'text/csv',
  js: 'application/javascript', json: 'application/json', xml: 'application/xml', yaml: 'application/yaml',
  yml: 'application/yaml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  webm: 'video/webm', wasm: 'application/wasm', zip: 'application/zip', glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
}

/** Counterparty stores textual types as UTF-8 and everything else as hex. */
export function classifyMimeType(mimeType) {
  const t = mimeType.split(';')[0].trim().toLowerCase()
  if (t.startsWith('text/') || t.startsWith('message/') || t.endsWith('+xml') || t.endsWith('+json')) return 'text'
  return TEXTUAL_APPLICATION.has(t) ? 'text' : 'binary'
}

/** The browser's File.type is routinely empty or wrong; the extension decides when it can. */
export function guessContentType(file) {
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : ''
  return EXTENSION_TYPES[ext] || file.type || 'application/octet-stream'
}

export function encodeContent(body, mimeType) {
  if (classifyMimeType(mimeType) === 'binary') return bytesToHex(body)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new Error(`${mimeType} is a textual type but this file is not valid UTF-8. Convert it, or give it a binary type.`)
  }
}

/** A free numeric asset name: "A" + an integer in (26^12, 2^64). Core never draws one itself. */
export function randomNumericAsset() {
  const lo = 26n ** 12n + 1n, hi = 2n ** 64n
  const r = new Uint8Array(8); crypto.getRandomValues(r)
  let n = 0n; for (const b of r) n = (n << 8n) | BigInt(b)
  return 'A' + (lo + (n % (hi - lo))).toString()
}

/** scriptPubKey hex for an address — the 4th field of Core's `inputs_set` entries. */
export function addressScript(address) {
  return bytesToHex(OutScript.encode(Address().decode(address)))
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
/**
 * The throwaway reveal key of a mint started before source-signed reveals.
 * Only for finishing such a mint from localStorage: its reveal moves the
 * committed BTC on, but Counterparty ignores it.
 */
export function revealKeyFromHex(hex) {
  const privateKey = hexToBytes(hex)
  if (privateKey.length !== 32) throw new Error('a reveal key is 32 bytes')
  return { privateKey, xOnly: btcUtils.pubSchnorr(privateKey) }
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------
/** An ord envelope opens `OP_FALSE OP_IF "ord"`; Core's native one goes straight to its data. */
function isOrdEnvelope(script) {
  return script.length > 6 && script[0] === 0x00 && script[1] === 0x63 && script[2] === 0x03
    && script[3] === 0x6f && script[4] === 0x72 && script[5] === 0x64
}

/** The leaf's trailing `<32-byte key> OP_CHECKSIG` key — whoever Core keyed it to. */
function leafKey(script) {
  const at = script.length - 34
  if (at < 0 || script[at] !== OP_PUSH32 || script[script.length - 1] !== OP_CHECKSIG)
    throw new Error('envelope script does not end in <32-byte key> OP_CHECKSIG — Core built something this app does not recognise')
  return script.subarray(at + 1, at + 33)
}

/** The x-only key the leaf closes with, hex. Core 11.5 closes it with a key of the source. */
export function envelopeKey(script) { return bytesToHex(leafKey(script)) }

/**
 * The commit output for a leaf: a single-leaf taproot tree under the NUMS
 * point, so nobody can key-path spend the commit out from under the file.
 * (XCP Wallet checks exactly this before it will approve a commit.)
 */
export function commitEnvelope(leaf) {
  const internalKey = taprootNumsKey()
  const payment = p2tr(internalKey, { script: leaf, leafVersion: LEAF_VERSION }, undefined, true)
  const tapLeaf = payment.tapLeafScript?.[0]
  if (!payment.address || !tapLeaf) throw new Error('could not derive the commit address from the envelope')
  const controlVersion = LEAF_VERSION | (tapLeaf[0].version & 1)
  return { leaf, address: payment.address, script: payment.script, controlVersion, internalKey }
}

/** Core's own commit output script, derived the way Core derives it: internal key = leaf key. */
function coreCommitScript(compose) {
  if (compose.reveal_lock_scripts?.[0]) return hexToBytes(compose.reveal_lock_scripts[0])
  const script = hexToBytes(compose.envelope_script)
  return p2tr(leafKey(script), { script, leafVersion: LEAF_VERSION }, undefined, true).script
}

function coreRevealRaw(compose) {
  if (!compose.reveal_rawtransaction && compose.signed_reveal_rawtransaction)
    throw new Error('This Counterparty node is older than v11.5 and signed the reveal with a throwaway key, which the network now ignores. Nothing was signed.')
  if (!compose.reveal_rawtransaction) throw new Error('Core returned no reveal. The node must be v11.5+ with taproot envelopes enabled.')
  return RawTx.decode(hexToBytes(compose.reveal_rawtransaction))
}

// ---------------------------------------------------------------------------
// sizing
// ---------------------------------------------------------------------------
function varintLen(n) { return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9 }

/**
 * The reveal's weight once signed, known before anything is. It is a single
 * script-path input with a SIGHASH_ALL signature (65 bytes — the wallets
 * require the flag byte), the leaf and a one-element control block; the rest
 * is Core's outputs verbatim.
 */
export function revealWeight(compose, leaf) {
  const r = coreRevealRaw(compose)
  const base = RawTx.encode({
    version: r.version, lockTime: r.lockTime, segwitFlag: false,
    inputs: r.inputs.map(i => ({ ...i, finalScriptSig: new Uint8Array(0), witness: undefined })),
    outputs: r.outputs,
  }).length
  const witness = 1 + (1 + SIGHASH_ALL_SIG_BYTES) + (varintLen(leaf.length) + leaf.length) + (1 + 33)
  return base * 4 + 2 + witness
}

/** What Core's reveal pays out; everything above it in the commit is the reveal's fee. */
export function revealOutputTotal(compose) {
  return coreRevealRaw(compose).outputs.reduce((s, o) => s + Number(o.amount), 0)
}

/**
 * Satoshis the commit needs beyond what Core funded. Core sizes the commit for
 * its own reveal; ours is the same shape, so this is usually 0 or 1 — but a
 * reveal paying under its claimed rate can sit unconfirmed indefinitely, so it
 * is never negative.
 */
export function commitTopUp(compose, leaf, satPerVbyte) {
  const vsize = Math.ceil(revealWeight(compose, leaf) / 4)
  const needed = revealOutputTotal(compose) + Math.ceil(vsize * satPerVbyte)
  const funded = Number(RawTx.decode(hexToBytes(compose.rawtransaction)).outputs
    .find(o => sameBytes(o.script, coreCommitScript(compose)))?.amount ?? 0n)
  return Math.max(0, needed - funded)
}

// ---------------------------------------------------------------------------
// PSBTs
// ---------------------------------------------------------------------------
/**
 * The commit as a PSBT: Core's transaction with its commit output redirected
 * to our address. Inputs, change and fee are Core's arithmetic; `valueDelta`
 * moves satoshis from the change into the commit, so the miner fee is unchanged.
 */
export function buildCommitPsbt(compose, ourCommitScript, valueDelta = 0) {
  const core = RawTx.decode(hexToBytes(compose.rawtransaction))
  const oldScript = coreCommitScript(compose)
  const tx = new Transaction({ allowUnknownOutputs: true, version: core.version, lockTime: core.lockTime })

  core.inputs.forEach((input, i) => {
    const script = compose.lock_scripts?.[i], value = compose.inputs_values?.[i]
    if (script === undefined || value === undefined)
      throw new Error(`Core returned no prevout for input ${i}, so the commit cannot be signed safely.`)
    tx.addInput({
      txid: input.txid, index: input.index, sequence: input.sequence,
      witnessUtxo: { script: hexToBytes(script), amount: BigInt(value) },
      // XCP Wallet refuses anything else ("Input with not allowed sigHash=0").
      sighashType: SigHash.ALL,
    })
  })

  let commitIndex = -1
  core.outputs.forEach((o, i) => {
    if (!sameBytes(o.script, oldScript)) return
    if (commitIndex !== -1) throw new Error('Core composed more than one commit output')
    commitIndex = i
  })
  if (commitIndex === -1) throw new Error('Could not find the commit output in the composed transaction. Nothing was signed.')

  // Core puts change last.
  let changeIndex = -1
  if (valueDelta) for (let i = core.outputs.length - 1; i >= 0; i--) if (i !== commitIndex) { changeIndex = i; break }
  if (valueDelta && changeIndex === -1) throw new Error('This envelope needs more in the commit than Core funded, and there is no change output.')

  const commitValue = Number(core.outputs[commitIndex].amount) + valueDelta
  core.outputs.forEach((o, i) => {
    if (i === commitIndex) return tx.addOutput({ script: ourCommitScript, amount: BigInt(commitValue) })
    if (i === changeIndex) {
      const change = Number(o.amount) - valueDelta
      if (change < DUST) throw new Error('Topping up the commit would push the change below dust.')
      return tx.addOutput({ script: o.script, amount: BigInt(change) })
    }
    tx.addOutput({ script: o.script, amount: o.amount })
  })
  return { psbt: bytesToHex(tx.toPSBT()), commitValue, commitIndex }
}

/** The reveal: spend the commit through the leaf, reproducing Core's outputs verbatim. */
export function buildRevealPsbt(compose, commitTxid, commitIndex, commitValue, commit) {
  const r = coreRevealRaw(compose)
  const tx = new Transaction({ allowUnknownOutputs: true, version: r.version, lockTime: r.lockTime })
  tx.addInput({
    // Display-order txid; scure serialises it itself.
    txid: hexToBytes(commitTxid), index: commitIndex,
    witnessUtxo: { script: commit.script, amount: BigInt(commitValue) },
    tapLeafScript: [[
      { version: commit.controlVersion, internalKey: commit.internalKey, merklePath: [] },
      new Uint8Array([...commit.leaf, LEAF_VERSION]),
    ]],
    tapInternalKey: commit.internalKey,
    sighashType: SigHash.ALL,
  })
  for (const o of r.outputs) tx.addOutput({ script: o.script, amount: o.amount })
  return bytesToHex(tx.toPSBT())
}

/**
 * A PSBT from a plain Counterparty compose — no envelope, no surgery. For an
 * asset issued without a file: Core's finished transaction, with the prevouts
 * from its own `lock_scripts` / `inputs_values` so the wallet can sign it.
 */
export function buildPlainPsbt(compose) {
  const core = RawTx.decode(hexToBytes(compose.rawtransaction))
  const tx = new Transaction({ allowUnknownOutputs: true, version: core.version, lockTime: core.lockTime })
  core.inputs.forEach((input, i) => {
    const script = compose.lock_scripts?.[i], value = compose.inputs_values?.[i]
    if (script === undefined || value === undefined)
      throw new Error(`Core returned no prevout for input ${i}; the transaction cannot be signed safely.`)
    tx.addInput({
      txid: input.txid, index: input.index, sequence: input.sequence,
      witnessUtxo: { script: hexToBytes(script), amount: BigInt(value) },
      sighashType: SigHash.ALL,
    })
  })
  for (const o of core.outputs) tx.addOutput({ script: o.script, amount: o.amount })
  return bytesToHex(tx.toPSBT())
}

function fromPsbt(hex) {
  return Transaction.fromPSBT(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true })
}

/** Finalize a PSBT the wallet signed but (correctly) left unfinalized. */
export function finalize(signedPsbtHex) {
  const tx = fromPsbt(signedPsbtHex)
  tx.finalize()
  return { hex: bytesToHex(tx.extract()), txid: tx.id, weight: tx.weight }
}

/** Sign a pre-11.5 pending reveal with its throwaway key (see revealKeyFromHex). */
export function signRevealLocally(revealPsbt, privateKey) {
  const tx = fromPsbt(revealPsbt)
  let signed = false
  try {
    // scure permits SIGHASH_DEFAULT alone unless told otherwise, and silently
    // signs nothing when the input asks for ALL.
    signed = tx.signIdx(privateKey, 0, [SigHash.DEFAULT, SigHash.ALL])
  } catch (cause) {
    throw new Error('The reveal key does not match the envelope it is meant to open.', { cause })
  }
  if (!signed) throw new Error('The reveal key does not match the envelope it is meant to open.')
  return bytesToHex(tx.toPSBT())
}

/**
 * Check the wallet's reveal before anything is broadcast: input 0 carries a
 * signature by the key the leaf closes with, over this leaf, that verifies.
 * Otherwise the reveal would be rejected or, worse, ignored by Counterparty.
 */
export function checkRevealSigned(revealPsbtHex, leaf) {
  const tx = fromPsbt(revealPsbtHex)
  const input = tx.getInput(0)
  const key = leafKey(leaf), leafHash = tapLeafHash(leaf, LEAF_VERSION)
  const entry = (input.tapScriptSig || []).find(([k]) => sameBytes(k.pubKey, key) && sameBytes(k.leafHash, leafHash))
  if (!entry) throw new Error('The wallet did not sign the reveal with the key of your address. Nothing was broadcast.')
  const sig = entry[1]
  const hashType = sig.length === 65 ? sig[64] : SigHash.DEFAULT
  if (sig.length !== 64 && sig.length !== 65) throw new Error('The wallet returned a malformed reveal signature. Nothing was broadcast.')
  const msg = tx.preimageWitnessV1(0, [input.witnessUtxo.script], hashType, [input.witnessUtxo.amount], undefined, leaf, LEAF_VERSION)
  if (!schnorr.verify(sig.subarray(0, 64), msg, key)) throw new Error('The reveal signature does not verify. Nothing was broadcast.')
}

/** A script-path spend's txid excludes the witness, so this is exact before signing. */
export function unsignedTxid(psbtHex) { return fromPsbt(psbtHex).id }

/** The txid of a finalized raw transaction, computed rather than trusted. */
export function txidOf(rawHex) {
  return Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id
}

// ---------------------------------------------------------------------------
// plan: everything the page needs from a compose, before any signing
// ---------------------------------------------------------------------------
/**
 * Take Core's envelope as it is — closed by the source's key — and build the
 * commit PSBT around a NUMS-keyed output for it.
 */
export function planMint(compose, satPerVbyte) {
  if (!compose.envelope_script) throw new Error('Core returned no envelope. The node must be v11.5+ with taproot envelopes enabled.')
  coreRevealRaw(compose) // refuses a pre-11.5 compose
  const leaf = hexToBytes(compose.envelope_script)
  // Core applies `inscription` only to content-carrying issuances and otherwise
  // falls back silently; this app mints native counters, so check before signing.
  if (isOrdEnvelope(leaf)) throw new Error('Core built a counterparty + ord envelope, not the native one this app mints. Nothing was signed.')
  if (leaf[0] !== 0x00 || leaf[1] !== 0x63) throw new Error('Core built an envelope this app does not recognise. Nothing was signed.')
  if (compose.reveal_pubkey && envelopeKey(leaf) !== compose.reveal_pubkey.toLowerCase())
    throw new Error('Core\'s envelope is not closed by the key it says it is. Nothing was signed.')
  const commit = commitEnvelope(leaf)
  const weight = revealWeight(compose, leaf)
  if (weight > STANDARD_WITNESS_LIMIT_WU)
    throw new Error(`This reveal would be ${weight.toLocaleString('en-US')} weight units, past the ${STANDARD_WITNESS_LIMIT_WU.toLocaleString('en-US')} standard relay cap. Use a smaller file.`)
  const topUp = commitTopUp(compose, leaf, satPerVbyte)
  const { psbt, commitValue, commitIndex } = buildCommitPsbt(compose, commit.script, topUp)
  // The reveal spends commit:0 — Core's layout, and what the wallets check.
  if (commitIndex !== 0) throw new Error('Core put the commit output somewhere other than output 0. Nothing was signed.')
  const revealOutputs = revealOutputTotal(compose)
  return {
    commit, commitPsbt: psbt, commitValue, commitIndex,
    commitFee: compose.btc_fee, revealFee: commitValue - revealOutputs, revealWeight: weight,
    inputCount: compose.inputs_values.length,
  }
}

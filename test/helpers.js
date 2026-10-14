// Builds a compose response shaped like Counterparty Core v11.5's
// `compose/issuance?encoding=taproot` (composer.py: commit output 0 is a
// single-leaf tree whose internal key is the envelope key), for any leaf key.

import { p2tr, p2wpkh, Script, SigHash, TaprootControlBlock, Transaction } from '@scure/btc-signer'
import { pubECDSA, pubSchnorr } from '@scure/btc-signer/utils.js'
import { bytesToHex, hexToBytes, LEAF_VERSION } from '../src/mint.js'

export const key = (seed) => new Uint8Array(32).fill(seed)

/** A P2WPKH source: private key, compressed pubkey, x-only key, address, script. */
export function p2wpkhSource(seed) {
  const priv = key(seed), pub = pubECDSA(priv, true), pay = p2wpkh(pub)
  return { priv, pub, xOnly: pub.subarray(1), address: pay.address, script: pay.script }
}
/** A BIP86 P2TR source: internal private key, x-only internal and output keys, address, script. */
export function p2trSource(seed) {
  const priv = key(seed), internal = pubSchnorr(priv), pay = p2tr(internal)
  return { priv, internal, outputKey: pay.tweakedPubkey, address: pay.address, script: pay.script }
}

/** `OP_FALSE OP_IF <chunks> OP_ENDIF <xOnly> OP_CHECKSIG`, as Core's generate_envelope_script. */
export function envelope(xOnly, data = new TextEncoder().encode('a counterparty issuance message')) {
  const chunks = []
  for (let i = 0; i < data.length; i += 520) chunks.push(data.subarray(i, i + 520))
  return Script.encode([0, 'IF', ...chunks, 'ENDIF', xOnly, 'CHECKSIG'])
}

/** A Core-shaped compose for `leaf`, committed under `internalKey` (Core uses the leaf's own key). */
export function fakeCompose({ leaf, internalKey, sourceScript, leafVersion = LEAF_VERSION }) {
  const pay = p2tr(internalKey, { script: leaf, leafVersion }, undefined, true)
  const commitValue = 20_000n
  const commit = new Transaction({ allowUnknownOutputs: true })
  commit.addInput({ txid: new Uint8Array(32).fill(7), index: 1 })
  commit.addOutput({ script: pay.script, amount: commitValue })
  commit.addOutput({ script: sourceScript, amount: 79_000n })
  const reveal = new Transaction({ allowUnknownOutputs: true })
  reveal.addInput({ txid: commit.id, index: 0 })
  reveal.addOutput({ script: Script.encode(['RETURN', new TextEncoder().encode('CNTRPRTY')]), amount: 0n })
  return {
    rawtransaction: commit.hex,
    reveal_rawtransaction: reveal.hex,
    envelope_script: bytesToHex(leaf),
    reveal_control_block: bytesToHex(TaprootControlBlock.encode(pay.tapLeafScript[0][0])),
    reveal_lock_scripts: [bytesToHex(pay.script)],
    reveal_inputs_values: [Number(commitValue)],
    lock_scripts: [bytesToHex(sourceScript)],
    inputs_values: [100_000],
    btc_fee: 1_000,
  }
}

/** Sign every input of a PSBT the way a wallet would, with `priv`; returns PSBT hex. */
export function walletSign(psbtHex, priv) {
  const tx = Transaction.fromPSBT(hexToBytes(psbtHex), { allowUnknownOutputs: true })
  for (let i = 0; i < tx.inputsLength; i++) tx.signIdx(priv, i, [SigHash.DEFAULT, SigHash.ALL])
  return bytesToHex(tx.toPSBT())
}

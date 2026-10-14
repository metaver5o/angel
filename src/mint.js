/**
 * Angel mint — the PSBT half, bundled into web/mint.js (`npm run build`).
 *
 * The protocol is Counterparty's: a counter is an asset whose *description is
 * the file*, carried in Core's native taproot envelope. Core composes the pair:
 * a commit paying a taproot output whose only leaf holds the file, and a
 * reveal that spends it through that leaf and issues the asset.
 *
 * Since Core v11.5 (`require_reveal_source_signature`, mainnet block 969,320,
 * GHSA-q27c-r246-f6qw) a reveal counts only when the source address signed it.
 * The leaf must be exactly `OP_FALSE OP_IF <pushes> OP_ENDIF <32-byte key>
 * OP_CHECKSIG`, committed to the commit output under leaf version 0xc0, and the
 * key must be a key of the source: the pubkey of a P2WPKH (or P2SH-P2WPKH /
 * P2PKH) address, or a P2TR address's output key or BIP86 internal key. Any
 * other reveal is ignored without an error, and the name stays free.
 *
 * So nothing here touches Core's envelope. The page sends the wallet's own
 * pubkey as `multisig_pubkey`, checks that what Core returned passes the rule
 * for that key (`preflightReveal`, a port of counterparty-rs/src/reveal.rs),
 * and has the CONNECTED WALLET sign both the commit and the reveal. The reveal's
 * signature is verified against its sighash (`verifySignedReveal`) before the
 * commit is broadcast: once the commit is mined the reveal cannot be changed.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { Address, NETWORK, OutScript, RawTx, SigHash, TaprootControlBlock, TEST_NETWORK, Transaction } from '@scure/btc-signer'
import { hash160, tagSchnorr, taprootTweakPubkey } from '@scure/btc-signer/utils.js'

export const LEAF_VERSION = 0xc0
/** Past this the public network will not relay the reveal at any fee rate. */
export const STANDARD_WITNESS_LIMIT_WU = 400_000
/** A SIGHASH_ALL Schnorr signature; Core sizes the reveal fee for it, and DEFAULT is a byte smaller. */
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

/** scure network params for the network name Counterparty reports. */
export function networkParams(name = 'mainnet') {
  if (name === 'mainnet') return NETWORK
  if (name === 'regtest') return { ...TEST_NETWORK, bech32: 'bcrt' }
  return TEST_NETWORK // testnet3, testnet4, signet
}

/** scriptPubKey hex for an address — the 4th field of Core's `inputs_set` entries. */
export function addressScript(address, network) {
  return bytesToHex(OutScript.encode(Address(networkParams(network)).decode(address)))
}

// ---------------------------------------------------------------------------
// Core v11.5's reveal rule (counterparty-rs/src/reveal.rs), ported line for line
// ---------------------------------------------------------------------------
const OP_0 = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d, OP_PUSHDATA4 = 0x4e
const OP_1NEGATE = 0x4f, OP_IF = 0x63, OP_ENDIF = 0x68, OP_CHECKSIG = 0xac

/** Script instructions as rust-bitcoin's `Script::instructions()` reads them (non-minimal pushes allowed). */
function* instructions(script) {
  let i = 0
  while (i < script.length) {
    const op = script[i++]
    let n = -1
    if (op === OP_0) n = 0
    else if (op < OP_PUSHDATA1) n = op
    else if (op === OP_PUSHDATA1) { if (i + 1 > script.length) throw new Error('truncated push'); n = script[i]; i += 1 }
    else if (op === OP_PUSHDATA2) { if (i + 2 > script.length) throw new Error('truncated push'); n = script[i] | (script[i + 1] << 8); i += 2 }
    else if (op === OP_PUSHDATA4) {
      if (i + 4 > script.length) throw new Error('truncated push')
      n = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16)) + script[i + 3] * 0x1000000; i += 4
    }
    if (n === -1) { yield { op }; continue }
    if (i + n > script.length) throw new Error('truncated push')
    yield { push: script.subarray(i, i + n) }
    i += n
  }
}

/** `OP_1NEGATE` and `OP_1`..`OP_16`, the only non-data opcodes allowed inside the envelope. */
const isPushnum = (op) => op === OP_1NEGATE || (op >= 0x51 && op <= 0x60)

/** A valid BIP340 x-only key, as `XOnlyPublicKey::from_slice` requires. */
function isXOnlyKey(bytes) {
  if (bytes.length !== 32) return false
  try { schnorr.utils.lift_x(BigInt('0x' + bytesToHex(bytes))); return true } catch { return false }
}

export class RevealRuleError extends Error {
  constructor(code, message) { super(message); this.name = 'RevealRuleError'; this.code = code }
}
const fail = (code, message) => { throw new RevealRuleError(code, message) }

/**
 * The key of a canonical envelope: `OP_FALSE OP_IF <push-only body> OP_ENDIF
 * <32-byte key> OP_CHECKSIG`, nothing else (`envelope_leaf_key` in reveal.rs).
 */
export function envelopeLeafKey(script) {
  let it
  try {
    const all = [...instructions(script)]
    it = all[Symbol.iterator]()
  } catch { fail('NotAnEnvelope', 'leaf is not a canonical envelope (unparsable script)') }
  const next = () => it.next().value
  const first = next()
  if (!first || !first.push || first.push.length !== 0) fail('NotAnEnvelope', 'leaf is not a canonical envelope (must start with OP_FALSE)')
  if (next()?.op !== OP_IF) fail('NotAnEnvelope', 'leaf is not a canonical envelope (OP_FALSE must be followed by OP_IF)')
  for (;;) {
    const ins = next()
    if (!ins) fail('NotAnEnvelope', 'leaf is not a canonical envelope (missing OP_ENDIF)')
    if (ins.push) continue
    if (ins.op === OP_ENDIF) break
    if (isPushnum(ins.op)) continue
    fail('NotAnEnvelope', 'leaf is not a canonical envelope (non-push opcode inside the envelope)')
  }
  const keyIns = next()
  if (!keyIns?.push || keyIns.push.length !== 32) fail('NotAnEnvelope', 'leaf is not a canonical envelope (OP_ENDIF must be followed by a 32-byte key)')
  if (!isXOnlyKey(keyIns.push)) fail('InvalidLeafKey', 'invalid envelope public key')
  if (next()?.op !== OP_CHECKSIG) fail('NotAnEnvelope', 'leaf is not a canonical envelope (key must be followed by OP_CHECKSIG)')
  if (next() !== undefined) fail('NotAnEnvelope', 'leaf is not a canonical envelope (trailing bytes after OP_CHECKSIG)')
  return keyIns.push
}

const isP2tr = (s) => s.length === 34 && s[0] === 0x51 && s[1] === 0x20
const isP2wpkh = (s) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14
const isP2pkh = (s) => s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac
const isP2sh = (s) => s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87

/** The x-only key lifted to both parities, compressed or uncompressed. */
function liftedKeys(xOnly, compressed = true) {
  const P = schnorr.utils.lift_x(BigInt('0x' + bytesToHex(xOnly)))
  const even = P.y % 2n === 0n ? P : P.negate()
  return [even, even.negate()].map(p => p.toBytes(compressed))
}

/** Whether `key` is a key of the address whose scriptPubKey is `source` (`source_controls_key`). */
export function sourceControlsKey(source, key) {
  if (isP2tr(source)) {
    const outputKey = source.subarray(2, 34)
    if (sameBytes(key, outputKey)) return true
    return sameBytes(taprootTweakPubkey(key, new Uint8Array(0))[0], outputKey)
  }
  if (isP2wpkh(source)) return liftedKeys(key).some(pk => sameBytes(hash160(pk), source.subarray(2, 22)))
  if (isP2pkh(source)) {
    const h = source.subarray(3, 23)
    return [...liftedKeys(key), ...liftedKeys(key, false)].some(pk => sameBytes(hash160(pk), h))
  }
  if (isP2sh(source)) {
    return liftedKeys(key).some(pk => sameBytes(hash160(new Uint8Array([0x00, 0x14, ...hash160(pk)])), source.subarray(2, 22)))
  }
  return false
}

function compactSize(n) {
  if (n < 0xfd) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, n >> 8]
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}
export const tapLeafHash = (script, version = LEAF_VERSION) =>
  tagSchnorr('TapLeaf', new Uint8Array([version, ...compactSize(script.length)]), script)

/** Decode a control block as `ControlBlock::decode` does: 33 + 32m bytes, m ≤ 128, a valid internal key. */
export function decodeControlBlock(bytes) {
  if (bytes.length < 33 || (bytes.length - 33) % 32 !== 0 || (bytes.length - 33) / 32 > 128) fail('InvalidControlBlock', 'invalid taproot control block')
  const version = bytes[0] & 0xfe
  // 0x50 would read as an annex; odd versions are not leaf versions.
  if (version === 0x50) fail('InvalidControlBlock', 'invalid taproot control block')
  const internalKey = bytes.subarray(1, 33)
  if (!isXOnlyKey(internalKey)) fail('InvalidControlBlock', 'invalid taproot control block')
  const merklePath = []
  for (let i = 33; i < bytes.length; i += 32) merklePath.push(bytes.subarray(i, i + 32))
  return { version, parity: bytes[0] & 1, internalKey, merklePath }
}

/** Whether the control block commits `leaf` to `outputKey` (`verify_taproot_commitment`). */
function commitsTo(cb, leaf, outputKey) {
  let node = tapLeafHash(leaf, cb.version)
  for (const sibling of cb.merklePath) {
    const [a, b] = compareLex(node, sibling) <= 0 ? [node, sibling] : [sibling, node]
    node = tagSchnorr('TapBranch', a, b)
  }
  const [tweaked, parity] = taprootTweakPubkey(cb.internalKey, node)
  return sameBytes(tweaked, outputKey) && parity === cb.parity
}
function compareLex(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

/**
 * Core v11.5's `check_reveal_source_signature`: whether a reveal whose input 0
 * spends `commitScript` with `witness` is provably signed by `sourceScript`.
 * Returns the leaf key; throws `RevealRuleError` naming the first failed check.
 * The signature itself (witness[0]) is not looked at here: Bitcoin checks it,
 * and `verifySignedReveal` checks it before anything is broadcast.
 */
export function checkRevealSourceSignature(commitScript, sourceScript, witness) {
  if (witness.length !== 3) fail('WitnessShape', `witness has ${witness.length} elements, a tapscript reveal has exactly 3`)
  if (!isP2tr(commitScript)) fail('CommitNotP2tr', 'the spent commit output is not P2TR')
  const outputKey = commitScript.subarray(2, 34)
  if (!isXOnlyKey(outputKey)) fail('InvalidCommitKey', 'invalid P2TR output key')
  const cb = decodeControlBlock(witness[2])
  if (cb.version !== LEAF_VERSION) fail('LeafVersion', `unsupported taproot leaf version 0x${cb.version.toString(16).padStart(2, '0')}`)
  if (!commitsTo(cb, witness[1], outputKey)) fail('CommitmentMismatch', 'control block does not commit the leaf to the output key')
  const leafKey = envelopeLeafKey(witness[1])
  if (!sourceControlsKey(sourceScript, leafKey)) fail('SourceKeyMismatch', 'envelope key does not belong to the source address')
  return leafKey
}

// ---------------------------------------------------------------------------
// Core's compose → what the reveal will be
// ---------------------------------------------------------------------------
/** An ord envelope opens `OP_FALSE OP_IF "ord"`; Core's native one goes straight to its data. */
function isOrdEnvelope(script) {
  return script.length > 6 && script[0] === 0x00 && script[1] === 0x63 && script[2] === 0x03
    && script[3] === 0x6f && script[4] === 0x72 && script[5] === 0x64
}

function coreRevealRaw(compose) {
  if (!compose.reveal_rawtransaction)
    throw new Error('Core returned no reveal. The node must be Counterparty Core v11.5+ (it composes an unsigned reveal for the wallet to sign).')
  return RawTx.decode(hexToBytes(compose.reveal_rawtransaction))
}

/** The x-only form of a compressed (33-byte) or x-only (32-byte) pubkey, hex. */
export function xOnlyHex(pubkeyHex) {
  const b = hexToBytes(pubkeyHex)
  if (b.length === 32) return bytesToHex(b)
  if (b.length === 33 && (b[0] === 2 || b[0] === 3)) return bytesToHex(b.subarray(1))
  throw new Error('The wallet returned a public key that is neither compressed nor x-only.')
}

/**
 * Everything checked before anything is signed or broadcast. Refuses unless
 * the reveal Core composed will be attributed to `sourceAddress` under v11.5,
 * and its leaf key is `walletKeyHex` (so the connected wallet can sign it):
 *
 *   - Core's envelope is canonical and is the one Angel asked for (native, not ord);
 *   - its key is a key of the source address;
 *   - its key is the wallet's key we sent as `multisig_pubkey`;
 *   - the control block is tapscript (0xc0) and, with the leaf hash, rebuilds
 *     exactly the commit output script (`reveal_lock_scripts[0]`);
 *   - that script and value are commit output 0, and the reveal spends it, alone.
 *
 * Returns the parsed pieces the PSBTs are built from.
 */
export function preflightReveal(compose, sourceAddress, walletKeyHex, network) {
  for (const k of ['rawtransaction', 'reveal_rawtransaction', 'envelope_script', 'reveal_control_block', 'reveal_lock_scripts', 'reveal_inputs_values'])
    if (compose[k] === undefined || compose[k] === null) throw new Error(`Core returned no \`${k}\`. The node must be Counterparty Core v11.5+. Nothing was signed.`)
  const leaf = hexToBytes(compose.envelope_script)
  const controlBlock = hexToBytes(compose.reveal_control_block)
  const commitScript = hexToBytes(compose.reveal_lock_scripts[0])
  const commitValue = Number(compose.reveal_inputs_values[0])
  if (compose.reveal_lock_scripts.length !== 1 || compose.reveal_inputs_values.length !== 1)
    throw new Error('Core composed a reveal with more than one input. Nothing was signed.')
  if (isOrdEnvelope(leaf)) throw new Error('Core built a counterparty + ord envelope, not the native one this app mints. Nothing was signed.')

  const sourceScript = hexToBytes(addressScript(sourceAddress, network))
  if (!isP2wpkh(sourceScript) && !isP2tr(sourceScript))
    throw new Error('Counters need a native segwit (bc1q…) or taproot (bc1p…) address. Nothing was signed.')

  let leafKey
  try {
    leafKey = checkRevealSourceSignature(commitScript, sourceScript, [new Uint8Array(64), leaf, controlBlock])
  } catch (e) {
    if (e instanceof RevealRuleError) throw new Error(`Refusing to mint: Counterparty would ignore this reveal (${e.message}). Nothing was signed or broadcast.`, { cause: e })
    throw e
  }
  if (bytesToHex(leafKey) !== xOnlyHex(walletKeyHex))
    throw new Error('Refusing to mint: the envelope is not closed by the key your wallet reported, so the wallet could not sign the reveal. Nothing was signed or broadcast.')

  const commit = RawTx.decode(hexToBytes(compose.rawtransaction))
  const out0 = commit.outputs[0]
  if (!out0 || !sameBytes(out0.script, commitScript) || Number(out0.amount) !== commitValue)
    throw new Error('Refusing to mint: the commit\'s first output is not the one the reveal spends. Nothing was signed or broadcast.')
  const reveal = coreRevealRaw(compose)
  const commitTxid = new Transaction({ allowUnknownOutputs: true, version: commit.version, lockTime: commit.lockTime })
  commit.inputs.forEach(i => commitTxid.addInput({ txid: i.txid, index: i.index, sequence: i.sequence }))
  commit.outputs.forEach(o => commitTxid.addOutput({ script: o.script, amount: o.amount }))
  if (reveal.inputs.length !== 1 || bytesToHex(reveal.inputs[0].txid) !== commitTxid.id || reveal.inputs[0].index !== 0)
    throw new Error('Refusing to mint: Core\'s reveal does not spend the commit\'s first output. Nothing was signed or broadcast.')

  return { leaf, controlBlock, commitScript, commitValue, commitTxid: commitTxid.id, leafKey, sourceScript }
}

// ---------------------------------------------------------------------------
// sizing
// ---------------------------------------------------------------------------
function varintLen(n) { return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9 }

/** The reveal's weight once signed (SIGHASH_ALL-sized signature, Core's leaf and control block). */
export function revealWeight(compose) {
  const r = coreRevealRaw(compose)
  const base = RawTx.encode({
    version: r.version, lockTime: r.lockTime, segwitFlag: false,
    inputs: r.inputs.map(i => ({ ...i, finalScriptSig: new Uint8Array(0), witness: undefined })),
    outputs: r.outputs,
  }).length
  const leafLen = compose.envelope_script.length / 2, cbLen = compose.reveal_control_block.length / 2
  const witness = 1 + (1 + SIGHASH_ALL_SIG_BYTES) + (varintLen(leafLen) + leafLen) + (varintLen(cbLen) + cbLen)
  return base * 4 + 2 + witness
}

/** What Core's reveal pays out; everything above it in the commit output is the reveal's fee. */
export function revealOutputTotal(compose) {
  return coreRevealRaw(compose).outputs.reduce((s, o) => s + Number(o.amount), 0)
}

// ---------------------------------------------------------------------------
// PSBTs
// ---------------------------------------------------------------------------
/**
 * A PSBT of a transaction Core composed, unchanged: its inputs get their
 * prevouts from Core's own `lock_scripts` / `inputs_values` so the wallet can
 * sign them. Used for plain issuances and for the commit.
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
      // XCP Wallet refuses anything else ("Input with not allowed sigHash=0").
      sighashType: SigHash.ALL,
    })
  })
  for (const o of core.outputs) tx.addOutput({ script: o.script, amount: o.amount })
  return bytesToHex(tx.toPSBT())
}

/**
 * The reveal as a PSBT for the wallet: Core's unsigned reveal, its one input a
 * tapscript spend of commit output 0 (witness UTXO = that output;
 * PSBT_IN_TAP_LEAF_SCRIPT = Core's control block + envelope at 0xc0). The
 * wallet signs it with the source key (SIGHASH_DEFAULT).
 */
export function buildRevealPsbt(compose, checked) {
  const r = coreRevealRaw(compose)
  const cb = TaprootControlBlock.decode(checked.controlBlock)
  const tx = new Transaction({ allowUnknownOutputs: true, version: r.version, lockTime: r.lockTime })
  tx.addInput({
    txid: r.inputs[0].txid, index: r.inputs[0].index, sequence: r.inputs[0].sequence,
    witnessUtxo: { script: checked.commitScript, amount: BigInt(checked.commitValue) },
    tapLeafScript: [[cb, new Uint8Array([...checked.leaf, LEAF_VERSION])]],
  })
  for (const o of r.outputs) tx.addOutput({ script: o.script, amount: o.amount })
  return bytesToHex(tx.toPSBT())
}

function fromPsbt(hex) {
  return Transaction.fromPSBT(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true })
}

/** Finalize a PSBT the wallet signed. A wallet may return it finalized already. */
export function finalize(signedPsbtHex) {
  const tx = fromPsbt(signedPsbtHex)
  if (!tx.isFinal) tx.finalize()
  return { hex: bytesToHex(tx.extract()), txid: tx.id, weight: tx.weight }
}

/** A segwit transaction's txid excludes the witness, so this is exact before signing. */
export function unsignedTxid(psbtHex) { return fromPsbt(psbtHex).id }

/** The txid of a finalized raw transaction, computed rather than trusted. */
export function txidOf(rawHex) {
  return Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id
}

/**
 * The last check before the commit is broadcast. The finalized reveal must be
 * exactly Core's reveal with the witness `<signature> <envelope> <control block>`,
 * pass the v11.5 rule for the source, and carry a valid BIP340 signature by the
 * leaf key over its BIP342 sighash (DEFAULT or ALL) — i.e. Bitcoin will accept
 * it and Counterparty will attribute it to the source. The commit must be the
 * one the reveal spends. Throws, and nothing may be broadcast, otherwise.
 */
export function verifySignedReveal(compose, checked, commitHex, revealHex) {
  if (txidOf(commitHex) !== checked.commitTxid)
    throw new Error('The signed commit is not the transaction Core composed (its txid changed). Nothing was broadcast.')
  const tx = Transaction.fromRaw(hexToBytes(revealHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true })
  const core = coreRevealRaw(compose)
  if (tx.inputsLength !== 1 || tx.outputsLength !== core.outputs.length) throw new Error('The signed reveal does not match Core\'s. Nothing was broadcast.')
  const input = tx.getInput(0)
  if (bytesToHex(input.txid) !== checked.commitTxid || input.index !== 0) throw new Error('The signed reveal does not spend the commit. Nothing was broadcast.')
  core.outputs.forEach((o, i) => {
    const got = tx.getOutput(i)
    if (!sameBytes(got.script, o.script) || got.amount !== o.amount) throw new Error('The signed reveal\'s outputs differ from Core\'s. Nothing was broadcast.')
  })
  const witness = input.finalScriptWitness || []
  if (witness.length !== 3 || !sameBytes(witness[1], checked.leaf) || !sameBytes(witness[2], checked.controlBlock))
    throw new Error('The wallet did not sign the reveal through the envelope leaf. Nothing was broadcast.')
  checkRevealSourceSignature(checked.commitScript, checked.sourceScript, witness)
  const sig = witness[0]
  let hashType
  if (sig.length === 64) hashType = SigHash.DEFAULT
  else if (sig.length === 65 && sig[64] === SigHash.ALL) hashType = SigHash.ALL
  else throw new Error('The reveal signature is not SIGHASH_DEFAULT or SIGHASH_ALL. Nothing was broadcast.')
  const msg = tx.preimageWitnessV1(0, [checked.commitScript], hashType, [BigInt(checked.commitValue)], undefined, checked.leaf, LEAF_VERSION)
  if (!schnorr.verify(sig.subarray(0, 64), msg, checked.leafKey))
    throw new Error('The reveal signature does not verify against the source key. Nothing was broadcast.')
  return true
}

// ---------------------------------------------------------------------------
// plan: everything the page needs from a compose, before any signing
// ---------------------------------------------------------------------------
/** Run the preflight and build both PSBTs. Throws (nothing signed) if the reveal would be ignored. */
export function planMint(compose, sourceAddress, walletKeyHex, network) {
  const checked = preflightReveal(compose, sourceAddress, walletKeyHex, network)
  const weight = revealWeight(compose)
  if (weight > STANDARD_WITNESS_LIMIT_WU)
    throw new Error(`This reveal would be ${weight.toLocaleString('en-US')} weight units, past the ${STANDARD_WITNESS_LIMIT_WU.toLocaleString('en-US')} standard relay cap. Use a smaller file.`)
  const commitPsbt = buildPlainPsbt(compose)
  if (unsignedTxid(commitPsbt) !== checked.commitTxid) throw new Error('The commit PSBT does not hash to the commit Core composed. Nothing was signed.')
  return {
    checked, commitPsbt, revealPsbt: buildRevealPsbt(compose, checked),
    commitValue: checked.commitValue, commitTxid: checked.commitTxid,
    commitFee: compose.btc_fee, revealFee: checked.commitValue - revealOutputTotal(compose), revealWeight: weight,
    inputCount: compose.inputs_values.length,
  }
}

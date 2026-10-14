import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { p2tr, Script, TaprootControlBlock } from '@scure/btc-signer'
import { pubSchnorr, taprootTweakPrivKey } from '@scure/btc-signer/utils.js'
import {
  bytesToHex, checkRevealSourceSignature, finalize, hexToBytes, planMint, preflightReveal,
  RevealRuleError, verifySignedReveal,
} from '../src/mint.js'
import { envelope, fakeCompose, key, p2trSource, p2wpkhSource, walletSign } from './helpers.js'

const pepe = JSON.parse(readFileSync(new URL('./fixtures/pepemaxxer-reveal.json', import.meta.url)))
const ruleCode = (fn) => { try { fn() } catch (e) { if (e instanceof RevealRuleError) return e.code; throw e } return 'ok' }
const refuses = (fn, re) => assert.throws(fn, re)

// --- accepted -------------------------------------------------------------

test('accepts a Core-shaped reveal keyed to a P2WPKH source', () => {
  const src = p2wpkhSource(1)
  const compose = fakeCompose({ leaf: envelope(src.xOnly), internalKey: src.xOnly, sourceScript: src.script })
  const checked = preflightReveal(compose, src.address, bytesToHex(src.pub))
  assert.equal(bytesToHex(checked.leafKey), bytesToHex(src.xOnly))
})

test('accepts a P2TR source keyed by its BIP86 internal key', () => {
  const src = p2trSource(2)
  const compose = fakeCompose({ leaf: envelope(src.internal), internalKey: src.internal, sourceScript: src.script })
  preflightReveal(compose, src.address, bytesToHex(src.internal))
})

test('accepts a P2TR source keyed by its output key (Core\'s fallback)', () => {
  const src = p2trSource(3)
  const compose = fakeCompose({ leaf: envelope(src.outputKey), internalKey: src.outputKey, sourceScript: src.script })
  preflightReveal(compose, src.address, bytesToHex(src.outputKey))
})

test('a wallet-signed reveal verifies before broadcast (P2WPKH, P2TR internal, P2TR output key)', () => {
  const cases = [
    (() => { const s = p2wpkhSource(4); return { s, k: s.xOnly, wallet: bytesToHex(s.pub), priv: s.priv } })(),
    (() => { const s = p2trSource(5); return { s, k: s.internal, wallet: bytesToHex(s.internal), priv: s.priv } })(),
    (() => { const s = p2trSource(6); return { s, k: s.outputKey, wallet: bytesToHex(s.outputKey), priv: taprootTweakPrivKey(s.priv) } })(),
  ]
  for (const { s, k, wallet, priv } of cases) {
    const compose = fakeCompose({ leaf: envelope(k), internalKey: k, sourceScript: s.script })
    const plan = planMint(compose, s.address, wallet)
    const reveal = finalize(walletSign(plan.revealPsbt, priv))
    assert.equal(verifySignedReveal(compose, plan.checked, compose.rawtransaction, reveal.hex), true)
  }
})

// --- rejected -------------------------------------------------------------

test('rejects the PEPEMAXXER reveal (random leaf key under NUMS) — the on-chain negative fixture', () => {
  const witness = pepe.witness.map(hexToBytes)
  const code = ruleCode(() => checkRevealSourceSignature(hexToBytes(pepe.commitScript), hexToBytes(pepe.sourceScript), witness))
  assert.equal(code, 'SourceKeyMismatch')
  // and as a compose: the same leaf + control block refused before anything is signed
  const leaf = witness[1], cb = witness[2]
  const compose = fakeCompose({ leaf, internalKey: cb.subarray(1, 33), sourceScript: hexToBytes(pepe.sourceScript) })
  assert.equal(compose.reveal_control_block, bytesToHex(cb))
  assert.equal(compose.reveal_lock_scripts[0], pepe.commitScript)
  refuses(() => preflightReveal(compose, pepe.sourceAddress, bytesToHex(leaf.subarray(leaf.length - 33, leaf.length - 1))),
    /envelope key does not belong to the source address/)
})

test('rejects a random-key leaf for a P2WPKH source', () => {
  const src = p2wpkhSource(7), rnd = pubSchnorr(key(8))
  const compose = fakeCompose({ leaf: envelope(rnd), internalKey: rnd, sourceScript: src.script })
  refuses(() => preflightReveal(compose, src.address, bytesToHex(rnd)), /does not belong to the source/)
})

test('rejects non-canonical leaves', () => {
  const src = p2wpkhSource(9), k = src.xOnly, data = new TextEncoder().encode('msg')
  const bad = {
    'non-push inside': Script.encode([0, 'IF', data, 'DROP', 'ENDIF', k, 'CHECKSIG']),
    'OP_SUCCESS inside': Script.encode([0, 'IF', data, 'CAT', 'ENDIF', k, 'CHECKSIG']),
    'OP_RESERVED inside': new Uint8Array([0x00, 0x63, 0x50, 0x68, 0x20, ...k, 0xac]),
    'trailing opcode': Script.encode([0, 'IF', data, 'ENDIF', k, 'CHECKSIG', 'NOP']),
    'CHECKSIGVERIFY': Script.encode([0, 'IF', data, 'ENDIF', k, 'CHECKSIGVERIFY']),
    'no OP_FALSE': Script.encode(['IF', data, 'ENDIF', k, 'CHECKSIG']),
    'missing OP_ENDIF': Script.encode([0, 'IF', data, k, 'CHECKSIG']),
    '33-byte key': Script.encode([0, 'IF', data, 'ENDIF', src.pub, 'CHECKSIG']),
  }
  for (const [name, leaf] of Object.entries(bad)) {
    const compose = fakeCompose({ leaf, internalKey: k, sourceScript: src.script })
    refuses(() => preflightReveal(compose, src.address, bytesToHex(src.pub)), /canonical envelope|Counterparty would ignore/, name)
    assert.equal(ruleCode(() => checkRevealSourceSignature(hexToBytes(compose.reveal_lock_scripts[0]), src.script,
      [new Uint8Array(64), leaf, hexToBytes(compose.reveal_control_block)])), 'NotAnEnvelope', name)
  }
  // OP_1..OP_16 / OP_1NEGATE are pushes and allowed (ord-style tags)
  const pushnum = Script.encode([0, 'IF', data, 1, 16, 'ENDIF', k, 'CHECKSIG'])
  preflightReveal(fakeCompose({ leaf: pushnum, internalKey: k, sourceScript: src.script }), src.address, bytesToHex(src.pub))
})

test('rejects a wrong leaf version even when the control block commits to it', () => {
  const src = p2wpkhSource(10)
  const compose = fakeCompose({ leaf: envelope(src.xOnly), internalKey: src.xOnly, sourceScript: src.script, leafVersion: 0xc2 })
  refuses(() => preflightReveal(compose, src.address, bytesToHex(src.pub)), /unsupported taproot leaf version 0xc2/)
})

test('rejects a control block that does not rebuild the commit output', () => {
  const src = p2wpkhSource(11), leaf = envelope(src.xOnly)
  const base = fakeCompose({ leaf, internalKey: src.xOnly, sourceScript: src.script })
  const cb = TaprootControlBlock.decode(hexToBytes(base.reveal_control_block))
  const variants = {
    'other internal key': { ...cb, internalKey: pubSchnorr(key(12)) },
    'flipped parity': { ...cb, version: cb.version ^ 1 },
    'extra merkle node': { ...cb, merklePath: [new Uint8Array(32).fill(1)] },
  }
  for (const [name, v] of Object.entries(variants)) {
    const compose = { ...base, reveal_control_block: bytesToHex(TaprootControlBlock.encode(v)) }
    refuses(() => preflightReveal(compose, src.address, bytesToHex(src.pub)), /does not commit the leaf to the output key/, name)
  }
  // the right leaf under a commit output for a different leaf
  const other = p2tr(src.xOnly, { script: envelope(src.xOnly, new Uint8Array([1, 2, 3])) }, undefined, true)
  refuses(() => preflightReveal({ ...base, reveal_lock_scripts: [bytesToHex(other.script)] }, src.address, bytesToHex(src.pub)),
    /does not commit the leaf/)
  refuses(() => preflightReveal({ ...base, reveal_control_block: base.reveal_control_block.slice(0, 64) }, src.address, bytesToHex(src.pub)),
    /invalid taproot control block/)
})

test('rejects a leaf keyed to the source when the wallet reported a different key', () => {
  const src = p2trSource(13)
  const compose = fakeCompose({ leaf: envelope(src.outputKey), internalKey: src.outputKey, sourceScript: src.script })
  refuses(() => preflightReveal(compose, src.address, bytesToHex(src.internal)), /not closed by the key your wallet reported/)
})

test('rejects a reveal that does not spend commit output 0, or a commit that does not fund it', () => {
  const src = p2wpkhSource(14)
  const base = fakeCompose({ leaf: envelope(src.xOnly), internalKey: src.xOnly, sourceScript: src.script })
  refuses(() => preflightReveal({ ...base, reveal_inputs_values: [19_999] }, src.address, bytesToHex(src.pub)), /first output is not the one/)
  const r = hexToBytes(base.reveal_rawtransaction); r[5] ^= 1 // input txid byte
  refuses(() => preflightReveal({ ...base, reveal_rawtransaction: bytesToHex(r) }, src.address, bytesToHex(src.pub)), /does not spend the commit/)
})

test('rejects legacy and P2WSH sources, and a pre-11.5 compose', () => {
  const src = p2wpkhSource(15)
  const compose = fakeCompose({ leaf: envelope(src.xOnly), internalKey: src.xOnly, sourceScript: src.script })
  refuses(() => preflightReveal(compose, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', bytesToHex(src.pub)), /native segwit/)
  refuses(() => preflightReveal(compose, 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', bytesToHex(src.pub)), /native segwit/)
  const { reveal_control_block, ...old } = compose
  refuses(() => preflightReveal({ ...old, signed_reveal_rawtransaction: '00' }, src.address, bytesToHex(src.pub)), /v11\.5/)
})

test('refuses to broadcast a reveal whose signature does not verify, or a commit that changed', () => {
  const src = p2wpkhSource(16)
  const compose = fakeCompose({ leaf: envelope(src.xOnly), internalKey: src.xOnly, sourceScript: src.script })
  const plan = planMint(compose, src.address, bytesToHex(src.pub))
  const good = finalize(walletSign(plan.revealPsbt, src.priv)).hex
  const tampered = hexToBytes(good)
  // flip a byte of the 64-byte signature (witness[0]); it sits right after the witness count and 0x40 length
  const hex = bytesToHex(tampered), i = hex.lastIndexOf('0340') // 3 witness items, 64-byte sig
  assert.ok(i > 0)
  tampered[(i + 4) / 2] ^= 1
  refuses(() => verifySignedReveal(compose, plan.checked, compose.rawtransaction, bytesToHex(tampered)), /does not verify/)
  refuses(() => verifySignedReveal(compose, plan.checked, compose.rawtransaction.replace(/..$/, '01'), good), /txid changed/)
})

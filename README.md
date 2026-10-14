# Angel — Guardian Set

A tiny, personal mint for Angel. One page: connect a wallet, drop a file,
inscribe it on Bitcoin as a numbered Counter — a **native Counterparty** asset
whose description is your file, carried in Core's v11 taproot envelope and
numbered by the chain.

The mint is client-side. Counterparty Core composes the commit/reveal pair,
and the connected wallet signs **both** with the address's own key. There is
no mint backend; the only server piece is a proxy to a Counterparty node.

> **Counterparty v11.5 rule.** Since mainnet block 969,320
> (`require_reveal_source_signature`, GHSA-q27c-r246-f6qw) a taproot reveal is
> attributed to the commit's funder only if the source signed it. Otherwise it
> is ignored silently: no asset, no error, and the name stays free. Angel
> v0.9.x signed reveals with a page-held key, so its mainnet counters after
> that block issued nothing. v0.10 has the wallet sign them. The counter path
> stays **off on mainnet** (`TAPROOT_MINT_OFF` in `web/index.html`) until that
> has been checked with each wallet on mainnet.

## Where it runs

| | URL | What serves it |
| --- | --- | --- |
| **GitHub Pages** | `https://metaver5o.github.io/angel/` | `.github/workflows/pages.yml`, on every push to `main`. Reaches the Counterparty node through the staging tunnel; falls back to the public node. |
| **Staging stack** | `https://<random>.trycloudflare.com` (see `docker compose logs -f tunnel`) | Caddy serving `web/` and proxying `/cp/*` to your node. |

The header pill shows which node the page found: `mainnet · your node` (the
stack's) or `mainnet · public node` (api.counterparty.io, rate-limited).

The footer shows two versions:

- **`build vX.Y.Z · <sha>`** — baked into the page. `VERSION` is bumped by hand
  in `web/index.html`; the Pages workflow stamps the short commit SHA in at
  build time. If the SHA on the Pages URL matches your latest push, GitHub
  published it.
- **`server <sha> · up to date / behind`** — what the staging stack has checked
  out, from the deployer sidecar. "Behind" shows a **Deploy latest** button
  (needs `DEPLOY_TOKEN`).

## What you can mint

- **A counter** — drop a file. Numeric name (free) or a **named asset** (4–12
  uppercase letters not starting with A; Core burns 0.5 XCP). Supply and
  divisibility are yours to set; the default is 1, indivisible, and **supply
  locked** (the lock is permanent — untick *Lock supply* to leave it open).
  Counters need a **segwit address** (`bc1q…`/`bc1p…`): Counterparty refuses
  the taproot envelope from a legacy `1…` source. Plain issuances work from
  any address.
- **A subasset** — pick *Subasset* in the Asset step, choose the parent from
  the list of your top-level assets (named or numeric),
  and type the part after the dot (letters, digits, `. - _ @ !`, case kept).
  Burns 0.25 XCP. Only the parent's owner can issue it, which is why the
  parent is picked rather than typed; typing `PARENT.name` still works.
- **A plain asset, no counter** — tick *Without counter* in the Asset step
  (the file step disappears). Same name/supply options;
  one ordinary Counterparty issuance, signed by the wallet and relayed.
- **A reinscription** — *Reinscribe an asset you own*: pick one of the
  connected address's assets from the list (named, numeric or subasset) and
  drop the new file. Composed as a reissuance with
  quantity 0 and the asset's own divisibility, so supply and locks are
  untouched; no XCP. Same commit/reveal path as a counter.

Any name you type is looked up on Counterparty and the page shows what the
connected address can do with it: whether you own it, whether its supply and
description are locked, whether it can be reinscribed or have supply added,
and for a subasset whether you own the parent. A named asset that already
exists is only offered as a reissue to its owner (no XCP burn); anything
else is blocked before composing.

Fees default to a custom **0.3 sat/vB** (your own node must relay that low;
public nodes generally want ≥ 1). Economy/Standard/Fast come from mempool.space.
An estimate of the commit and reveal fees updates as you change the file and
rate; the exact figures from Core replace it once composed.

## How a counter mint works

1. **Compose.** The page lists the address's coins (mempool.space), drops any at
   or under 1,000 sats or carrying an attached asset balance, and asks Core to
   compose an `issuance` with `encoding=taproot`, `inscription=false`, the file
   as `description` and those coins as `inputs_set`. It also sends the
   wallet's public key as `multisig_pubkey`, so Core closes the envelope with
   that key. Core returns the unsigned commit, the
   envelope script, the control block and the unsigned reveal.
2. **Preflight** (`preflightReveal` in `src/mint.js`, a port of Core's
   `counterparty-rs/src/reveal.rs`). Before anything is signed, the page checks:
   - the leaf is exactly `OP_FALSE OP_IF <pushes> OP_ENDIF <32-byte key> OP_CHECKSIG`;
   - its key is a key of the source address (a P2WPKH address's pubkey, or a
     P2TR address's output key or BIP86 internal key) and is the key the wallet reported;
   - the control block is leaf version `0xc0` and, with the leaf hash, rebuilds
     the commit output;
   - that output is commit output 0, and the reveal spends it alone.
   If any check fails, nothing is signed.
3. **Sign both.** The commit is Core's transaction as a PSBT, with full prevouts
   and `SIGHASH_ALL`. The reveal is a PSBT whose single input is a tapscript spend
   of commit output 0: witness UTXO = that output, `PSBT_IN_TAP_LEAF_SCRIPT` =
   Core's envelope and control block. The wallet signs the reveal with the
   source key (BIP342 script path, `SIGHASH_DEFAULT`).
4. **Verify, save, broadcast.** The page checks that the finalized reveal's
   witness is `<signature> <envelope> <control block>` and that the signature
   verifies against the leaf key over the reveal's sighash. Only then are both
   signed transactions saved to `localStorage`, the commit relayed, and then the
   reveal. An interrupted mint shows an "Unfinished mint" box whose **Finish
   reveal** re-sends them. No key is ever held by the page.

Limits: a reveal over 400,000 weight units (a file of roughly 390 KB) will not
relay on the public network, so it is refused before anything is signed.

## Wallets

The two Counterparty browser wallets:

| Wallet | Global | Pubkey | Commit + reveal |
| --- | --- | --- | --- |
| XCP Wallet | `window.xcpwallet` | `xcp_getAddresses` → `active.publicKey` | one approval: `xcp_signPsbts` with a `commit-and-reveal` bundle (needs `commit-and-reveal` in `signing.psbtBatch.marketplaceBundles`: a software wallet on a bc1q/bc1p address, Counterparty API v11.5+; hardware wallets are blocked) |
| Horizon | `window.HorizonWalletProvider` | `getAddresses` → `publicKey` | two approvals: `signPsbt` for each. Horizon signs with bitcoinjs-lib `signInput`, which gives a script-path signature when the signer's key is in the leaf |

A wallet that cannot sign the reveal is refused before compose, with the reason.

On connect the page shows the address, the **BTC balance** (mempool.space,
confirmed + unconfirmed) and the **XCP balance** (Counterparty API).

## Activity and error logs

The page reports what visitors do and everything that fails to the stack's
deployer sidecar, which appends one JSON line per event to `logs/events.jsonl`
(gitignored) and echoes it to its own stdout:

```bash
tail -f logs/events.jsonl                 # on the host
docker compose logs -f deployer           # same stream
docker compose logs -f proxy              # every HTTP request, as JSON (Caddy)
```

Events: `page_view` (network, which node), `wallet_connected` /
`wallet_disconnected`, `file_chosen`, `mint_start`, `composed` (fees),
`commit_signed`, `commit_broadcast`, `issuance_signed`, `mint_done`,
`pending_resume` / `pending_discarded`, `deploy_clicked`, `balance_unavailable`,
`broadcast_failed`, and **`error`** — from the wallet (connect, signing
refusals), Counterparty (compose, lookups), relays, the deployer itself
(`deployer_error`), and any uncaught JS exception or rejected promise. Each
carries the build, a per-tab session id, the wallet kind and address.

Over HTTP: `GET /__events?n=200` (needs `X-Deploy-Token`) for everything, and
`GET /__errors?since=<unix ts>` (no token; errors only, with IP, address and
user agent stripped) for a watcher that just wants failures.

## Run the staging stack (Docker)

```bash
cp .env.example .env          # CP_UPSTREAM = your Counterparty Core v2 API, DEPLOY_TOKEN
docker compose up -d
docker compose logs -f tunnel # -> https://something-random.trycloudflare.com
```

Services (`docker-compose.yml`):

- **proxy** — Caddy. Serves `web/` as the site (`Cache-Control: no-store`),
  proxies `/cp/*` to `CP_UPSTREAM` (only the routes the mint needs: API root,
  `compose/issuance`, balances, `bitcoin/transactions`) with CORS so the Pages
  copy can use it, and `/__version` + `/__deploy` to the deployer.
- **deployer** — polls `origin/main` every 60 s and `git reset --hard`s the
  checkout, so a push republishes the page with no rebuild. Also serves
  `/__version` and `/__deploy` for the footer.
- **tunnel** — cloudflared quick tunnel (no account). New random hostname on
  every restart; for a stable one, set `TUNNEL_TOKEN` and switch to a named
  tunnel (comment in the compose file). The Pages copy has the current
  hostname hardcoded as `TUNNEL_BACKEND` in `web/index.html` — update it when
  the tunnel restarts.

Your node needs Counterparty Core **v11.5+** (it returns the unsigned reveal the wallet signs) with its
bitcoind, on the network you want to mint on; the page reads the network from
the node. Note the deployer hard-resets the checkout: don't develop in the
clone the stack runs from.

## Hacking on it

The page is `web/index.html` (no build). The PSBT code is `src/mint.js`,
bundled with `@scure/btc-signer` into `web/mint.js`, which is committed so
Pages and the stack serve it as-is:

```bash
npm install
npm run build        # src/mint.js -> web/mint.js
npm test             # preflight unit tests (node --test)
```

End to end against a Counterparty Core v11.5 regtest node (the rule is active
from block 0), minting from P2WPKH and P2TR sources with each wallet's signing
library, plus a pre-0.10 reveal the node must ignore:

```bash
CP=http://localhost:24000/v2 BTC_CLI="bitcoin-cli -regtest" node scripts/regtest-e2e.js
```

**Don't develop in the clone the stack runs from.** The deployer resets it to
`origin/main` every 60 s and the proxy serves its `web/` live. Use a separate
`git worktree`.

To point the page at a different stack: `web/index.html?backend=https://host`.

## Notes

- **Assets are numeric** (free — just BTC fees). No XCP, no naming, no decisions
  to make. Just mint.
- The wallet pays two fees: the commit's (Core's estimate at the chosen rate)
  and the reveal's (carried in the commit output). Both are shown once composed.

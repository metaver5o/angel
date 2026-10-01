# Angel — Guardian Set

A tiny, personal mint for Angel. One page: connect a wallet, drop a file,
inscribe it on Bitcoin as a numbered Counter (your file in witness data, owned
through a Counterparty asset, numbered by the chain from zero).

It's a thin front end over the real [`counters-mint`](../counters-mint) backend
— the same commit/reveal PSBT flow as counters.fun, nothing reimplemented. The
whole UI is one self-contained `web/index.html` (no build step).

## Where it runs

| | URL | What serves it |
| --- | --- | --- |
| **GitHub Pages** | `https://metaver5o.github.io/angel/` | `.github/workflows/pages.yml`, on every push to `main`. Page only; it calls the backend through the tunnel. |
| **Staging stack** | `https://<random>.trycloudflare.com` (see `docker compose logs -f tunnel`) | The Docker stack below: backend + page on one origin. |

The footer shows two versions:

- **`build vX.Y.Z · <sha>`** — baked into the page. `VERSION` is bumped by hand
  in `web/index.html`; the Pages workflow stamps the short commit SHA in at
  build time. If the SHA on the Pages URL matches your latest push, GitHub
  published it.
- **`server <sha> · up to date / behind`** — what the staging stack has checked
  out, from the deployer sidecar. "Behind" shows a **Deploy latest** button
  (needs `DEPLOY_TOKEN`).

## Wallets

Connect first (step 1). The page lists each wallet as ready or not installed:

| Wallet | Connect + balances | Mint |
| --- | --- | --- |
| XCP Wallet (`window.xcpwallet`) | ✅ | ⛔ not yet (see below) |
| Unisat | ✅ | ✅ |
| OKX | ✅ | ✅ |
| Horizon (`window.HorizonWalletProvider`) | ✅ | ⛔ not yet |

On connect the page shows the address, the **BTC balance** (mempool.space,
confirmed + unconfirmed) and the **XCP balance** (public Counterparty Core API
at `api.counterparty.io`, read straight from the browser).

**Why XCP Wallet and Horizon can't mint yet:** they only sign PSBTs — there is
no "send BTC to this address" call — and XCP Wallet refuses to sign BTC movement
it can't verify. The current backend flow has the wallet pay the commit
directly, then sign a server-built reveal. Minting through them needs the
backend to return a commit PSBT (signed with `xcp_signBitcoinPsbt` + a payment
intent) and a reveal the wallet will accept. That's a `counters-mint` change.

## Run the staging stack (Docker)

```bash
cp .env.example .env          # BTC_RPC_* / CP_API_URL for your node, DEPLOY_TOKEN
docker compose up -d --build
docker compose logs -f tunnel # -> https://something-random.trycloudflare.com
```

Services (`docker-compose.yml`):

- **app** — `counters-mint` server with `web/` mounted over its static dir, so
  the mint page is the site root.
- **deployer** — polls `origin/main` every 60 s and `git reset --hard`s the
  checkout, so a push republishes the page with no rebuild. Also serves
  `/__version` and `/__deploy` for the footer.
- **proxy** — Caddy; routes `/__version` + `/__deploy` to the deployer, the rest
  to the app, so one tunnel serves one origin.
- **tunnel** — cloudflared quick tunnel (no account). New random hostname on
  every restart; for a stable one, set `TUNNEL_TOKEN` and switch to a named
  tunnel (comment in the compose file).

Note the deployer hard-resets the checkout: don't develop in the clone the
stack runs from.

## Run the page without Docker

The page is static and talks to any running `counters-mint` server:

```bash
# in counters-mint/
counters-proto server --no-index --port 8082
```

Open `web/index.html` and point it at the backend:

```
web/index.html?backend=http://127.0.0.1:8082
```

Without `?backend=`, the page uses its own origin, except on `github.io` (and
`file://`), where it uses the tunnel URL hardcoded as `TUNNEL_BACKEND` in
`web/index.html` — update that when the tunnel restarts.

## Notes

- **Assets are numeric** (free — just BTC fees). No XCP, no naming, no decisions
  to make. Just mint.
- **Network** (mainnet/testnet4/signet) comes from the backend's `BTC_NETWORK`;
  the UI labels it and picks the right wallet provider + explorer automatically.
- `deploy.sh` is the older cron-based pull-and-rebuild script; the deployer
  sidecar replaces it.

# Angel — Guardian Set

A tiny, personal mint for Angel. One page: drop a file, connect a wallet,
inscribe it on Bitcoin as a numbered Counter (your file in witness data, owned
through a Counterparty asset, numbered by the chain from zero).

It's a thin front end over the real [`counters-mint`](../counters-mint) backend
— the same commit/reveal PSBT flow as counters.fun, nothing reimplemented. The
whole UI is one self-contained `index.html` (no build step).

## Run it (Docker)

```bash
cp .env.example .env          # point BTC_RPC_* / CP_API_URL at your node
docker compose up --build
```

- Local: http://localhost — well, the backend listens inside the stack; reach
  it through the tunnel, or add a `ports:` mapping to `app` if you want it on
  localhost too.
- Public staging URL (share this): it's a Cloudflare **quick tunnel**, no
  account needed. Grab it from the logs:

  ```bash
  docker compose logs -f tunnel
  # -> https://something-random.trycloudflare.com
  ```

Open that URL, connect Unisat / OKX / Horizon, drop a file, mint.

## Run it (no Docker)

The page is static and talks to any running `counters-mint` server:

```bash
# in counters-mint/
counters-proto server --no-index --port 8082
```

Then either drop this `index.html` into `counters_proto/server/static/`, or open
it from anywhere and point it at the backend:

```
index.html?backend=http://127.0.0.1:8082
```

(The backend sends `Access-Control-Allow-Origin: *`, so cross-origin works.)

## Notes

- **Wallets:** Unisat, OKX, Horizon. Xverse's commit-funding path isn't wired in
  the backend yet, so it's omitted.
- **Assets are numeric** (free — just BTC fees). No XCP, no naming, no decisions
  to make. Just mint.
- **Network** (mainnet/testnet4/signet) comes from the backend's `BTC_NETWORK`;
  the UI labels it and picks the right wallet provider + explorer automatically.
- **Stable public URL:** quick tunnels get a new random hostname each start. For
  a fixed URL on your own domain, create a named Cloudflare tunnel, put its
  token in `.env` as `TUNNEL_TOKEN`, and switch the `tunnel` command (see the
  comment in `docker-compose.yml`).

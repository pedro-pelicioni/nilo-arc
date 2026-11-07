# Deploy

Nilo on Arc is one Docker image: the Hono server answers `/api`, serves the web app and runs the scheduled agent.
CI builds it on every push to `main` as `ghcr.io/<owner>/nilo-arc:latest`, for Arc Testnet by default (set the
repository variable `ARC_NETWORK=mainnet` for a mainnet bundle). To build it yourself:

```bash
docker build -t nilo-arc .                                         # Arc Testnet
docker build -t nilo-arc --build-arg VITE_ARC_NETWORK=mainnet .    # Arc mainnet
```

## Environment

```bash
ARC_NETWORK=testnet       # must match the bundle
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
NILO_OPERATOR_KEY=0x...   # the operator in packages/core/src/config.ts; the server refuses any other
```

The operator key can only call `NiloAgent.invest` (inside each user's mandate) and relay gasless claims. Keep a
few USDC on it for gas.

## Run

```bash
docker run -d --name nilo-arc --restart unless-stopped -p 5173:5173 \
  --env-file nilo-arc.env -v nilo-arc-data:/app/data nilo-arc
```

`/app/data` keeps the agent's activity log and the list of wallets it watches. Serve it over HTTPS behind any
reverse proxy.

`GET /health` (and `GET /healthz`) answers `{ "ok": true }` from memory. It does not read Arc, Coinbase, or the
disk. On Render, set the HTTP health check path to `/health`. The probe fails when the process does not answer
within 5 seconds; a path that waits on `eth_getLogs` or a disk stat will time out while the process is still up.
The default TCP check only proves the port accepts a connection.

The public demo runs on Render (free web service, Docker runtime, built from this repository, the environment
above). Render sets `PORT` itself and the server listens on it. Hosts that build from a Dockerfile (Render, Railway, Fly.io) work too: point them at this
repository, set the environment above and expose port 5173. The agent runs on a timer inside the server, so the
host must keep it running rather than scale it to zero.

## Mainnet

Fill the mainnet addresses in [`packages/core/src/config.ts`](../packages/core/src/config.ts), build with
`VITE_ARC_NETWORK=mainnet` and run with `ARC_NETWORK=mainnet`.

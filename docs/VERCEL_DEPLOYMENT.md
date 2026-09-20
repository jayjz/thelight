# Vercel web deployment

Vercel hosts the LIGHTLIGHT web boundary only: the UI, TanStack Start SSR and
server functions, static assets, and read-only Neon-backed views where the web
application uses them. Nitro already targets Vercel through the Vite
configuration; no `vercel.json` is required.

## Separation of authority

The Alpaca PAPER worker is a separate, session-owned process on an always-on
worker host. It alone owns the persistent market-data and `trade_updates`
WebSocket connections, reconciliation loop, and broker submission authority.
Start it explicitly on that host with `npm run alpaca:worker -- start`.

Vercel must never run that command and must not be configured with Alpaca
credentials. The worker factory also fails closed when `VERCEL=1`, before it
loads Alpaca configuration, opens database-backed worker state, or connects a
stream. The UI runtime-status function is observational: when no local worker
exists it reports that the operator has not started one; it cannot create one.

Both deployments may point at the same durable Neon database. That enables
future read-only runtime/evidence views without moving worker authority into a
request lifecycle.

## Environment matrix

| Variable | Vercel web app | Always-on worker host | Browser bundle |
| --- | --- | --- | --- |
| `DATABASE_URL` | Set only when web server functions need Neon-backed reads; optional for builds | Required for durable worker authority | Never exposed |
| `LIGHTLIGHT_MODE` | Omit (defaults to replay) or set `PAPER_REPLAY` | `ALPACA_PAPER` for the operator-run worker | Never expose as a `VITE_*` value |
| `ALPACA_API_KEY_ID` | Do not set | Required | Never exposed |
| `ALPACA_API_SECRET_KEY` | Do not set | Required | Never exposed |
| `ALPACA_PAPER_BASE_URL` | Do not set | Fixed PAPER URL only | Never exposed |
| `ALPACA_DATA_BASE_URL`, `ALPACA_DATA_FEED`, `ALPACA_SYMBOL` | Do not set | Worker runtime configuration | Never exposed |

Only deliberately public, non-sensitive values with a `VITE_` prefix can enter
the browser build. No Alpaca variable and no database URL may use that prefix.

## Deploy procedure

1. Configure the Vercel project to use the repository's existing `npm run build`
   build command. The build runs Nitro's Vercel preset and then the idempotent
   migrator.
2. Set `DATABASE_URL` only if the web deployment needs Neon access. With no
   database URL, the migration command prints a skip message and succeeds.
3. Do not add worker variables or a worker start command to Vercel.
4. Deploy and validate the preview before promotion. Confirm the root page and
   assets load, server functions return normally, and the runtime status does
   not start a worker.

Generated `.vercel/output` is a local build artifact and remains ignored.

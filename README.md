# TonForecast

TonForecast is a Telegram Mini App on TON for short-term, onchain prediction markets.

Live demo:

- Web: [https://ton.uxuialex.com](https://ton.uxuialex.com)
- Telegram entry: [https://t.me/chatchatgpt_bot/TON_Forecast](https://t.me/chatchatgpt_bot/TON_Forecast)

## What This Repository Contains

The production app is split into four practical parts:

- [apps/miniapp](apps/miniapp): Telegram Mini App frontend, TON Connect bootstrap, market and profile UI
- [apps/api](apps/api): backend read model, action intents, price snapshots, runtime registry, auto-resolver bootstrap
- [contracts](contracts): Tolk market contract and contract spec
- [scripts](scripts): manual create, bet, resolve, claim, and auto-resolve scripts

The main files to read first are:

- [apps/miniapp/app.js](apps/miniapp/app.js)
- [apps/api/src/server.js](apps/api/src/server.js)
- [apps/api/src/lib/marketActions.js](apps/api/src/lib/marketActions.js)
- [apps/api/src/lib/marketReadModel.js](apps/api/src/lib/marketReadModel.js)
- [apps/api/src/lib/stonApi.js](apps/api/src/lib/stonApi.js)
- [contracts/ton_forecast_market.tolk](contracts/ton_forecast_market.tolk)
- [packages/shared/src/market.js](packages/shared/src/market.js)

## Product Rules

- One active market per `asset + duration`
- Current UI creates `above` markets only
- Supported durations are `5 min`, `15 min`, `30 min`, `60 min`, `1 day`, `3 days`, `1 week`, `1 month`
- Supported assets are `TON`, `STON`, `tsTON`, `UTYA`, `MAJOR`, `REDO`
- `TON` price uses CoinMarketCap with STON fallback
- Ecosystem tokens use STON.fi
- Markets resolve automatically after `resolveAt`
- Claim is available only after `RESOLVED_*`
- Exact threshold hit resolves to `DRAW`
- Protocol fee is `2%` of winnings

## Price And Settlement Sources

- TON quote source: [apps/api/src/lib/stonApi.js](apps/api/src/lib/stonApi.js)
- Script-side quote source: [scripts/lib/ston.ts](scripts/lib/ston.ts)
- Market status and payout formatting: [packages/shared/src/market.js](packages/shared/src/market.js)
- Contract payout logic: [contracts/ton_forecast_market.tolk](contracts/ton_forecast_market.tolk)

## Repository Layout

```text
apps/
  api/            Backend API, runtime registry, icons, resolver bootstrap
  miniapp/        Telegram Mini App frontend
  resolver/       Legacy notes and standalone resolver package docs
contracts/        Tolk contract and contract-level spec
docs/             Architecture, deployment, self-hosting notes
infra/            Nginx config for the Mini App container
packages/shared/  Shared market formatting and payout view logic
scripts/          Manual and automatic market operation scripts
wrappers/         Blueprint wrapper and compile entry
tests/            Contract tests
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Local Env

```bash
cp .env.example .env.local
```

Fill the values described in [docs/self-hosting.md](docs/self-hosting.md).

### 3. Start The Stack

```bash
docker compose up -d --build
```

This starts:

- `miniapp` on `http://127.0.0.1:3010`
- `api` behind `http://127.0.0.1:3010/api/*`

Useful checks:

```bash
curl http://127.0.0.1:3010/api/prices
curl "http://127.0.0.1:3010/api/markets?status=OPEN"
curl "http://127.0.0.1:3010/api/positions?userAddress=0:..."
```

## Make It Your Own

If you are forking this repo and launching your own version, start here:

1. Read [docs/self-hosting.md](docs/self-hosting.md).
2. Update [apps/miniapp/tonconnect-manifest.json](apps/miniapp/tonconnect-manifest.json) to your domain.
3. Update `TWA_RETURN_URL` in [apps/miniapp/app.js](apps/miniapp/app.js) to your Telegram bot Mini App link.
4. Put your own runtime secrets into `.env.local` on the server.
5. Configure GitHub Actions secrets for [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
6. Point your Telegram bot Web App button to your public HTTPS URL.

Important: this repository does not include Telegram bot code. Any bot that opens your Mini App URL will work.

## Runtime Files You Will Touch Most Often

- Market create / bet / claim intents: [apps/api/src/lib/marketActions.js](apps/api/src/lib/marketActions.js)
- Market list / positions read model: [apps/api/src/lib/marketReadModel.js](apps/api/src/lib/marketReadModel.js)
- Auto-resolver bootstrap: [apps/api/src/lib/resolverAutomation.js](apps/api/src/lib/resolverAutomation.js)
- TON RPC and resolver wallet env loading: [apps/api/src/lib/runtimeEnv.js](apps/api/src/lib/runtimeEnv.js)
- Token icon registry: [apps/api/src/lib/assets.js](apps/api/src/lib/assets.js)
- Frontend wallet bootstrap and panels: [apps/miniapp/app.js](apps/miniapp/app.js)
- Frontend shell HTML: [apps/miniapp/index.html](apps/miniapp/index.html)
- Reverse proxy config inside compose: [infra/nginx/miniapp.conf](infra/nginx/miniapp.conf)
- Deploy workflow: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)

## Manual Scripts

Useful script entry points:

- Auto-resolve one market: `MARKET_ADDRESS=EQ... npm run resolver:auto`
- Deploy contract via Blueprint: `npx blueprint run deployTonForecastMarket`
- Create a market manually: `npx blueprint run createTonForecastMarket`
- Place a bet manually: `npx blueprint run betTonForecastMarket`
- Claim manually: `npx blueprint run claimTonForecastMarket`
- Inspect a market: `npx ts-node scripts/getTonForecastMarket.ts EQ...`
- Inspect a position: `npx ts-node scripts/getTonForecastPosition.ts EQ... 0:...`

## Documentation

- Self-hosting and customization: [docs/self-hosting.md](docs/self-hosting.md)
- VPS and CI deploy flow: [docs/deployment.md](docs/deployment.md)
- Runtime architecture: [docs/architecture.md](docs/architecture.md)
- Contract behavior: [contracts/spec.md](contracts/spec.md)

## Notes Before Making The Repo Public

Current repo state is safe for public source:

- `.env`, `.env.local`, and runtime JSON are ignored
- GitHub workflow reads deploy credentials only from GitHub Secrets
- Token icons are local assets under [apps/api/public/asset-icons](apps/api/public/asset-icons)

Even so, rotate any keys that were ever pasted into chat or shell history.

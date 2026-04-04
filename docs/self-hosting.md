# Self-Hosting And Custom Setup

This document is for anyone who wants to fork TonForecast and run their own version.

## 1. What You Need Outside The Repository

You need six external pieces:

1. A public HTTPS domain for the Mini App
2. A Telegram bot that opens that domain as a Web App
3. A dedicated TON wallet for the resolver
4. A treasury wallet address for protocol fees
5. A TON JSON-RPC endpoint
6. A CoinMarketCap API key if you want TON pricing from CMC

The repository gives you the app, API, contract, scripts, and deploy workflow. It does not include a Telegram bot backend.

## 2. Which Files Matter In A Fork

These are the files you will almost always edit first:

- [apps/miniapp/tonconnect-manifest.json](../apps/miniapp/tonconnect-manifest.json)
  What to change:
  - `url`
  - `iconUrl`

- [apps/miniapp/app.js](../apps/miniapp/app.js)
  What to change:
  - `TWA_RETURN_URL`
  - optional UI copy, polling behavior, supported asset picker behavior

- [apps/api/src/lib/assets.js](../apps/api/src/lib/assets.js)
  What to change:
  - which icon file each token uses
  - icon cache version

- [packages/shared/src/market.js](../packages/shared/src/market.js)
  What to change:
  - supported assets
  - formatting
  - payout and status view logic

- [apps/api/src/lib/marketActions.js](../apps/api/src/lib/marketActions.js)
  What to change:
  - allowed durations
  - create-market defaults
  - create / bet / claim preflight behavior

- [apps/api/src/lib/stonApi.js](../apps/api/src/lib/stonApi.js)
  What to change:
  - price source logic
  - TON CMC fallback behavior

- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
  What to configure:
  - GitHub Secrets only
  - you usually do not need to edit the workflow file itself

## 3. Environment Variables

Copy [`.env.example`](../.env.example) to `.env.local` and fill it.

| Variable | Required | Used in | What it does | Where to get it |
| --- | --- | --- | --- | --- |
| `RESOLVER_MNEMONIC` | Yes | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js), [scripts/autoResolveTonForecastMarket.ts](../scripts/autoResolveTonForecastMarket.ts) | 24-word seed phrase for the resolver wallet | Create a dedicated TON wallet in Tonkeeper or another TON wallet app and export its seed phrase |
| `RESOLVER_WALLET_VERSION` | Yes | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Wallet contract version used to derive the resolver wallet | Use `v5r1` for Tonkeeper-created wallets |
| `TREASURY_ADDRESS` | Recommended | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js), [apps/api/src/lib/marketActions.js](../apps/api/src/lib/marketActions.js), [contracts/ton_forecast_market.tolk](../contracts/ton_forecast_market.tolk) | Fee receiver for newly created markets. If omitted, new markets fall back to the resolver wallet for backward compatibility. | Any TON wallet address you control for fee collection |
| `TON_API_ENDPOINT` | Yes | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Primary TON JSON-RPC endpoint for onchain reads | Toncenter or another TON RPC provider |
| `TON_API_KEY` or `TONCENTER_API_KEY` | Recommended | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Higher rate limits on TON RPC | Your TON RPC provider dashboard |
| `TON_API_ENDPOINTS` | Recommended | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Comma-separated TON RPC failover pool | Toncenter plus one or more backup providers |
| `TON_API_KEYS` | Optional | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Comma-separated API keys aligned with `TON_API_ENDPOINTS` | Your TON RPC provider dashboards |
| `TON_RPC_FAILURE_THRESHOLD` | Optional | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Retryable failures allowed before a provider is cooled down | Usually keep the default |
| `TON_RPC_COOLDOWN_MS` | Optional | [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | How long a failed RPC provider stays out of rotation | Usually keep the default |
| `CMC_API_KEY` | Recommended | [apps/api/src/lib/stonApi.js](../apps/api/src/lib/stonApi.js), [scripts/lib/ston.ts](../scripts/lib/ston.ts) | TON quote source via CoinMarketCap | CoinMarketCap API account |
| `RESOLVER_POLL_INTERVAL_MS` | Optional | [scripts/autoResolveTonForecastMarket.ts](../scripts/autoResolveTonForecastMarket.ts) | How often the resolver script polls when waiting | Usually keep the default |
| `ADMIN_TOKEN` | Recommended | [apps/api/src/server.js](../apps/api/src/server.js), [apps/miniapp/app.js](../apps/miniapp/app.js) | Secret required for admin actions | Generate a long random secret on the server |
| `ADMIN_ALLOWED_WALLETS` | Recommended | [apps/api/src/server.js](../apps/api/src/server.js), [apps/api/src/lib/runtimeEnv.js](../apps/api/src/lib/runtimeEnv.js) | Comma-separated wallet allowlist for admin mode visibility | Wallet addresses you control |
| `RUNTIME_BACKUP_RETENTION_COUNT` | Optional | [apps/api/src/lib/marketRegistry.js](../apps/api/src/lib/marketRegistry.js) | Maximum number of runtime backups kept on disk | Usually keep the default |
| `RUNTIME_BACKUP_RETENTION_DAYS` | Optional | [apps/api/src/lib/marketRegistry.js](../apps/api/src/lib/marketRegistry.js) | Maximum age of runtime backups kept on disk | Usually keep the default |
| `RUNTIME_AUDIT_RETENTION_COUNT` | Optional | [apps/api/src/lib/marketRegistry.js](../apps/api/src/lib/marketRegistry.js) | Maximum number of admin audit entries to keep | Usually keep the default |
| `RUNTIME_AUDIT_RETENTION_DAYS` | Optional | [apps/api/src/lib/marketRegistry.js](../apps/api/src/lib/marketRegistry.js) | Maximum age of admin audit entries | Usually keep the default |
| `RATE_LIMIT_POSITIONS_LIMIT` | Optional | [apps/api/src/lib/rateLimiter.js](../apps/api/src/lib/rateLimiter.js), [apps/api/src/server.js](../apps/api/src/server.js) | Requests per minute for `/api/positions` per client/user key | Usually keep the default |
| `RATE_LIMIT_ACTION_WRITE_LIMIT` | Optional | [apps/api/src/lib/rateLimiter.js](../apps/api/src/lib/rateLimiter.js), [apps/api/src/server.js](../apps/api/src/server.js) | Requests per minute for create/bet/claim-style write intents | Usually keep the default |

Operational note:

- The resolver wallet needs a small TON balance because it sends `resolve_market` transactions.
- With `TREASURY_ADDRESS` configured, protocol fees go to treasury instead of the resolver wallet.
- Runtime storage now uses `better-sqlite3` instead of the experimental `node:sqlite` module.

## 4. Local Run

Install dependencies:

```bash
npm install
```

Create local env:

```bash
cp .env.example .env.local
```

Start the stack:

```bash
docker compose up -d --build
```

What starts:

- [apps/api/src/index.js](../apps/api/src/index.js) inside the `api` container
- [apps/miniapp](../apps/miniapp) through [infra/nginx/miniapp.conf](../infra/nginx/miniapp.conf) inside the `miniapp` container

Useful checks:

```bash
curl http://127.0.0.1:3010/api/prices
curl "http://127.0.0.1:3010/api/markets?status=OPEN"
curl "http://127.0.0.1:3010/api/my-markets?userAddress=0:..."
curl http://127.0.0.1:3010/api/runtime/health
curl http://127.0.0.1:3010/tonconnect-manifest.json
npm run test:product
```

## 5. How To Point The Mini App At Your Own Domain

### TonConnect Manifest

Update [apps/miniapp/tonconnect-manifest.json](../apps/miniapp/tonconnect-manifest.json):

```json
{
  "url": "https://app.your-domain.com",
  "name": "TonForecast",
  "iconUrl": "https://app.your-domain.com/ton-symbol.png"
}
```

### Telegram Return URL

Update `TWA_RETURN_URL` in [apps/miniapp/app.js](../apps/miniapp/app.js):

```js
const TWA_RETURN_URL = "https://t.me/your_bot/your_start_param";
```

This is the URL TonConnect uses to return the user back into your Telegram Mini App.

## 6. How To Replace Branding, Icons, And Supported Assets

### Token Icons

Current icon files live in [apps/api/public/asset-icons](../apps/api/public/asset-icons).

The mapping from token symbol to icon file is in [apps/api/src/lib/assets.js](../apps/api/src/lib/assets.js).

If you replace an icon:

1. drop the new file into `apps/api/public/asset-icons`
2. update the file name and MIME type in `assets.js`
3. bump the icon cache version in:
   - [apps/api/src/lib/assets.js](../apps/api/src/lib/assets.js)
   - [apps/miniapp/app.js](../apps/miniapp/app.js)

### Supported Assets

The curated asset list is currently in [packages/shared/src/market.js](../packages/shared/src/market.js).

If you add or remove an asset, also review:

- [apps/api/src/lib/marketActions.js](../apps/api/src/lib/marketActions.js)
- [apps/api/src/lib/stonApi.js](../apps/api/src/lib/stonApi.js)
- [apps/miniapp/index.html](../apps/miniapp/index.html)
- [apps/miniapp/app.js](../apps/miniapp/app.js)

## 7. VPS Deploy

This repository already ships the practical deploy path used by the demo.

Relevant files:

- [docker-compose.yml](../docker-compose.yml)
- [infra/nginx/miniapp.conf](../infra/nginx/miniapp.conf)
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)

### Server Setup

The expected server layout is:

```text
/opt/ton-forecast/
  docker-compose.yml
  .env.local
  apps/
  contracts/
  infra/
```

The built-in compose stack exposes the Mini App on:

```text
127.0.0.1:3010
```

You still need an outer reverse proxy or panel on the VPS that serves your public domain and forwards it to `127.0.0.1:3010`.

### GitHub Secrets

Set these repository secrets for [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`

`DEPLOY_PATH` should usually be `/opt/ton-forecast`.

### First Deploy

On the server:

```bash
git clone https://github.com/your-org/your-fork.git /opt/ton-forecast
cd /opt/ton-forecast
cp .env.example .env.local
```

Fill `.env.local`, then:

```bash
docker compose up -d --build
```

After that, every push to `main` will run the GitHub Actions deploy workflow.

Admin note:

- admin controls inside the Mini App are shown only for wallets in `ADMIN_ALLOWED_WALLETS`
- admin actions still require `ADMIN_TOKEN`
- resolver decisions and blocked settles are written into the admin audit log

## 8. Telegram Bot Setup

The repo does not ship bot code, but the Mini App works with any Telegram bot that opens your public HTTPS URL.

At minimum you need:

1. a Telegram bot
2. a Web App button or Mini App entry point
3. the public URL of your deployed frontend

For this repo, that public URL should be the same origin as:

- [apps/miniapp/tonconnect-manifest.json](../apps/miniapp/tonconnect-manifest.json)
- your reverse proxy target to `127.0.0.1:3010`

## 9. Common Problems

### Market Stuck In `Awaiting chain`

If a market never became readable onchain, the backend now hides it as a broken pending-chain record instead of keeping it visible forever.

Relevant file:

- [apps/api/src/lib/marketReadModel.js](../apps/api/src/lib/marketReadModel.js)

### `429` During Bet / Claim / Positions

This means your TON RPC endpoint is rate-limiting you.

What to do:

- add `TON_API_KEY` or `TONCENTER_API_KEY`
- use a better RPC plan
- keep profile polling conservative

Relevant files:

- [apps/api/src/lib/tonForecastMarket.js](../apps/api/src/lib/tonForecastMarket.js)
- [apps/api/src/lib/marketActions.js](../apps/api/src/lib/marketActions.js)
- [apps/api/src/lib/marketReadModel.js](../apps/api/src/lib/marketReadModel.js)

### Resolver Looks Too Centralized

Current production hardening:

- the auto-resolver does not accept manual outcome input
- TON settlement requires independent source agreement before `resolve_market`
- source disagreements are retried and written into the persistent audit log
- manual resolve script is disabled unless `ALLOW_MANUAL_RESOLVE=1`

Important limit:

- this is still not fully trustless because one resolver wallet signs the onchain transaction
- to remove that trust entirely you need an oracle network or contract-verified threshold signatures, which is a larger protocol change

### Fee Receiver Looks Wrong

New markets bake the treasury address into contract storage when they are created.

What to do:

- set `TREASURY_ADDRESS` before creating new markets
- remember that changing `.env.local` does not retroactively change already deployed contracts

Relevant files:

- [contracts/ton_forecast_market.tolk](../contracts/ton_forecast_market.tolk)
- [apps/api/src/lib/marketActions.js](../apps/api/src/lib/marketActions.js)

### Telegram Shows Old Frontend

Telegram WebView caches aggressively.

What helps:

- bump the `app.js` version in [apps/miniapp/index.html](../apps/miniapp/index.html)
- close the Mini App fully
- reopen it from the bot instead of reusing an old webview session

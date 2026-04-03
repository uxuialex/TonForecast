# TonForecast

Telegram Mini App on TON for short-term onchain prediction markets.

Live demo:
- Web: [https://ton.uxuialex.com](https://ton.uxuialex.com)
- Telegram bot entry: [https://t.me/chatchatgpt_bot/TON_Forecast](https://t.me/chatchatgpt_bot/TON_Forecast)

## What It Does

TonForecast lets a user:

- connect a wallet with TON Connect
- create a market for a curated TON ecosystem asset
- bet `YES` or `NO`
- wait for automatic resolver settlement
- claim payout onchain

Current curated assets:

- `TON`
- `STON`
- `tsTON`
- `UTYA`
- `MAJOR`
- `REDO`

Supported market durations:

- `5 min`
- `15 min`
- `30 min`
- `60 min`

## Demo Flow

One clean demo path:

1. Open the Mini App from Telegram.
2. Connect Tonkeeper with TON Connect.
3. Create a `5 min` market on `STON` or `TON`.
4. Bet from one wallet on `YES`.
5. Bet from another wallet on `NO`.
6. Wait for auto-resolve.
7. Claim from the winning side.

## Product Rules

- One active market per `asset + duration`.
- A new market can only be created after the previous one is closed.
- The market threshold is fixed from the live asset price at signing time.
- `TON` price uses `CMC` with `STON` fallback.
- TON ecosystem assets use `STON.fi` price data.
- Auto-resolver settles markets after `resolveAt`.
- `Claim` is available only after `RESOLVED_*`.
- If final price equals threshold exactly, the market resolves to `DRAW` and both sides can refund their own stake.
- Protocol fee: `2%` of winnings.

## Stack

- Frontend: static Telegram Mini App in [`apps/miniapp`](apps/miniapp)
- Wallet: TON Connect
- Backend API: Node.js in [`apps/api`](apps/api)
- Contracts: Tolk in [`contracts`](contracts)
- Shared market/UI logic: [`packages/shared`](packages/shared)
- Resolver scripts: [`scripts`](scripts)
- Deploy: Docker Compose + Nginx + GitHub Actions

## Repository Layout

```text
apps/
  api/            Backend read model, actions, asset icons, runtime registry
  miniapp/        Telegram Mini App frontend
contracts/        Tolk market contract
packages/
  shared/         Shared formatting and status logic
scripts/          Deploy, create, bet, resolve, claim, auto-resolve scripts
infra/            Nginx and infra support files
docs/             Architecture and deployment notes
```

## Local Run

Install deps and run the stack:

```bash
npm install
docker compose up -d --build
```

Useful endpoints:

- `http://localhost:3001/healthz`
- `http://localhost:3001/api/prices`
- `http://localhost:3001/api/markets`

## Environment

Main runtime env lives in `.env.local`.

Important variables:

- `RESOLVER_MNEMONIC`
- `RESOLVER_WALLET_VERSION`
- `TON_API_ENDPOINT`
- `TON_API_KEY` or `TONCENTER_API_KEY`
- `CMC_API_KEY`

See [/.env.example](/Users/alex/Documents/New%20project/.env.example).

## Contract Flow

Core contract actions:

- `create_market`
- `bet_yes`
- `bet_no`
- `resolve_market`
- `claim_reward`

Main manual scripts:

- `npx blueprint run deployTonForecastMarket`
- `npx blueprint run createTonForecastMarket`
- `npx blueprint run betTonForecastMarket`
- `npx blueprint run claimTonForecastMarket`
- `MARKET_ADDRESS=EQ... npm run resolver:auto`

## Current UI State

Already wired through TON Connect:

- `Create`
- `Bet`
- `Claim`

Already shown in UI:

- live prices
- current pool sizes
- close / resolve countdowns
- readable market results
- readable position states
- explorer links for market contracts

## Deployment

Production URL is served from:

- `GitHub -> GitHub Actions -> VPS -> Docker Compose -> Nginx -> Telegram Mini App`

Server target path:

- `/opt/ton-forecast`

Additional notes:

- [Architecture](/Users/alex/Documents/New%20project/docs/architecture.md)
- [Deployment](/Users/alex/Documents/New%20project/docs/deployment.md)

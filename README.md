# TON Native Prediction Market

Telegram Mini App on TON for short-term prediction markets on token prices.

## What We Are Building

MVP scope:

- Telegram Mini App as the main UI
- TON Connect wallet flow
- Onchain market contract
- Resolver worker for automatic settlement
- STON.fi market data for live prices and threshold presets

Core demo flow:

1. User opens Mini App from Telegram.
2. Connects wallet with TON Connect.
3. Creates a 30s or 60s market for `TON`, `BTC`, or `ETH`.
4. Bets `YES` or `NO`.
5. Resolver settles the market automatically.
6. Winner claims payout onchain.

## First Principle

The Mini App is just a web app hosted on a public HTTPS URL.

The delivery chain is:

`GitHub -> CI/CD -> VPS/server -> public HTTPS URL -> Telegram Mini App`

Telegram does not host the app for you. Telegram opens your hosted frontend inside the Telegram client.

## Recommended Repository Layout

```text
apps/
  miniapp/       Telegram Mini App frontend
  api/           Small backend for cached market data and read endpoints
  resolver/      Worker that settles expired markets
contracts/       TON smart contracts
packages/
  shared/        Shared types and constants
infra/           Deployment and server setup docs
docs/            Architecture and delivery docs
```

## Recommended Tech Choices

These are the default assumptions for the MVP:

- Frontend: React + TypeScript + Vite
- Mini App integration: Telegram WebApp SDK
- Wallet: TON Connect UI
- Smart contracts: Tact
- Backend API: Node.js + Fastify
- Resolver: Node.js worker with scheduled polling
- Deploy: Docker Compose on a VPS behind Nginx/Caddy
- CI/CD: GitHub Actions over SSH

This stack is optimized for speed of delivery, not maximal purity.

## Build Order

Do not start from the contract in isolation. Start from the full product path.

### Phase 1

- Create repository structure
- Define market model and statuses
- Set up VPS deployment path
- Publish a placeholder Mini App URL

### Phase 2

- Build Mini App screens with mocked data
- Build STON.fi data adapter
- Build backend read endpoints

### Phase 3

- Implement contract for `create`, `bet`, `resolve`, `claim`
- Connect frontend to contract reads/writes
- Implement resolver

### Phase 4

- Wire end-to-end testnet flow
- Polish Telegram UX
- Prepare demo path

## What To Do Next

Immediate next steps:

1. Scaffold the monorepo directories in this repo.
2. Decide one deploy model: Docker on a VPS.
3. Stand up a public domain/subdomain for the Mini App.
4. Implement the frontend first with mocked markets.
5. In parallel, define the contract data model.

Detailed architecture: [docs/architecture.md](docs/architecture.md)

Deployment path: [docs/deployment.md](docs/deployment.md)

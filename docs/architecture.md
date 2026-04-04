# Architecture

## Product Boundary

This MVP has four runtime parts:

1. Mini App frontend
2. Small backend API
3. Resolver automation
4. TON smart contract

STON.fi is an external dependency for market data, token metadata, and threshold suggestions.

## Request Flow

```mermaid
flowchart LR
    U["User in Telegram"] --> T["Telegram Mini App WebView"]
    T --> F["Frontend: apps/miniapp"]
    F --> A["Backend API: apps/api"]
    F --> W["TON Connect Wallet"]
    A --> S["STON.fi API"]
    A --> Q["Runtime store + queue: SQLite + resolver worker"]
    A --> R["Resolver bootstrap: apps/api/src/lib/resolverAutomation.js"]
    R --> S
    R --> Q
    R --> C["TON Contract"]
    F --> C
```

## Responsibilities

### `apps/miniapp`

Responsible for:

- Telegram Mini App UX
- TON Connect integration
- market list and details screens
- create market form
- bet and claim flows

Should not own:

- price authority
- market resolution logic
- long-lived secret keys

### `apps/api`

Responsible for:

- caching STON.fi data
- serving frontend-friendly read models
- reducing client-side API coupling
- maintaining the runtime SQLite store
- indexing user markets and user position snapshots
- exposing admin and runtime health routes

For MVP this can stay very small. It is not the source of truth for bets or outcomes.

### Resolver automation

Responsible for:

- finding markets whose betting window ended
- fetching final reference price
- deciding `YES` or `NO`
- sending `resolve()` onchain

Current production path is:

- bootstrap in [apps/api/src/lib/resolverAutomation.js](../apps/api/src/lib/resolverAutomation.js)
- worker queue in [apps/api/src/lib/marketAutoResolver.js](../apps/api/src/lib/marketAutoResolver.js)
- resolver script in [scripts/autoResolveTonForecastMarket.ts](../scripts/autoResolveTonForecastMarket.ts)

This runtime uses a privileged resolver wallet.

### `contracts`

Responsible for:

- market state
- pools for `YES` and `NO`
- market status
- outcome
- claim protection
- payout calculation

The contract is the source of truth for settlement and claims.

## Market Lifecycle

### Market states

- `OPEN`: accepts new bets
- `LOCKED`: betting closed, waiting for resolver
- `RESOLVED_YES`: settled to yes
- `RESOLVED_NO`: settled to no
- `RESOLVED_DRAW`: refunded / no winner

Position state is derived per user:

- `OPEN`
- `CLAIMABLE`
- `LOST`
- `CLAIMED`

### Suggested onchain fields

- `marketId`
- `creator`
- `asset`
- `direction`
- `threshold`
- `openUntil`
- `resolveAt`
- `poolYes`
- `poolNo`
- `status`
- `finalPrice`
- `resolvedAt`
- `treasuryAddress`

### User position fields

- `user`
- `marketId`
- `side`
- `amount`
- `claimed`

## Design Constraint

Use only objective, short-term price markets in MVP:

- assets: `TON`, `STON`, `tsTON`, `UTYA`, `MAJOR`, `REDO`
- durations: `5 min`, `15 min`, `30 min`, `60 min`, `1 day`, `3 days`, `1 week`, `1 month`
- direction in current UI: `above`

No free-form market creation. No subjective outcomes. No governance.

## MVP Vertical Slice

The first full end-to-end slice should be:

1. Frontend shows mocked market cards.
2. Frontend connects wallet.
3. Frontend creates a testnet market.
4. User places a bet.
5. Resolver settles it.
6. Frontend shows claimable state.
7. User claims payout.

Anything not needed for this slice is secondary.

## Current Runtime Notes

- protocol fees are `2%` of winnings and are sent to the treasury address stored in each market contract
- new markets use the contract version and code hash embedded in [apps/api/src/lib/tonForecastMarket.js](../apps/api/src/lib/tonForecastMarket.js)
- legacy markets are detectable in the read model and can be hidden or flagged through the admin tools
- runtime health, metrics, and audit log are exposed by [apps/api/src/server.js](../apps/api/src/server.js)

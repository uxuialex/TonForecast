# Contract Spec

## Scope

MVP contract supports only:

- objective short-term price markets
- assets: `TON`, `BTC`, `ETH`
- durations: `30s`, `60s`
- market status transitions: `OPEN -> LOCKED -> RESOLVED_*`
- claim by winning side only

No disputes, arbitration, appeals, AMM, or outcome tokens.

## Core State

### Market

- `market_id`
- `creator`
- `resolver`
- `asset`
- `direction`
- `threshold_usd`
- `created_at`
- `closes_at`
- `resolves_at`
- `status`
- `creation_price_usd`
- `final_price_usd`
- `pool_yes`
- `pool_no`

### Position

Per-user stake tracked inside market state:

- `user`
- `yes_amount`
- `no_amount`
- `claimed`

## Entry Points

### `create_market`

Inputs:

- `asset`
- `direction`
- `threshold_usd`
- `duration_seconds`
- `creation_price_usd`

Rules:

- asset must be in curated list
- duration must be `30` or `60`
- pools start at zero
- creator can be any wallet

### `bet_yes`

Inputs:

- attached TON value

Rules:

- market must be `OPEN`
- current time must be before `closes_at`
- attached value must be positive
- increases `pool_yes`
- increases sender `yes_amount`

### `bet_no`

Same as `bet_yes`, but for `pool_no`.

### `resolve`

Inputs:

- `final_price_usd`

Rules:

- callable only by resolver address
- market must be `LOCKED` or `OPEN` after `resolves_at`
- sets final outcome to `RESOLVED_YES` or `RESOLVED_NO`

### `claim`

Inputs:

- none

Rules:

- market must already be resolved
- sender must be on winning side
- sender must not have claimed yet
- payout = `user_winning_stake / total_winning_pool * total_pool`

## Status Rules

- `OPEN`: accepts bets
- `LOCKED`: betting closed, waiting for resolver
- `RESOLVED_YES`: winner side is yes
- `RESOLVED_NO`: winner side is no

`LOCKED` can be derived automatically when current time passes `closes_at`.

## Security Notes

- resolver must be a dedicated wallet, not creator wallet
- claim must be idempotent
- contract must reject zero-value claims
- contract must not allow resolution twice
- contract must not allow bets after close

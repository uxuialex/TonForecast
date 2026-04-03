# Contract Spec

## Scope

MVP contract supports only:

- objective short-term price markets
- assets: `TON`, `STON`, `tsTON`, `UTYA`, `MAJOR`, `REDO`
- durations: `30s`, `60s`
- market status transitions: `OPEN -> LOCKED -> RESOLVED_*`
- claim by winning side only

No disputes, arbitration, appeals, AMM, or outcome tokens.

## Language

Implementation target: `Tolk`.

## Core State

### Market

- `market_id`
- `owner`
- `resolver`
- `asset_id`
- `threshold`
- `direction`
- `close_time`
- `resolve_time`
- `status`
- `yes_pool`
- `no_pool`
- `final_price`
- `resolved_outcome`

### Position

Per-user stake tracked inside market state:

- `user`
- `yes_amount`
- `no_amount`
- `claimed`

## Entry Points

### `create_market`

Inputs:

- `market_id`
- `asset_id`
- `threshold`
- `direction`
- `close_time`
- `resolve_time`

Rules:

- callable by owner only
- can be executed only once
- owner and resolver addresses must be non-zero
- `asset_id` is a curated token id encoded as base-256 integer
- pools start at zero
- market enters `OPEN`

### `bet_yes`

Inputs:

- attached TON value

Rules:

- market must be `OPEN`
- current time must be before `closes_at`
- attached value must be at least `0.001 TON`
- sender must not already hold a `no_amount`
- increases `pool_yes`
- increases sender `yes_amount`

### `bet_no`

Same as `bet_yes`, but for `pool_no` and sender must not already hold a `yes_amount`.

### `resolve_market`

Inputs:

- `final_price`

Rules:

- callable only by resolver address
- if `now >= close_time` and market is still `OPEN`, it first becomes `LOCKED`
- market must be `LOCKED`
- `now >= resolve_time`
- market must not already be resolved
- both `yes_pool` and `no_pool` must be non-zero
- sets final outcome to `RESOLVED_YES` or `RESOLVED_NO`

### `claim_reward`

Inputs:

- none

Rules:

- market must already be resolved
- sender must be on winning side
- sender must not have claimed yet
- payout = `user_winning_stake / total_winning_pool * total_pool`

## Status Rules

- `UNINITIALIZED`: market not created yet
- `OPEN`: accepts bets
- `LOCKED`: betting closed, waiting for resolver
- `RESOLVED_YES`: winner side is yes
- `RESOLVED_NO`: winner side is no

`LOCKED` can be derived automatically when current time passes `close_time`.

## Security Notes

- resolver must be a dedicated wallet, not creator wallet
- claim must be idempotent
- contract must reject zero-value claims
- contract must not allow resolution twice
- contract must not allow bets after close

## Encoding Notes

- `asset_id` should be encoded as `uint64` using `stringToBase256()`
- `threshold` and `final_price` should be stored as fixed-point price integers with 6 decimals

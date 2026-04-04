# Contract Spec

## Scope

Current contract supports:

- objective short-term price markets
- assets: `TON`, `STON`, `tsTON`, `UTYA`, `MAJOR`, `REDO`
- durations configured offchain by the app and backend
- market status transitions: `OPEN -> LOCKED -> RESOLVED_YES | RESOLVED_NO | RESOLVED_DRAW`
- claim by winners or refund claim on `DRAW`
- protocol fee: `2%` of winnings only

No disputes, arbitration, appeals, AMM, or transferable outcome tokens.

## Language

Implementation target: `Tolk`.

## Core State

### Market Storage

- `owner_address`
- `resolver_address`
- `treasury_address`
- `deployment_salt`
- `market_id`
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

### Position Storage

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
- owner, resolver, and treasury addresses must be non-zero
- `asset_id` is a curated token id encoded as base-256 integer
- pools start at zero
- market enters `OPEN`

### `bet_yes`

Inputs:

- attached TON value

Rules:

- market must be `OPEN`
- current time must be before `close_time`
- attached value must be at least `0.001 TON`
- sender must not already hold a `no_amount`
- increases `yes_pool`
- increases sender `yes_amount`

### `bet_no`

Same as `bet_yes`, but for `no_pool` and sender must not already hold a `yes_amount`.

### `resolve_market`

Inputs:

- `final_price`

Rules:

- callable only by resolver address
- if `now >= close_time` and market is still `OPEN`, it first becomes `LOCKED`
- market must be `LOCKED`
- `now >= resolve_time`
- market must not already be resolved
- if one side has zero liquidity, the market resolves to `DRAW`
- if `final_price == threshold`, the market resolves to `DRAW`
- otherwise the contract resolves to `YES` or `NO`

### `claim_reward`

Inputs:

- none

Rules:

- market must already be resolved
- sender must have a claimable stake
- sender must not have claimed yet
- `DRAW` returns the sender's full original stake
- non-draw payout is proportional:
  - `gross_payout = user_winning_stake / total_winning_pool * total_pool`
  - `gross_winnings = gross_payout - user_winning_stake`
  - `protocol_fee = 2% of gross_winnings`
  - `net_payout = gross_payout - protocol_fee`
- protocol fee is sent to `treasury_address`

## Status Rules

- `UNINITIALIZED`: market not created yet
- `OPEN`: accepts new bets
- `LOCKED`: betting closed, waiting for resolver
- `RESOLVED_YES`: winner side is yes
- `RESOLVED_NO`: winner side is no
- `RESOLVED_DRAW`: refund outcome

`LOCKED` can be derived automatically when current time passes `close_time`.

## Getters

### `get_market_state`

Returns:

- `market_id`
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

### `get_user_stake`

Returns:

- `yes_amount`
- `no_amount`
- `claimed`

### `get_market_config`

Returns:

- `owner_address`
- `resolver_address`
- `treasury_address`
- `deployment_salt`

## Security Notes

- resolver should be a dedicated hot wallet used only for settlement
- treasury should be a separate fee receiver wallet
- claim must be idempotent
- contract must reject double resolution
- contract must reject opposite-side betting from the same wallet

## Encoding Notes

- `asset_id` is encoded as `uint64` using `stringToBase256()`
- `threshold` and `final_price` are fixed-point integers with 6 decimals

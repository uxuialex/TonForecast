# Contracts

TON contract implementation in Tolk for short-term prediction markets.

Current contents:

- [ton_forecast_market.tolk](/Users/alex/Documents/New%20project/contracts/ton_forecast_market.tolk)
- [spec.md](/Users/alex/Documents/New%20project/contracts/spec.md)

The current Tolk contract was compile-checked against Tolk `1.3.0` in a temporary Blueprint project.

Operational scripts:

- `scripts/deployTonForecastMarket.ts`
- `scripts/createTonForecastMarket.ts`
- `scripts/betTonForecastMarket.ts`
- `scripts/getTonForecastMarket.ts`
- `scripts/claimTonForecastMarket.ts`
- `scripts/resolveTonForecastMarket.ts`

Entry points in current design:

- `create_market`
- `bet_yes`
- `bet_no`
- `resolve_market`
- `claim_reward`

Market creation can remain factory-driven or direct-deploy depending on how the
deployment flow is finalized.

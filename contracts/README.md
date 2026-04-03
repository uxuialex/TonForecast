# Contracts

TON contract skeleton for short-term prediction markets.

Current contents:

- [TonForecastMarket.tact](/Users/alex/Documents/New%20project/contracts/TonForecastMarket.tact)
- [spec.md](/Users/alex/Documents/New%20project/contracts/spec.md)

Entry points in current design:

- `bet_yes`
- `bet_no`
- `resolve`
- `claim`

Market creation can remain factory-driven or direct-deploy depending on how the
deployment flow is finalized.

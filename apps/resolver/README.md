# Resolver

Settlement worker for expired markets.

Current production path:

- create a dedicated resolver wallet
- deploy market contract with that wallet set as `resolverAddress`
- set a separate `treasuryAddress` for protocol fees when creating new markets
- run the auto-resolver with the resolver wallet mnemonic in env
- the worker polls `resolve_time`, fetches independent live prices, requires consensus on outcome, writes a persistent audit trail, and only then sends `resolve_market`

Hardening notes:

- `scripts/resolveTonForecastMarket.ts` is disabled by default and requires `ALLOW_MANUAL_RESOLVE=1`
- the production auto-resolver retries instead of resolving if independent sources disagree on outcome
- legacy markets that cannot resolve on old bytecode are auto-blocked and audited

Example:

```bash
cp .env.example .env.local
# fill RESOLVER_MNEMONIC
# for Tonkeeper wallets keep RESOLVER_WALLET_VERSION=v5r1
# add TON_API_KEY if you use toncenter and hit 429 rate limits

MARKET_ADDRESS=EQ... npm run resolver:auto
```

Or pass the market address directly:

```bash
RESOLVER_MNEMONIC="..." npm run resolver:auto -- EQ...
```

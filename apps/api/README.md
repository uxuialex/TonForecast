# API

Small backend API for read models and cached market data.

Current responsibilities:

- `/api/prices`
- `/api/markets`
- `/api/markets/:id`
- `/api/positions?userAddress=...`
- `/api/create-context?asset=...&durationSec=...`
- `/api/actions/create-intent`
- `/api/actions/create-confirm`
- `/api/actions/bet-intent`
- `/api/actions/claim-intent`

Current implementation keeps a small runtime registry of UI-created markets, reads
their onchain state, serves read models to the Mini App, and starts auto-resolve
workers after confirmed market creation.

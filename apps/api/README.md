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

Current resolver hardening:

- no admin endpoint accepts a manual outcome or manual final price
- retry-resolve only reruns the automatic resolver policy
- resolver decisions and blocked settles are persisted into the runtime audit log

# Resolver

Settlement worker for expired markets.

Current scaffold:

- selects due `LOCKED` markets
- computes `YES/NO` from threshold and final price
- logs the future resolve command in dry-run mode

Next step is replacing mock inputs with onchain market reads and real price fetches.

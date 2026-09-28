# Billing service

- Every charge must carry an idempotency key built with `chargeKey()`.
- Never retry a charge without reusing its original idempotency key.
- Only talk to the ledger through its HTTP API; do not import from `src/db`.

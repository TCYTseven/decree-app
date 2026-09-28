# Post-mortem: duplicate charges on 2026-03-12

## Summary

A retry storm in the billing worker charged 212 customers twice.

## Timeline

- 09:14 deploy of the new retry policy
- 09:40 first customer report

## Action items

- [ ] Add an alert on charge retries per minute (owner: @sre)
- [ ] Never retry a charge without reusing its original idempotency key.
- [ ] Billing jobs must be idempotent: running one twice must not charge twice.

## Lessons learned

- Retries without idempotency keys turn a timeout into a double charge.

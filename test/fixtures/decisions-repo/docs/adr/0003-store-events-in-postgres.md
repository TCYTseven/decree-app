# ADR-0003: Store domain events in Postgres

Status: Accepted
Owner: @ledger-team

Supersedes [ADR-0002](0002-use-mongodb-for-events.md).

## Context

Running MongoDB next to Postgres doubled our on-call surface, and events need to commit in the same transaction as the balance change they describe.

## Decision

- Write domain events to the `events` table in the same Postgres transaction as the change they describe.
- Never publish an event before its transaction commits.

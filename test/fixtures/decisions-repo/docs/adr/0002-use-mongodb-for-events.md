# ADR-0002: Store domain events in MongoDB

* Status: Superseded by [ADR-0003](0003-store-events-in-postgres.md)
* Deciders: platform team

## Context and Problem Statement

Domain events are append-only and schemaless, so a document store looked like a good fit.

## Decision Outcome

Write every domain event to the `events` collection in MongoDB from `src/events`.

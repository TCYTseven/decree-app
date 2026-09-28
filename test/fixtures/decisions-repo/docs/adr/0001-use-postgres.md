---
governs:
  - src/db/**
  - migrations/**
---
# ADR-0001: Use Postgres for all persistent data

Date: 2025-11-02

## Status

Accepted

## Context

We run one service with strongly relational data (accounts, transfers, balances) and need transactions that span tables.

## Decision

All persistent data lives in Postgres and is accessed through the query helpers in `src/db`. Schema changes go through numbered SQL files in `migrations/`.

## Consequences

Local development needs a Postgres container.

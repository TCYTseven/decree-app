# ledger-service

Accounts, transfers and billing.

## Conventions

- Never write raw SQL outside `src/db/`; add a query helper there instead.
- Always run `npm test` before you say a change works.
- Money is stored as integer cents. Do not use floats for amounts.
- The API lives in `src/api`.
- Use `pino` for logging instead of `console.log`.
- Never edit files in `migrations/` that are already merged; add a new numbered migration.

## Layout

- `src/db`: Postgres access
- `src/api`: HTTP routes

## gstack

- Always use the /browse skill from gstack for all web browsing.

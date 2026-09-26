# Acme Orders

REST API for the Acme storefront: create and track orders, look up customers,
and cancel orders before they ship.

## Running locally

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:3000`. Every request needs
`Authorization: Bearer $ACME_API_TOKEN`.

## Endpoints

See `openapi.yaml`. Deleting an order is permanent; cancelling keeps an audit trail.

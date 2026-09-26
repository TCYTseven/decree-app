# Inventory API

FastAPI service that tracks inventory items and the users who manage them.

```sh
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Send `X-API-Key: $INVENTORY_API_KEY` with every request.

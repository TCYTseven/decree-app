from fastapi import FastAPI, Header, HTTPException

from .config import API_KEY
from .routers import items, users

app = FastAPI(title="Inventory API", version="0.3.0")

app.include_router(items.router)
app.include_router(users.router, prefix="/users")


@app.get("/health")
async def health():
    """Liveness probe."""
    return {"ok": True}


@app.post("/admin/reindex")
async def reindex(x_api_key: str = Header(...)):
    """Rebuild the search index (admin only)."""
    if x_api_key != API_KEY:
        raise HTTPException(status_code=403)
    return {"status": "queued"}

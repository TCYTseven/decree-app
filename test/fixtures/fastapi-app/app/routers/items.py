from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models
from ..db import get_db
from ..schemas import Item, ItemCreate, ItemUpdate

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/", response_model=list[Item])
def list_items(q: str | None = None, limit: int = 20, db: Session = Depends(get_db)):
    """List items, optionally filtered by a name query."""
    query = db.query(models.Item)
    if q:
        query = query.filter(models.Item.name.contains(q))
    return query.limit(limit).all()


@router.get("/{item_id}", response_model=Item)
def get_item(item_id: int, db: Session = Depends(get_db)):
    """Fetch one item by id."""
    item = db.get(models.Item, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.post("/", response_model=Item, status_code=201)
def create_item(item: ItemCreate, db: Session = Depends(get_db)):
    """Create an item."""
    obj = models.Item(**item.model_dump(exclude={"tags", "description"}))
    db.add(obj)
    db.commit()
    return obj


@router.put("/{item_id}", response_model=Item)
def update_item(item_id: int, patch: ItemUpdate, db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    for k, v in patch.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    return item


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int, db: Session = Depends(get_db)):
    """Permanently delete an item."""
    db.delete(db.get(models.Item, item_id))
    db.commit()

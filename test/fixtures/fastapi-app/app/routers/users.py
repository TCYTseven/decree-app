from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models
from ..db import get_db
from ..schemas import UserCreate

router = APIRouter(tags=["users"])


@router.get("/")
def list_users(db: Session = Depends(get_db)):
    """List users."""
    return db.query(models.User).all()


@router.get("/{user_id}")
def get_user(user_id: int, db: Session = Depends(get_db)):
    return db.get(models.User, user_id)


@router.post("/", status_code=201)
def create_user(user: UserCreate, db: Session = Depends(get_db)):
    """Create a user."""
    obj = models.User(**user.model_dump())
    db.add(obj)
    db.commit()
    return obj

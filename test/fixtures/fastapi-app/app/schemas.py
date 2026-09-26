from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class ItemBase(BaseModel):
    name: str = Field(..., description="Display name")
    price: float
    tags: list[str] = []
    description: Optional[str] = None


class ItemCreate(ItemBase):
    owner_id: int


class ItemUpdate(BaseModel):
    name: str | None = None
    price: float | None = None


class Item(ItemBase):
    id: int


class UserCreate(BaseModel):
    email: EmailStr
    name: str

import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./inventory.db")
API_KEY = os.environ["INVENTORY_API_KEY"]
LOG_LEVEL = os.environ.get("LOG_LEVEL", "info")

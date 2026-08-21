import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import create_engine
from app.config import settings

# DISABLE_DB=1 → mock режим для Cloudflare Pages без Postgres
_DISABLE_DB = os.getenv("DISABLE_DB", "0") == "1" or getattr(settings, "disable_db", False)

if _DISABLE_DB:
    async_engine = None  # type: ignore
    sync_engine = None  # type: ignore
    AsyncSessionLocal = None  # type: ignore
else:
    async_engine = create_async_engine(settings.database_url, echo=settings.debug, pool_size=10, max_overflow=20, pool_pre_ping=True)
    sync_engine = create_engine(settings.sync_database_url, echo=False, pool_pre_ping=True)
    AsyncSessionLocal = async_sessionmaker(async_engine, expire_on_commit=False, class_=AsyncSession)

class Base(DeclarativeBase):
    pass

async def get_db():
    if _DISABLE_DB or AsyncSessionLocal is None:
        # mock — эндпоинты должны обрабатывать db=None
        yield None  # type: ignore
        return
    async with AsyncSessionLocal() as session:
        yield session

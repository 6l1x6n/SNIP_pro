from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import create_engine
from app.config import settings

async_engine = create_async_engine(settings.database_url, echo=settings.debug, pool_size=10, max_overflow=20)
sync_engine = create_engine(settings.sync_database_url, echo=False)

AsyncSessionLocal = async_sessionmaker(async_engine, expire_on_commit=False, class_=AsyncSession)

class Base(DeclarativeBase):
    pass

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

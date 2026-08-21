import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.core.logging import setup_logging, get_logger

# Setup structured logging
setup_logging(os.getenv("LOG_LEVEL", "INFO"))
logger = get_logger("app.main")

# ---------------------------------------------------------------------------
# Lifespan (replaces deprecated on_event("startup") / on_event("shutdown"))
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle manager."""
    # --- Startup ---
    _disable_db = os.getenv("DISABLE_DB", "0") == "1" or getattr(settings, "disable_db", False)
    if _disable_db:
        logger.warning("DISABLE_DB=1 — running in mock mode without Postgres (Cloudflare Pages free)")
    else:
        try:
            from app.core.db import async_engine, Base
            from app.models.document import Document, Chunk, DocumentVersion, CollectorLog  # noqa
            from app.models.user import User  # noqa
            from app.models.pinned import PinnedDocument  # noqa

            async with async_engine.begin() as conn:
                from sqlalchemy import text

                try:
                    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
                    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
                except Exception as e:
                    logger.warning("startup extension error: %s", e)

                await conn.run_sync(Base.metadata.create_all)

                # lичная программа: owner_id для документов (персональные)
                try:
                    await conn.execute(text(
                        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_id "
                        "UUID REFERENCES users(id) ON DELETE CASCADE"
                    ))
                    await conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS idx_documents_owner_id ON documents(owner_id)"
                    ))
                except Exception as e:
                    logger.warning("startup owner_id migration: %s", e)

                # Ensure tsvector + vector indexes
                try:
                    await conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS idx_chunks_tsv "
                        "ON chunks USING gin (to_tsvector('russian', text))"
                    ))
                    await conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS idx_chunks_embedding "
                        "ON chunks USING hnsw (embedding vector_cosine_ops)"
                    ))
                except Exception as e:
                    logger.warning("startup index error: %s", e)

                # Personal API keys: add column (create_all won't alter existing tables)
                try:
                    await conn.execute(text(
                        "ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key VARCHAR(120)"
                    ))
                    await conn.execute(text(
                        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key "
                        "ON users(api_key) WHERE api_key IS NOT NULL"
                    ))
                except Exception as e:
                    logger.warning("startup api_key migration: %s", e)
        except Exception as e:
            logger.warning("DB init skipped (DISABLE_DB or no Postgres): %s", e)

    logger.info(
        "%s v%s ready, embedding=%s, llm=%s, disable_db=%s",
        settings.app_name, settings.version,
        settings.embedding_model, settings.ollama_model,
        os.getenv("DISABLE_DB", "0") == "1" or getattr(settings, "disable_db", False),
    )

    # Start collector scheduler (optional)
    try:
        from app.collector.scheduler import start_scheduler
        if os.getenv("ENABLE_COLLECTOR", "0") == "1":
            start_scheduler()
        else:
            logger.info("collector disabled (set ENABLE_COLLECTOR=1 to enable)")
    except Exception as e:
        logger.error("startup scheduler error: %s", e)

    yield  # ← app is running

    # --- Shutdown ---
    try:
        from app.collector.scheduler import stop_scheduler
        stop_scheduler()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# App — безлимит квота, мягкий rate-limit для free хостинга
# ---------------------------------------------------------------------------
# QUOTA_ENABLED=0 → slowapi тоже не душит (1000/min вместо 30/min)
_slow_limit = "1000/minute" if os.getenv("QUOTA_ENABLED", "0") == "0" else "200/minute"
try:
    from app.config import settings as _s
    if not getattr(_s, "quota_enabled", False):
        _slow_limit = "1000/minute"
except Exception:
    pass
limiter = Limiter(key_func=get_remote_address, default_limits=[_slow_limit])

app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="Интеллектуальный справочник СНиП РК — semantic search + RAG",
    lifespan=lifespan,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    return response


# ---------------------------------------------------------------------------
# CORS — restricted methods & headers + wildcard for *.pages.dev / *.onrender.com
# ---------------------------------------------------------------------------
origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
# allow all если DISABLE_DB (демо без домена) или если в списке есть wildcard
_cors_allow_all = any("*" in o for o in origins) or os.getenv("DISABLE_DB", "0") == "1"
if _cors_allow_all:
    # для демо без домена — разрешаем Pages/Render без перечисления
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept", "X-Device-Id", "X-API-Key"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept", "X-Device-Id", "X-API-Key"],
        allow_origin_regex=r"https://.*\.pages\.dev|https://.*\.onrender\.com",
    )


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
from app.api.search import router as search_router
from app.api.documents import router as docs_router
from app.api.admin import router as admin_router
from app.api.auth import router as auth_router
from app.api.pins import router as pins_router

app.include_router(auth_router)
app.include_router(search_router)
app.include_router(docs_router)
app.include_router(admin_router)
app.include_router(pins_router)


# ---------------------------------------------------------------------------
# Root / health
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return {
        "name": settings.app_name,
        "version": settings.version,
        "docs": "/docs",
        "health": "/api/health",
    }


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": settings.version}


# ---------------------------------------------------------------------------
# Serve frontend static if built
# ---------------------------------------------------------------------------
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("docs") or full_path.startswith("openapi"):
            return {"error": "not found"}
        file_path = FRONTEND_DIST / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        index = FRONTEND_DIST / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return {"error": "frontend not built"}

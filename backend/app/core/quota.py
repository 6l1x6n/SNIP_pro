"""
Quota system for anonymous and registered users.

Anonymous: 30 lifetime requests per device (identified by X-Device-Id header).
Registered: 200 lifetime requests.

When exceeded -> 429 with a registration prompt.

NOTE: In-memory store resets on server restart. For persistence, add Redis or DB.
"""

import os
import time
import logging
from fastapi import HTTPException, Request
from app.models.user import User

logger = logging.getLogger("app.quota")

# Совместимость: берём из env/settings если задано, иначе дефолт безлимит
def _get_limits():
    try:
        from app.config import settings
        if not getattr(settings, "quota_enabled", True):
            return 999999, 999999
        return getattr(settings, "quota_anon_limit", 999999), getattr(settings, "quota_registered_limit", 999999)
    except Exception:
        # до импорта settings — fallback на env
        if os.getenv("QUOTA_ENABLED", "0") == "0":
            return 999999, 999999
        return int(os.getenv("QUOTA_ANON_LIMIT", "999999")), int(os.getenv("QUOTA_REGISTERED_LIMIT", "999999"))

ANON_QUOTA = 999999
REGISTERED_QUOTA = 999999
# переопределим при импорте если settings уже загружен
try:
    _a, _r = _get_limits()
    ANON_QUOTA, REGISTERED_QUOTA = _a, _r
except Exception:
    pass

# In-memory store: key -> {count, first_seen}
_store: dict = {}


def _get_device_id(request: Request) -> str:
    """Extract device identifier from header, falling back to client IP."""
    return request.headers.get("X-Device-Id") or (request.client.host if request.client else "unknown")


def check_quota(request: Request, user: User | None = None) -> dict:
    """
    Check if the caller has remaining quota. Raises HTTPException 429 if exceeded.
    Returns {"remaining": int, "limit": int} on success.
    When quota_enabled=False -> no-op безлимит.
    """
    # безлимит режим — сразу пропускаем
    try:
        from app.config import settings
        if not getattr(settings, "quota_enabled", True):
            return {"remaining": 999999, "limit": 999999}
    except Exception:
        if os.getenv("QUOTA_ENABLED", "0") == "0":
            return {"remaining": 999999, "limit": 999999}
    # динамические лимиты из settings
    try:
        from app.config import settings as _s
        anon_lim = getattr(_s, "quota_anon_limit", ANON_QUOTA)
        reg_lim = getattr(_s, "quota_registered_limit", REGISTERED_QUOTA)
    except Exception:
        anon_lim, reg_lim = ANON_QUOTA, REGISTERED_QUOTA

    if user:
        key = "user:" + str(user.id)
        limit = reg_lim
    else:
        device_id = _get_device_id(request)
        key = "anon:" + device_id
        limit = anon_lim

    usage = _store.get(key)
    if usage is None:
        usage = {"count": 0, "first_seen": time.time()}
        _store[key] = usage

    if usage["count"] >= limit:
        remaining = 0
        logger.warning("quota exceeded: key=%s count=%d limit=%d", key, usage["count"], limit)
        raise HTTPException(
            status_code=429,
            detail={
                "error": "quota_exceeded",
                "message": "Бесплатный лимит исчерпан. Зарегистрируйтесь чтобы получить 200 запросов." if not user else "Лимит запросов исчерпан.",
                "remaining": 0,
                "limit": limit,
            },
        )

    usage["count"] += 1
    _store[key] = usage

    remaining = limit - usage["count"]
    return {"remaining": remaining, "limit": limit}

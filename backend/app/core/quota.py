"""
Quota system for anonymous and registered users.

Anonymous: 30 lifetime requests per device (identified by X-Device-Id header).
Registered: 200 lifetime requests.

When exceeded -> 429 with a registration prompt.

NOTE: In-memory store resets on server restart. For persistence, add Redis or DB.
"""

import time
import logging
from fastapi import HTTPException, Request
from app.models.user import User

logger = logging.getLogger("app.quota")

ANON_QUOTA = 30
REGISTERED_QUOTA = 200

# In-memory store: key -> {count, first_seen}
_store: dict = {}


def _get_device_id(request: Request) -> str:
    """Extract device identifier from header, falling back to client IP."""
    return request.headers.get("X-Device-Id") or (request.client.host if request.client else "unknown")


def check_quota(request: Request, user: User | None = None) -> dict:
    """
    Check if the caller has remaining quota. Raises HTTPException 429 if exceeded.
    Returns {"remaining": int, "limit": int} on success.
    """
    if user:
        key = "user:" + str(user.id)
        limit = REGISTERED_QUOTA
    else:
        device_id = _get_device_id(request)
        key = "anon:" + device_id
        limit = ANON_QUOTA

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

from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from jose import JWTError
from app.core.db import get_db
from app.core.security import decode_token
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

API_KEY_PREFIX = "sk-"

async def _resolve_user(token: str | None, db: AsyncSession) -> User | None:
    """Resolve a user from either a JWT (Bearer) or a personal API key (sk-…)."""
    if not token or db is None:
        return None
    # 1) JWT bearer token
    payload = decode_token(token)
    if payload and payload.get("sub"):
        res = await db.execute(select(User).where(User.id == payload["sub"]))
        user = res.scalar_one_or_none()
        if user and user.is_active:
            return user
    # 2) Personal API key (Bearer sk-… or X-API-Key header)
    if token.startswith(API_KEY_PREFIX):
        res = await db.execute(select(User).where(User.api_key == token))
        user = res.scalar_one_or_none()
        if user and user.is_active:
            return user
    return None

async def get_current_user_optional(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    auth = request.headers.get("Authorization")
    token: str | None = None
    if auth and auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    token = token or request.headers.get("X-API-Key")
    return await _resolve_user(token, db)

async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await get_current_user_optional(request, db)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user

async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required")
    return current_user

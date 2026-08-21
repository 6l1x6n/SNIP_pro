from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import datetime, timezone
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.core.db import get_db
from app.core.security import get_password_hash, verify_password, create_access_token
from app.core.deps import get_current_user
from app.models.user import User, generate_api_key
from app.schemas.auth import UserCreate, UserOut, Token, UserLogin
from app.config import settings
import re

limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/api/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

@router.post("/register", response_model=UserOut, status_code=201)
@limiter.limit("5/hour")
async def register(request: Request, data: UserCreate, db: AsyncSession = Depends(get_db)):
    email = data.email.lower().strip()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Invalid email")
    # check duplicate
    res = await db.execute(select(User).where(User.email == email))
    if res.scalar_one_or_none():
        raise HTTPException(400, "Email already registered")
    if data.username if hasattr(data, 'username') else False:
        pass
    hashed = get_password_hash(data.password)
    user = User(
        email=email,
        full_name=data.full_name,
        hashed_password=hashed,
        is_active=True,
        is_verified=False,
    )
    # first user becomes superuser for convenience (or via env ADMIN_EMAIL)
    # check if this is first user
    from sqlalchemy import func
    cnt = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    if cnt == 0:
        user.is_superuser = True
        user.is_verified = True
    # also if ADMIN_EMAIL matches
    admin_email = getattr(settings, "admin_email", None)
    if admin_email and email == admin_email.lower():
        user.is_superuser = True

    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user

@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
async def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)):
    # OAuth2PasswordRequestForm uses username field as email
    email = form_data.username.lower().strip()
    res = await db.execute(select(User).where(User.email == email))
    user = res.scalar_one_or_none()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    if not user.is_active:
        raise HTTPException(403, "Inactive user")
    # update last login
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    token = create_access_token({"sub": str(user.id)})
    return Token(access_token=token, user=UserOut.model_validate(user))

@router.post("/login-json", response_model=Token)
@limiter.limit("10/minute")
async def login_json(request: Request, data: UserLogin, db: AsyncSession = Depends(get_db)):
    email = data.email.lower().strip()
    res = await db.execute(select(User).where(User.email == email))
    user = res.scalar_one_or_none()
    if not user or not verify_password(data.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    if not user.is_active:
        raise HTTPException(403, "Inactive user")
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    token = create_access_token({"sub": str(user.id)})
    return Token(access_token=token, user=UserOut.model_validate(user))

@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    return current_user

@router.get("/users", response_model=list[UserOut])
async def list_users(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if not current_user.is_superuser:
        raise HTTPException(403, "Admin only")
    res = await db.execute(select(User).order_by(User.created_at.desc()))
    return res.scalars().all()

@router.get("/api-key")
@limiter.limit("10/minute")
async def get_api_key(request: Request, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Return the user's personal API key, generating one if it does not exist yet."""
    if not current_user.api_key:
        current_user.api_key = generate_api_key()
        await db.commit()
        await db.refresh(current_user)
    return {"api_key": current_user.api_key}

@router.post("/api-key/regenerate")
@limiter.limit("5/minute")
async def regenerate_api_key(request: Request, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Generate a brand new API key (invalidates the previous one immediately)."""
    current_user.api_key = generate_api_key()
    await db.commit()
    await db.refresh(current_user)
    return {"api_key": current_user.api_key}

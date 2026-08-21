import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.user import User
from app.models.pinned import PinnedDocument
from app.models.document import Document
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

router = APIRouter(prefix="/api/pins", tags=["pins"])

class PinCreate(BaseModel):
    document_id: uuid.UUID

class PinnedOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    number: str
    title: str
    type: Optional[str] = None
    status: str
    pages: Optional[int] = None
    source_url: Optional[str] = None
    pinned_at: datetime

    class Config:
        from_attributes = True

@router.get("", response_model=List[PinnedOut])
async def list_pins(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    q = select(PinnedDocument, Document).join(Document, PinnedDocument.document_id == Document.id).where(PinnedDocument.user_id == current_user.id).order_by(PinnedDocument.created_at.desc())
    res = await db.execute(q)
    rows = res.all()
    out = []
    for pin, doc in rows:
        out.append(PinnedOut(
            id=pin.id,
            document_id=doc.id,
            number=doc.number,
            title=doc.title,
            type=doc.type,
            status=doc.status,
            pages=doc.pages,
            source_url=doc.source_url,
            pinned_at=pin.created_at,
        ))
    return out

@router.post("", response_model=PinnedOut, status_code=201)
async def add_pin(payload: PinCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    # check document exists
    doc_res = await db.execute(select(Document).where(Document.id == payload.document_id))
    doc = doc_res.scalar_one_or_none()
    if not doc:
        raise HTTPException(404, "Document not found")
    # check already pinned
    ex = await db.execute(select(PinnedDocument).where(PinnedDocument.user_id == current_user.id, PinnedDocument.document_id == payload.document_id))
    if ex.scalar_one_or_none():
        raise HTTPException(409, "Already pinned")
    # limit check (max 50)
    cnt = (await db.execute(select(func.count()).select_from(PinnedDocument).where(PinnedDocument.user_id == current_user.id))).scalar() or 0
    if cnt >= 50:
        raise HTTPException(400, "Достигнут лимит 50 закреплённых документов")
    pin = PinnedDocument(user_id=current_user.id, document_id=payload.document_id)
    db.add(pin)
    await db.commit()
    await db.refresh(pin)
    return PinnedOut(
        id=pin.id,
        document_id=doc.id,
        number=doc.number,
        title=doc.title,
        type=doc.type,
        status=doc.status,
        pages=doc.pages,
        source_url=doc.source_url,
        pinned_at=pin.created_at,
    )

@router.delete("/{document_id}", status_code=204)
async def remove_pin(document_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(PinnedDocument).where(PinnedDocument.user_id == current_user.id, PinnedDocument.document_id == document_id))
    pin = res.scalar_one_or_none()
    if not pin:
        raise HTTPException(404, "Pin not found")
    await db.delete(pin)
    await db.commit()
    return None

@router.delete("", status_code=204)
async def clear_pins(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(PinnedDocument).where(PinnedDocument.user_id == current_user.id))
    for pin in res.scalars().all():
        await db.delete(pin)
    await db.commit()
    return None

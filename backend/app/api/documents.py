from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from app.core.db import get_db
from app.core.deps import get_current_user_optional
from app.models.document import Document, Chunk, CollectorLog
from app.models.user import User
from app.schemas.search import DocumentOut
from typing import List, Optional
import uuid
from fastapi.responses import FileResponse
from pathlib import Path
from sqlalchemy import or_

router = APIRouter(prefix="/api", tags=["documents"])

@router.get("/documents", response_model=List[DocumentOut])
async def list_documents(status: Optional[str] = None, skip: int = 0, limit: int = 50, db: AsyncSession = Depends(get_db), current_user: Optional[User] = Depends(get_current_user_optional)):
    # личная программа: показываем свои + общие (owner_id is NULL)
    base_filter = []
    if current_user:
        base_filter.append(or_(Document.owner_id == current_user.id, Document.owner_id.is_(None)))
    else:
        base_filter.append(Document.owner_id.is_(None))
    if status:
        base_filter.append(Document.status == status)

    # Batch chunk counts via subquery to avoid N+1
    chunk_count_subq = (
        select(Chunk.document_id, func.count().label("chunks_count"))
        .group_by(Chunk.document_id)
        .subquery()
    )

    q = (
        select(Document, chunk_count_subq.c.chunks_count)
        .outerjoin(chunk_count_subq, Document.id == chunk_count_subq.c.document_id)
        .where(*base_filter)
        .order_by(Document.updated_at.desc())
        .offset(skip)
        .limit(limit)
    )
    res = await db.execute(q)
    rows = res.all()

    out = []
    for doc, cnt in rows:
        out.append(DocumentOut(
            id=doc.id, number=doc.number, title=doc.title, type=doc.type, status=doc.status,
            version=doc.version, publication_date=doc.publication_date, pages=doc.pages,
            source_url=doc.source_url, last_checked_at=doc.last_checked_at, chunks_count=cnt or 0
        ))
    return out

@router.get("/documents/{doc_id}")
async def get_document(doc_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: Optional[User] = Depends(get_current_user_optional)):
    res = await db.execute(select(Document).where(Document.id == doc_id))
    doc = res.scalar_one_or_none()
    if not doc:
        raise HTTPException(404, "Document not found")
    if doc.owner_id is not None and (not current_user or doc.owner_id != current_user.id):
        raise HTTPException(403, "Доступ к чужому документу")
    # get chunks count
    cnt_res = await db.execute(select(func.count()).select_from(Chunk).where(Chunk.document_id == doc.id))
    cnt = cnt_res.scalar() or 0
    return {
        "id": str(doc.id),
        "number": doc.number,
        "title": doc.title,
        "type": doc.type,
        "category": doc.category,
        "status": doc.status,
        "version": doc.version,
        "publication_date": doc.publication_date,
        "effective_date": doc.effective_date,
        "pages": doc.pages,
        "source_url": doc.source_url,
        "pdf_path": doc.pdf_path,
        "language": doc.language,
        "last_checked_at": doc.last_checked_at,
        "created_at": doc.created_at,
        "chunks_count": cnt,
        "replaced_by": str(doc.replaced_by_id) if doc.replaced_by_id else None
    }

@router.get("/documents/{doc_id}/pdf")
async def get_pdf(doc_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: Optional[User] = Depends(get_current_user_optional)):
    res = await db.execute(select(Document).where(Document.id == doc_id))
    doc = res.scalar_one_or_none()
    if not doc or not doc.pdf_path:
        raise HTTPException(404, "PDF not found")
    if doc.owner_id is not None and (not current_user or doc.owner_id != current_user.id):
        raise HTTPException(403, "Доступ к чужому документу")
    p = Path(doc.pdf_path)
    if not p.exists():
        # also try relative to storage
        alt = Path(__file__).resolve().parent.parent.parent / "storage" / "pdfs" / p.name
        if alt.exists():
            p = alt
        else:
            raise HTTPException(404, f"PDF file missing: {p}")
    return FileResponse(str(p), media_type="application/pdf", filename=p.name)

@router.get("/documents/{doc_id}/chunks")
async def list_chunks(doc_id: uuid.UUID, skip: int = 0, limit: int = 20, db: AsyncSession = Depends(get_db), current_user: Optional[User] = Depends(get_current_user_optional)):
    # check owner
    doc_res = await db.execute(select(Document).where(Document.id == doc_id))
    doc = doc_res.scalar_one_or_none()
    if doc and doc.owner_id is not None and (not current_user or doc.owner_id != current_user.id):
        raise HTTPException(403, "Доступ к чужому документу")
    res = await db.execute(select(Chunk).where(Chunk.document_id == doc_id).order_by(Chunk.page, Chunk.paragraph).offset(skip).limit(limit))
    chunks = res.scalars().all()
    return [{
        "id": str(c.id), "paragraph": c.paragraph, "section": c.section, "chapter": c.chapter,
        "page": c.page, "text": c.text, "type": c.type, "token_count": c.token_count
    } for c in chunks]

@router.get("/stats")
async def stats(db: AsyncSession = Depends(get_db), current_user: Optional[User] = Depends(get_current_user_optional)):
    # персонально: считаем свои + общие
    base_q = select(Document)
    if current_user:
        base_q = base_q.where(or_(Document.owner_id == current_user.id, Document.owner_id.is_(None)))
    else:
        base_q = base_q.where(Document.owner_id.is_(None))
    total_docs = (await db.execute(select(func.count()).select_from(base_q.subquery()))).scalar() or 0
    # chunks via join
    chunk_q = select(func.count()).select_from(Chunk).join(Document, Chunk.document_id == Document.id)
    if current_user:
        chunk_q = chunk_q.where(or_(Document.owner_id == current_user.id, Document.owner_id.is_(None)))
    else:
        chunk_q = chunk_q.where(Document.owner_id.is_(None))
    total_chunks = (await db.execute(chunk_q)).scalar() or 0
    active_q = select(func.count()).select_from(Document).where(Document.status=="active")
    if current_user:
        active_q = active_q.where(or_(Document.owner_id == current_user.id, Document.owner_id.is_(None)))
    else:
        active_q = active_q.where(Document.owner_id.is_(None))
    active_docs = (await db.execute(active_q)).scalar() or 0
    # last collector log
    res = await db.execute(select(CollectorLog).order_by(CollectorLog.created_at.desc()).limit(1))
    last = res.scalar_one_or_none()
    return {
        "total_documents": total_docs,
        "active_documents": active_docs,
        "total_chunks": total_chunks,
        "last_collector": {"status": last.status, "details": last.details, "created_at": last.created_at} if last else None
    }

@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(select(1))
        db_ok = True
    except Exception as e:
        db_ok = False
    return {"status": "ok" if db_ok else "db_error", "db": db_ok}

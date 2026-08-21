from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.db import get_db
from app.core.deps import get_current_user, require_admin
from app.models.document import CollectorLog, Document
from app.pipeline.extractor import PDFExtractor
from app.pipeline.chunker import SNIPChunker
from app.embeddings.provider import get_embedding_provider
from app.pipeline.indexer import DocumentIndexer
from pathlib import Path
from app.config import PDF_DIR
import re
import uuid
import hashlib

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Max upload size: 100 MB
MAX_UPLOAD_BYTES = 100 * 1024 * 1024


def _sanitize_filename(name: str) -> str:
    """Strip path components and dangerous characters from upload filename."""
    # Take only the basename (strip any directory path — prevents traversal)
    name = Path(name).name
    # Replace anything that isn't alphanumeric, dash, underscore, or dot
    name = re.sub(r'[^\w\-.]', '_', name)
    # Collapse multiple underscores
    name = re.sub(r'_{2,}', '_', name).strip('_.')
    # Ensure it ends with .pdf
    if not name.lower().endswith('.pdf'):
        name += '.pdf'
    # Limit length
    if len(name) > 200:
        name = name[:195] + '.pdf'
    return name or f'document_{uuid.uuid4().hex[:8]}.pdf'

@router.get("/collector/logs")
async def collector_logs(limit: int = 20, db: AsyncSession = Depends(get_db), current_user=Depends(__import__("app.core.deps", fromlist=["require_admin"]).require_admin)):
    res = await db.execute(select(CollectorLog).order_by(CollectorLog.created_at.desc()).limit(limit))
    logs = res.scalars().all()
    return [{"id": str(l.id), "source": l.source, "status": l.status, "details": l.details, "documents_found": l.documents_found, "documents_new": l.documents_new, "created_at": l.created_at} for l in logs]

@router.post("/collector/run")
async def run_collector(db: AsyncSession = Depends(get_db), current_user=Depends(__import__("app.core.deps", fromlist=["require_admin"]).require_admin)):
    from app.collector.scheduler import run_collector_job
    import asyncio
    asyncio.create_task(run_collector_job())
    return {"status": "started"}

@router.post("/documents/upload")
async def upload_document(
    file: UploadFile = File(...),
    doc_number: str = Form(None),
    title: str = Form(None),
    doc_type: str = Form("НТД"),
    status: str = Form("active"),
    source_url: str = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    filename_ok = (file.filename or "").strip().lower().endswith(".pdf")
    ctype_ok = (file.content_type or "").lower() in ("application/pdf", "application/x-pdf", "application/octet-stream")
    # allow if either name or mime says PDF (covers uppercase, missing ext but correct mime)
    if not (filename_ok or ctype_ok):
        raise HTTPException(400, "Only PDF files allowed")

    # Sanitize filename to prevent path traversal
    safe_name = _sanitize_filename(file.filename or "upload.pdf")
    dest = PDF_DIR / safe_name

    # Read file with size limit check
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Файл слишком большой — максимум {MAX_UPLOAD_BYTES // (1024*1024)} МБ")

    # ensure unique filename
    counter = 1
    base = dest.stem
    while dest.exists():
        dest = PDF_DIR / f"{base}_{counter}.pdf"
        counter += 1
    dest.write_bytes(content)

    # index — личный документ
    extractor = PDFExtractor()
    chunker = SNIPChunker()
    embedder = get_embedding_provider()
    indexer = DocumentIndexer(extractor, chunker, embedder)
    try:
        owner = getattr(current_user, 'id', None)
        doc = await indexer.index_pdf(db, dest, source_url=source_url, status=status, owner_id=owner)
        # override fields if provided
        if doc_number:
            doc.number = doc_number
        if title:
            doc.title = title
        if doc_type:
            doc.type = doc_type
        await db.commit()
        return {"status": "indexed", "document_id": str(doc.id), "number": doc.number, "chunks": "ok"}
    except Exception as e:
        await db.rollback()
        import traceback; traceback.print_exc()
        raise HTTPException(500, f"Indexing failed: {e}")

@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: str, db: AsyncSession = Depends(get_db), current_user=Depends(get_current_user)):
    try:
        uid = uuid.UUID(doc_id)
    except (ValueError, AttributeError):
        raise HTTPException(400, "Invalid id")
    res = await db.execute(select(Document).where(Document.id == uid))
    doc = res.scalar_one_or_none()
    if not doc:
        raise HTTPException(404, "Not found")
    # личная программа: чужой личный док нельзя удалить
    if doc.owner_id is not None and doc.owner_id != current_user.id:
        raise HTTPException(403, "Чужой документ")
    if doc.owner_id is None and not getattr(current_user, 'is_superuser', False):
        # общий эталон — удалять может только владелец сайта
        raise HTTPException(403, "Общий документ — только владелец")
    await db.delete(doc)
    await db.commit()
    return {"status": "deleted"}

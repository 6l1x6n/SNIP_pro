import uuid
import hashlib
import logging
from pathlib import Path
from datetime import datetime, date, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from app.models.document import Document, Chunk, DocumentVersion
from app.pipeline.extractor import PDFExtractor
from app.pipeline.chunker import SNIPChunker
from app.embeddings.provider import EmbeddingProvider
from app.config import settings
import re

logger = logging.getLogger(__name__)

class DocumentIndexer:
    def __init__(self, extractor: PDFExtractor, chunker: SNIPChunker, embedder: EmbeddingProvider):
        self.extractor = extractor
        self.chunker = chunker
        self.embedder = embedder

    def _guess_number_title(self, pdf_path: Path, extracted) -> tuple[str, str, str]:
        # из имени файла: СНиП_1.02.01-85_Инструкция...
        stem = pdf_path.stem
        # try to find pattern like 1.02.01-85 or СН РК ... in text first lines
        full_text_sample = " ".join([p.text[:500] for p in extracted.pages[:2]])
        # search for СН РК / СНиП / СП РК patterns
        m = re.search(r'(СН\s*РК|СП\s*РК|СНиП|ГОСТ|СТ\s*РК)[\s\-]*([\d\.\-]+\s*[\d]*)', full_text_sample + " " + stem, re.IGNORECASE)
        if m:
            num = f"{m.group(1).upper()} {m.group(2).strip()}"
        else:
            # fallback to stem
            num = stem[:100]
        title = extracted.title or stem.replace("_", " ")[:300]
        doc_type = "СНиП" if "СНиП" in num.upper() or "СНИП" in stem.upper() else "НТД"
        if "СН РК" in num.upper():
            doc_type = "СН РК"
        elif "СП РК" in num.upper():
            doc_type = "СП РК"
        return num, title, doc_type

    async def index_pdf(self, db: AsyncSession, pdf_path: Path, source_url: str = None, status: str = "active", publication_date: date = None, language: str = "ru", owner_id = None) -> Document:
        # checksum
        h = hashlib.sha256()
        with open(pdf_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        checksum = h.hexdigest()

        # check duplicate — для персональных доков учитываем owner_id
        dup_q = select(Document).where(Document.checksum == checksum)
        if owner_id is not None:
            dup_q = dup_q.where(Document.owner_id == owner_id)
        else:
            dup_q = dup_q.where(Document.owner_id.is_(None))
        res = await db.execute(dup_q)
        existing = res.scalar_one_or_none()
        if existing:
            existing.last_checked_at = datetime.now(timezone.utc)
            await db.commit()
            return existing

        extracted = self.extractor.extract(pdf_path)
        # if scanned -> try OCR? but for MVP skip (needs tesseract)
        if extracted.is_scanned:
            # attempt OCR if available, but not required
            try:
                extracted = self.extractor.extract_with_ocr(pdf_path)
            except Exception as e:
                logger.warning("OCR fallback failed: %s", e)

        raw_chunks = self.chunker.chunk_extracted(extracted)
        if not raw_chunks:
            raise ValueError(f"No chunks extracted from {pdf_path}")

        number, title, doc_type = self._guess_number_title(pdf_path, extracted)

        # ensure unique number — для персональных доков уникальность в рамках owner_id
        num_q = select(Document).where(Document.number == number)
        if owner_id is not None:
            num_q = num_q.where(Document.owner_id == owner_id)
        else:
            num_q = num_q.where(Document.owner_id.is_(None))
        res = await db.execute(num_q)
        if res.scalar_one_or_none():
            number = f"{number} ({checksum[:6]})"

        doc = Document(
            number=number,
            title=title[:1000],
            type=doc_type,
            status=status,
            pages=extracted.total_pages,
            source_url=source_url,
            pdf_path=str(pdf_path),
            checksum=checksum,
            language=language,
            publication_date=publication_date,
            last_checked_at=datetime.now(timezone.utc),
            owner_id=owner_id,
        )
        db.add(doc)
        await db.flush()  # get id

        # batch embed
        texts = [c.text for c in raw_chunks]
        # embed in batches of 16 to avoid OOM
        embeddings = []
        batch = 16
        for i in range(0, len(texts), batch):
            batch_texts = texts[i:i+batch]
            embs = await self.embedder.embed(batch_texts)
            embeddings.extend(embs)

        # create Chunk rows
        for rc, emb in zip(raw_chunks, embeddings):
            ch = Chunk(
                document_id=doc.id,
                paragraph=rc.paragraph,
                section=rc.section,
                chapter=rc.chapter,
                page=rc.page,
                text=rc.text,
                type=rc.type,
                token_count=rc.token_count,
                embedding=emb,  # pgvector will handle
                source_url=source_url,
            )
            db.add(ch)

        await db.commit()
        await db.refresh(doc)

        # update tsv via raw SQL — use russian + simple (covers KZ terms) for better recall
        # also create GIN trigram index if not exists (for typo tolerance)
        await db.execute(text("""
            UPDATE chunks SET text_tsv = to_tsvector('russian', coalesce(text,''))
            WHERE document_id = :did
        """), {"did": str(doc.id)})
        await db.commit()
        # ensure trigram index exists (for ILIKE/trigram fallback)
        try:
            await db.execute(text("CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm ON chunks USING gin (text gin_trgm_ops)"))
            await db.commit()
        except Exception:
            try:
                await db.rollback()
            except:
                pass

        # create version entry
        ver = DocumentVersion(document_id=doc.id, version="1.0", pdf_path=str(pdf_path), checksum=checksum, published_at=publication_date)
        db.add(ver)
        await db.commit()
        return doc

    async def reindex_document(self, db: AsyncSession, doc: Document, pdf_path: Path):
        # delete old chunks, re-extract
        await db.execute(text("DELETE FROM chunks WHERE document_id = :did"), {"did": str(doc.id)})
        await db.commit()
        # re-run without creating new Document
        extracted = self.extractor.extract(pdf_path)
        raw_chunks = self.chunker.chunk_extracted(extracted)
        texts = [c.text for c in raw_chunks]
        embeddings = []
        batch = 16
        for i in range(0, len(texts), batch):
            embs = await self.embedder.embed(texts[i:i+batch])
            embeddings.extend(embs)
        for rc, emb in zip(raw_chunks, embeddings):
            ch = Chunk(document_id=doc.id, paragraph=rc.paragraph, section=rc.section, chapter=rc.chapter, page=rc.page, text=rc.text, type=rc.type, token_count=rc.token_count, embedding=emb)
            db.add(ch)
        await db.commit()
        await db.execute(text("UPDATE chunks SET text_tsv = to_tsvector('russian', coalesce(text,'')) WHERE document_id = :did"), {"did": str(doc.id)})
        try:
            await db.execute(text("CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm ON chunks USING gin (text gin_trgm_ops)"))
        except Exception:
            pass
        doc.last_checked_at = datetime.now(timezone.utc)
        await db.commit()

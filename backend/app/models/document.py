import uuid
from datetime import datetime, date, timezone
from sqlalchemy import String, Text, Date, DateTime, Integer, ForeignKey, Enum, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from pgvector.sqlalchemy import Vector
from app.core.db import Base
from app.config import settings as _settings
import enum

def _utcnow():
    return datetime.now(timezone.utc)

class DocumentStatus(str, enum.Enum):
    active = "active"           # действует
    replaced = "replaced"       # заменён
    expired = "expired"         # утратил силу
    amended = "amended"         # изменён
    draft = "draft"             # проект
    archived = "archived"       # архив

class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    number: Mapped[str] = mapped_column(String(200), unique=True, index=True)  # СН РК 3.02-43-2012
    title: Mapped[str] = mapped_column(Text, nullable=False)
    title_kz: Mapped[str | None] = mapped_column(Text, nullable=True)
    type: Mapped[str | None] = mapped_column(String(50), nullable=True)  # СНиП, СН РК, СП РК, ГОСТ
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)  # отрасль
    status: Mapped[str] = mapped_column(String(20), default=DocumentStatus.active.value, index=True)
    version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    publication_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    language: Mapped[str] = mapped_column(String(10), default="ru")
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    pdf_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    checksum: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    replaced_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id"), nullable=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)

    chunks: Mapped[list["Chunk"]] = relationship("Chunk", back_populates="document", cascade="all, delete-orphan")
    replaced_by: Mapped["Document | None"] = relationship("Document", remote_side=[id], foreign_keys=[replaced_by_id])

class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    chapter: Mapped[str | None] = mapped_column(Text, nullable=True)
    section: Mapped[str | None] = mapped_column(Text, nullable=True)
    paragraph: Mapped[str | None] = mapped_column(String(100), nullable=True)  # e.g. "3.2.1" or "п. 5.4"
    subparagraph: Mapped[str | None] = mapped_column(String(100), nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_bbox: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    text: Mapped[str] = mapped_column(Text, nullable=False)
    text_tsv: Mapped[str | None] = mapped_column(Text, nullable=True)  # will use tsvector via trigger
    type: Mapped[str] = mapped_column(String(20), default="paragraph")  # paragraph|table|note
    embedding: Mapped[list[float] | None] = mapped_column(Vector(_settings.embedding_dim), nullable=True)  # dim from config (384 MiniLM / 768 Gemini)
    token_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    document: Mapped[Document] = relationship("Document", back_populates="chunks")

    __table_args__ = (
        Index("idx_chunks_document_id", "document_id"),
        Index("idx_chunks_paragraph", "paragraph"),
        # GIN index for tsvector will be added in migration (cannot do via ORM easily)
        # HNSW index for vector will be added in migration
    )

class DocumentVersion(Base):
    __tablename__ = "document_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"))
    version: Mapped[str] = mapped_column(String(50))
    change_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    pdf_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    checksum: Mapped[str | None] = mapped_column(String(128), nullable=True)
    published_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

class CollectorLog(Base):
    __tablename__ = "collector_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20))  # success|error|no_changes
    details: Mapped[str | None] = mapped_column(Text, nullable=True)
    documents_found: Mapped[int] = mapped_column(Integer, default=0)
    documents_new: Mapped[int] = mapped_column(Integer, default=0)
    documents_updated: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

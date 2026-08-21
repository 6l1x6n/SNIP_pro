from pydantic import BaseModel
from typing import Optional, List
from datetime import date, datetime
import uuid

class SearchRequest(BaseModel):
    query: str
    mode: str = "fast"  # fast|deep
    top_k: int = 10
    filters: Optional[dict] = None  # {type, status, year, language, document_id, section}

class SearchResultItem(BaseModel):
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    document_number: str
    document_title: str
    document_type: Optional[str] = None
    paragraph: Optional[str] = None
    section: Optional[str] = None
    chapter: Optional[str] = None
    page: Optional[int] = None
    text: str
    quote: str
    score: float
    relevance_percent: int
    relevance_label: str  # очень высокая|высокая|возможное|низкая
    status: str
    source_url: Optional[str] = None
    publication_date: Optional[date] = None
    last_checked_at: Optional[datetime] = None

class AnswerBlock(BaseModel):
    answer: str
    normative_basis: Optional[str] = None
    paragraph: Optional[str] = None
    page: Optional[int] = None
    quote: Optional[str] = None
    status: Optional[str] = None
    date_actual: Optional[str] = None
    is_grounded: bool = True

class SearchResponse(BaseModel):
    query: str
    mode: str
    answer: Optional[AnswerBlock] = None
    results: List[SearchResultItem]
    took_ms: int
    total_found: int
    message: Optional[str] = None

class DocumentOut(BaseModel):
    id: uuid.UUID
    number: str
    title: str
    type: Optional[str]
    status: str
    version: Optional[str]
    publication_date: Optional[date]
    pages: Optional[int]
    source_url: Optional[str]
    last_checked_at: Optional[datetime]
    chunks_count: Optional[int] = None

    class Config:
        from_attributes = True

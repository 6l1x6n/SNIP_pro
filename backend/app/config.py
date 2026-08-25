from pydantic_settings import BaseSettings
from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
PDF_DIR = STORAGE_DIR / "pdfs"

class Settings(BaseSettings):
    # DB
    database_url: str = "postgresql+asyncpg://alikhan@/snip_pro?host=/tmp"
    sync_database_url: str = "postgresql://alikhan@/snip_pro?host=/tmp"
    # Embedding
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"  # lightweight, ru/kz/en, 384d, fallback for MVP
    embedding_provider: str = ""  # "" авто | gemini | fastembed | sentence-transformers
    embedding_dim: int = 384
    gemini_api_key: str | None = None  # aistudio.google.com, free tier без карты (EMBEDDING_PROVIDER=gemini)
    gemini_embedding_model: str = "gemini-embedding-001"  # 768d (text-embedding-004 decommissioned 2026)
    # Резервные провайдеры эмбеддингов (цепочка «мощные → хорошие → средние»):
    jina_api_key: str | None = None     # jina.ai — trial ~10 млн токенов (jina-embeddings-v3, 1024d)
    voyage_api_key: str | None = None   # dashboard.voyageai.com — щедрый trial (voyage-multilingual-2, 1024d)
    cohere_api_key: str | None = None   # dashboard.cohere.com — trial ~1000 вызовов x 96 текстов (embed-multilingual-v3.0, 1024d)
    mistral_api_key: str | None = None  # console.mistral.ai — free тариф La Plateforme (mistral-embed, 1024d)
    embedding_device: str = "cpu"
    # LLM
    ollama_host: str = "http://localhost:11434"
    ollama_model: str = "qwen/qwen3.6-27b"  # groq current, was gemma4:e2b local
    groq_api_key: str | None = None
    groq_model: str | None = "qwen/qwen3.6-27b"  # was llama-3.1-8b-instant decommissioned 2025
    llm_temperature: float = 0.1
    # Search
    top_k_bm25: int = 50
    top_k_vector: int = 50
    top_k_rerank: int = 30
    top_k_final: int = 10
    # Fast/Deep split (headroom)
    top_k_bm25_fast: int = 50
    top_k_bm25_deep: int = 80
    top_k_vector_fast: int = 50
    top_k_vector_deep: int = 80
    top_k_rerank_fast: int = 30
    top_k_rerank_deep: int = 40
    llm_max_tokens_fast: int = 1000
    llm_max_tokens_deep: int = 1600
    llm_temp_fast: float = 0.1
    llm_temp_deep: float = 0.15
    # Collector
    collector_interval_hours: int = 24
    # Auth / Security
    secret_key: str = "change-me-please-generate-32+chars-secret"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 days for convenience MVP
    admin_email: str | None = None  # first user or this email becomes superuser
    require_auth: bool = False  # if True, /api/search requires login
    # Quota — безлимит по умолчанию для prod (Cloudflare Pages free)
    quota_enabled: bool = False  # if False, check_quota is no-op (безлимит)
    quota_anon_limit: int = 999999
    quota_registered_limit: int = 999999
    quota_window_hours: int = 24  # reserved for future window reset
    disable_db: bool = False  # if True, run without Postgres (mock mode for Pages)
    # App
    app_name: str = "SNIP_pro - Интеллектуальный справочник СНиП РК"
    version: str = "0.1.0"
    debug: bool = True
    cors_origins: str = "http://localhost:5173,http://localhost:3000,https://snippy-llm.pages.dev,https://*.pages.dev,https://snippy-llm.workers.dev,https://*.workers.dev,https://*.onrender.com"

    model_config = {"extra": "ignore", "env_file": str(BASE_DIR / ".env"), "env_file_encoding": "utf-8"}

    def model_post_init(self, __context) -> None:
        """Validate critical security settings after initialization."""
        _DEFAULT_SECRET = "change-me-please-generate-32+chars-secret"
        if self.secret_key == _DEFAULT_SECRET:
            import warnings
            warnings.warn(
                "⚠️  SECURITY: secret_key is using the default value! "
                "Set a real SECRET_KEY in your .env file. "
                "JWT tokens signed with the default key are forgeable.",
                stacklevel=2,
            )
        # Gemini embedding: 768d — не даём случайно смешать 384d-колонку с 768d-векторами
        if self.embedding_provider == "gemini" and self.embedding_dim == 384 and self.gemini_api_key:
            import sys
            print("ℹ️  EMBEDDING_PROVIDER=gemini: embedding_dim 384 → 768 (gemini-embedding-001). "
                  "БД с векторами 384d требует переиндексации.", file=sys.stderr)
            self.embedding_dim = 768

settings = Settings()
PDF_DIR.mkdir(parents=True, exist_ok=True)
(STORAGE_DIR / "chunks").mkdir(parents=True, exist_ok=True)

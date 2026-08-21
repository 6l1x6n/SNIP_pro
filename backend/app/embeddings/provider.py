from abc import ABC, abstractmethod
from typing import List
import numpy as np

class EmbeddingProvider(ABC):
    @abstractmethod
    async def embed(self, texts: List[str]) -> List[List[float]]:
        pass

    @abstractmethod
    async def embed_query(self, query: str) -> List[float]:
        pass

    @property
    @abstractmethod
    def dim(self) -> int:
        pass

class OllamaEmbeddingProvider(EmbeddingProvider):
    """Использует Ollama /api/embed - бесплатно, локально, поддерживает nomic-embed-text, bge-m3"""
    def __init__(self, host: str = "http://localhost:11434", model: str = "nomic-embed-text", dim: int = 768):
        import httpx
        self.host = host.rstrip("/")
        self.model = model
        self._dim = dim
        self._client = httpx.AsyncClient(timeout=60)

    @property
    def dim(self) -> int:
        return self._dim

    async def embed(self, texts: List[str]) -> List[List[float]]:
        import httpx
        results = []
        for t in texts:
            r = await self._client.post(f"{self.host}/api/embed", json={"model": self.model, "input": t})
            if r.status_code == 404:
                # fallback to /api/embeddings for older ollama
                r = await self._client.post(f"{self.host}/api/embeddings", json={"model": self.model, "prompt": t})
                data = r.json()
                results.append(data["embedding"])
            else:
                r.raise_for_status()
                data = r.json()
                # Ollama /api/embed returns {"embeddings": [[...]]}
                if "embeddings" in data:
                    results.append(data["embeddings"][0])
                elif "embedding" in data:
                    results.append(data["embedding"])
                else:
                    raise ValueError(f"Unexpected embedding response: {data}")
        return results

    async def embed_query(self, query: str) -> List[float]:
        embs = await self.embed([query])
        return embs[0]

class GeminiEmbeddingProvider(EmbeddingProvider):
    """Google text-embedding-004 через REST (free tier, без карты).
    Для хостингов с 512MB RAM: ноль RAM под модель против ~900MB у локального ONNX."""
    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, api_key: str, model: str = "text-embedding-004", dim: int = 768):
        import httpx
        self.api_key = api_key
        self.model = model
        self._dim = dim
        self._client = httpx.AsyncClient(timeout=60)

    @property
    def dim(self) -> int:
        return self._dim

    def _normalize(self, vectors: List[List[float]]) -> List[List[float]]:
        arr = np.array(vectors, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        arr = arr / np.maximum(norms, 1e-12)
        return arr.tolist()

    async def _batch(self, requests: List[dict]) -> List[List[float]]:
        import asyncio
        url = f"{self.BASE_URL}/{self.model}:batchEmbedContents"
        # API требует поле model в каждом запросе батча
        for req in requests:
            req["model"] = f"models/{self.model}"
        # retry с backoff: free tier режет по RPM
        delay = 10
        for attempt in range(5):
            r = await self._client.post(url, params={"key": self.api_key}, json={"requests": requests})
            if r.status_code == 429:
                retry_after = r.headers.get("retry-after")
                wait = float(retry_after) if retry_after else delay
                await asyncio.sleep(min(wait, 60))
                delay = min(delay * 2, 60)
                continue
            r.raise_for_status()
            data = r.json()
            return [e["values"] for e in data["embeddings"]]
        r.raise_for_status()
        raise RuntimeError("gemini batch: retries exhausted")

    async def embed(self, texts: List[str]) -> List[List[float]]:
        reqs = [
            {
                "taskType": "RETRIEVAL_DOCUMENT",
                "content": {"parts": [{"text": t[:8000]}]},
                "outputDimensionality": self._dim,
            }
            for t in texts
        ]
        out: List[List[float]] = []
        # лимит API: 100 запросов на batchEmbedContents
        for i in range(0, len(reqs), 100):
            out.extend(await self._batch(reqs[i : i + 100]))
            if i + 100 < len(reqs):
                await asyncio.sleep(2)
        return self._normalize(out)

    async def embed_query(self, query: str) -> List[float]:
        import asyncio
        url = f"{self.BASE_URL}/{self.model}:embedContent"
        payload = {
            "taskType": "RETRIEVAL_QUERY",
            "content": {"parts": [{"text": query}]},
            "outputDimensionality": self._dim,
        }
        delay = 5
        for attempt in range(4):
            r = await self._client.post(url, params={"key": self.api_key}, json=payload)
            if r.status_code == 429:
                retry_after = r.headers.get("retry-after")
                await asyncio.sleep(float(retry_after) if retry_after else delay)
                delay = min(delay * 2, 30)
                continue
            r.raise_for_status()
            return self._normalize([r.json()["embedding"]["values"]])[0]
        r.raise_for_status()
        raise RuntimeError("gemini embed_query: retries exhausted")

class FastEmbedProvider(EmbeddingProvider):
    """ONNX-рантайм fastembed: та же модель MiniLM-L12-v2 384d без torch (~200MB RAM вместо ~800MB)"""
    def __init__(self, model_name: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"):
        self.model_name = model_name
        # lazy load
        self._model = None
        self._dim = None

    def _ensure(self):
        if self._model is None:
            from fastembed import TextEmbedding
            self._model = TextEmbedding(model_name=self.model_name)
            self._dim = len(next(iter(self._model.query_embed("dim probe"))))

    @property
    def dim(self) -> int:
        if self._dim is None:
            self._ensure()
        return self._dim

    async def embed(self, texts: List[str]) -> List[List[float]]:
        self._ensure()
        import asyncio
        loop = asyncio.get_event_loop()
        def _encode():
            embs = np.array(list(self._model.embed(texts)))
            norms = np.linalg.norm(embs, axis=1, keepdims=True)
            embs = embs / np.maximum(norms, 1e-12)
            return embs.tolist()
        return await loop.run_in_executor(None, _encode)

    async def embed_query(self, query: str) -> List[float]:
        embs = await self.embed([query])
        return embs[0]

class SentenceTransformerProvider(EmbeddingProvider):
    """Локальный через sentence-transformers, предпочтительно для офлайн"""
    def __init__(self, model_name: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", device: str = "cpu"):
        from sentence_transformers import SentenceTransformer
        self.model_name = model_name
        self.device = device
        # lazy load
        self._model = None
        self._dim = None

    def _ensure(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name, device=self.device)
            self._dim = self._model.get_sentence_embedding_dimension()

    @property
    def dim(self) -> int:
        if self._dim is None:
            self._ensure()
        return self._dim

    async def embed(self, texts: List[str]) -> List[List[float]]:
        self._ensure()
        # run in thread to not block event loop
        import asyncio
        loop = asyncio.get_event_loop()
        def _encode():
            embs = self._model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
            return embs.tolist()
        return await loop.run_in_executor(None, _encode)

    async def embed_query(self, query: str) -> List[float]:
        embs = await self.embed([query])
        return embs[0]

# Фабрика
def get_embedding_provider(model_name: str = None, device: str = "cpu") -> EmbeddingProvider:
    from app.config import settings
    name = model_name or settings.embedding_model
    provider = getattr(settings, "embedding_provider", "") or ""
    # явный выбор через EMBEDDING_PROVIDER=gemini (free-tier хостинг 512MB: без локальной модели)
    if provider == "gemini":
        if not settings.gemini_api_key:
            raise ValueError("EMBEDDING_PROVIDER=gemini требует GEMINI_API_KEY (бесплатно: aistudio.google.com)")
        return GeminiEmbeddingProvider(
            api_key=settings.gemini_api_key,
            model=settings.gemini_embedding_model,
            dim=settings.embedding_dim,
        )
    # явный выбор через EMBEDDING_PROVIDER=fastembed (для free-tier хостингов 512MB RAM)
    if provider == "fastembed":
        return FastEmbedProvider(model_name=name)
    # если указано ollama: префикс
    if name.startswith("ollama:"):
        parts = name.split(":")
        ollama_model = parts[1] if len(parts) > 1 else "nomic-embed-text"
        # dim зависит от модели: nomic=768, bge-m3=1024, mxbai=1024
        dim_map = {"nomic-embed-text": 768, "bge-m3": 1024, "mxbai-embed-large": 1024}
        return OllamaEmbeddingProvider(host=settings.ollama_host, model=ollama_model, dim=dim_map.get(ollama_model, 768))
    if name.startswith("fastembed:"):
        return FastEmbedProvider(model_name=name.split(":", 1)[1])
    if provider == "sentence-transformers":
        return SentenceTransformerProvider(model_name=name, device=device)
    # авто: fastembed если sentence-transformers не установлен
    try:
        import sentence_transformers  # noqa: F401
    except ImportError:
        return FastEmbedProvider(model_name=name)
    return SentenceTransformerProvider(model_name=name, device=device)

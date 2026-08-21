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
    # если указано ollama: префикс
    if name.startswith("ollama:"):
        parts = name.split(":")
        ollama_model = parts[1] if len(parts) > 1 else "nomic-embed-text"
        # dim зависит от модели: nomic=768, bge-m3=1024, mxbai=1024
        dim_map = {"nomic-embed-text": 768, "bge-m3": 1024, "mxbai-embed-large": 1024}
        return OllamaEmbeddingProvider(host=settings.ollama_host, model=ollama_model, dim=dim_map.get(ollama_model, 768))
    else:
        return SentenceTransformerProvider(model_name=name, device=device)

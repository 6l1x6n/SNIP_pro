import httpx
from typing import List, Dict, Optional
from app.config import settings

SYSTEM_PROMPT = """Ты — эксперт по строительным нормам Казахстана (СНиП, СН РК, СП РК, ТНПА).
Отвечай ТОЛЬКО на основе предоставленного КОНТЕКСТА из нормативных документов.

Правила:
- Если в КОНТЕКСТЕ нет ответа — скажи ровно: "В доступной нормативной базе точного требования не найдено."
- Не придумывай пункты, цифры, названия документов. Используй только те, что в КОНТЕКСТЕ.
- Отделяй своё объяснение от дословной цитаты. Цитата должна быть точной выдержкой.
- Указывай документ, пункт и страницу.
- Если есть противоречия между документами — покажи оба и объясни, какой статус актуальнее (действует/заменён).
- Пиши на языке запроса (русский/казахский)."""

class LLMProvider:
    def __init__(self, host: str = None, model: str = None):
        # Groq support: if GROQ_API_KEY set, use groq_model or ollama_model as groq model
        groq_key = getattr(settings, "groq_api_key", None)
        groq_model = getattr(settings, "groq_model", None)
        self.host = (host or settings.ollama_host).rstrip("/")
        # if groq key present and host is groq, use groq_model
        if groq_key and "groq.com" in self.host:
            self.model = model or groq_model or settings.ollama_model
            # map legacy models to current groq models (decommissioned 2025)
            if self.model in ("gemma4:e2b", "llama-3.1-8b-instant", "llama3-8b-8192"):
                self.model = groq_model or "qwen/qwen3.6-27b"
        else:
            self.model = model or settings.ollama_model

    async def generate(self, prompt: str, system: str = SYSTEM_PROMPT, temperature: float = 0.1, max_tokens: int = 1000) -> str:
        # headers for Groq
        headers = {}
        groq_key = getattr(settings, "groq_api_key", None)
        if groq_key and "groq.com" in self.host:
            headers["Authorization"] = f"Bearer {groq_key}"
        # handle double /v1
        if self.host.endswith("/v1"):
            chat_url = f"{self.host}/chat/completions"
        else:
            chat_url = f"{self.host}/v1/chat/completions"
        async with httpx.AsyncClient(timeout=120) as client:
            # Try OpenAI-compatible /v1/chat/completions (Groq + Ollama supports)
            try:
                resp = await client.post(chat_url, headers=headers, json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": temperature,
                    "max_tokens": max_tokens
                })
                if resp.status_code == 200:
                    data = resp.json()
                    content = data["choices"][0]["message"]["content"]
                    # strip <think> chain-of-thought from qwen (robust, with/without closing tag)
                    if "<think>" in content:
                        import re as _re
                        content = _re.sub(r"<think>.*?(?:</think>\s*|$)", "", content, flags=_re.S)
                        content = content.replace("<think>", "").replace("</think>", "")
                    return content.strip()
                # handle rate limit 429 with retry once
                if resp.status_code == 429:
                    import asyncio
                    retry_after = int(resp.headers.get("retry-after", "2"))
                    await asyncio.sleep(min(retry_after, 5))
                    resp2 = await client.post(chat_url, headers=headers, json={
                        "model": self.model,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt}
                        ],
                        "temperature": temperature,
                        "max_tokens": max_tokens
                    })
                    if resp2.status_code == 200:
                        _c = resp2.json()["choices"][0]["message"]["content"]
                        if "<think>" in _c:
                            import re as _re2
                            _c = _re2.sub(r"<think>.*?(?:</think>\s*|$)", "", _c, flags=_re2.S)
                            _c = _c.replace("<think>", "").replace("</think>", "")
                        return _c.strip()
            except Exception as e:
                # if groq, don't fallback to Ollama /api/chat
                if groq_key and "groq.com" in self.host:
                    raise
                pass
            # Fallback to /api/chat (Ollama native)
            try:
                resp = await client.post(f"{self.host}/api/chat", json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt}
                    ],
                    "stream": False,
                    "options": {"temperature": temperature, "num_predict": max_tokens}
                })
                resp.raise_for_status()
                return resp.json()["message"]["content"]
            except Exception as e:
                # Fallback to /api/generate
                resp = await client.post(f"{self.host}/api/generate", json={
                    "model": self.model,
                    "prompt": f"System: {system}\n\nUser: {prompt}",
                    "stream": False,
                    "options": {"temperature": temperature}
                })
                resp.raise_for_status()
                return resp.json()["response"]

    async def expand_query(self, query: str) -> List[str]:
        """Генерирует 3-5 парафразов для расширения поиска (синонимы)"""
        prompt = f"""Для строительного запроса сгенерируй 4 синонимичных формулировок, включая профессиональные термины и сокращения.
Запрос: "{query}"
Верни только список, по одной на строку, без нумерации. Используй термины: коридор/проход/эвакуационный путь, лестница/марш/лестничная клетка и т.п. если релевантно."""
        try:
            out = await self.generate(prompt, system="Ты помощник для расширения поисковых запросов. Возвращай только парафразы.", temperature=0.3, max_tokens=300)
            lines = [l.strip(" -•1234567890.") for l in out.strip().split("\n") if l.strip()]
            # filter empty and limit
            expanded = [l for l in lines if len(l) > 10][:4]
            return expanded
        except Exception as e:
            return []

    async def rerank_explain(self, query: str, chunks: List[Dict]) -> Optional[str]:
        """Опционально: LLM rerank explanation, не используется в fast mode"""
        return None

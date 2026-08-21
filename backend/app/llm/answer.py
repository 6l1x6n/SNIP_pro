from typing import List, Dict, Optional
from app.llm.provider import LLMProvider
from app.schemas.search import AnswerBlock
from app.config import settings
from datetime import datetime
import re

# Anti-hallucination: check quote is substring of context
def quote_grounded(quote: str, contexts: List[str], threshold: float = 0.85) -> bool:
    if not quote or len(quote.strip()) < 10:
        return False
    q = re.sub(r'\s+', ' ', quote.strip().lower())
    for ctx in contexts:
        c = re.sub(r'\s+', ' ', ctx.lower())
        if q in c:
            return True
        # fuzzy: check if 85% of quote words present consecutively
        # simple sliding
        q_words = q.split()
        c_words = c.split()
        if len(q_words) < 5:
            continue
        for i in range(len(c_words) - len(q_words) + 1):
            match = sum(1 for a,b in zip(q_words, c_words[i:i+len(q_words)]) if a==b)
            if match / len(q_words) >= threshold:
                return True
    return False

class AnswerService:
    def __init__(self, llm: LLMProvider = None):
        self.llm = llm or LLMProvider()

    async def generate_answer(self, query: str, top_chunks: List[Dict], mode: str = "fast") -> Optional[AnswerBlock]:
        """
        top_chunks: list of {chunk, document, score, paragraph, page, text, quote}
        Returns AnswerBlock with grounding.
        """
        if not top_chunks:
            return AnswerBlock(answer="В доступной нормативной базе точного требования не найдено.", is_grounded=False)

        # Build context — deep uses more chunks and longer text
        is_deep = mode == "deep"
        max_chunks = 7 if is_deep else 3
        txt_limit = 1500 if is_deep else 1200
        context_blocks = []
        contexts_texts = []
        for i, ch in enumerate(top_chunks[:max_chunks]):
            doc_title = ch.get("document_title") or ch.get("document_number") or "Документ"
            para = ch.get("paragraph") or "—"
            page = ch.get("page") or "—"
            txt = ch.get("text") or ch.get("quote") or ""
            status = ch.get("status") or "действует"
            context_blocks.append(f"[{i+1}] Документ: {doc_title} ({ch.get('document_number')})\nПункт: {para}, Стр: {page}, Статус: {status}\nТекст: \"{txt[:txt_limit]}\"")
            contexts_texts.append(txt)

        context_str = "\n\n".join(context_blocks)

        if is_deep:
            prompt = f"""КОНТЕКСТ (5-7 выдержек из РАЗНЫХ нормативов):
{context_str}

ЗАПРОС: "{query}"

Задача ГЛУБОКОГО АНАЛИЗА:
1. Сравни выдержки из 2-3 документов, укажи совпадения и противоречия, приоритет по статусу (действует > заменён > утратил силу).
2. Синтезируй ответ 4-7 предложений, опираясь ТОЛЬКО на КОНТЕКСТ.
3. Укажи 2-3 нормативных основания (документ, пункт, страница) и дословные цитаты.
4. Если данных нет — "В доступной нормативной базе точного требования не найдено."
5. ВАЖНО: отвечай ТОЛЬКО JSON без markdown, без ```json, без комментариев.

Формат строго JSON:
{{
  "answer": "развёрнутый анализ 4-7 предложений",
  "normative_basis": "основной документ + доп. через '; '",
  "paragraph": "5.8",
  "page": 42,
  "quote": "дословная цитата главного пункта",
  "status": "действует"
}}"""
            max_tokens = settings.llm_max_tokens_deep
            temp = settings.llm_temp_deep
        else:
            prompt = f"""КОНТЕКСТ (выдержки из нормативов):
{context_str}

ЗАПРОС ПОЛЬЗОВАТЕЛЯ: "{query}"

Задача:
1. Ответь кратко (2-4 предложения) на запрос, опираясь ТОЛЬКО на КОНТЕКСТ.
2. Укажи нормативное основание (документ), пункт, страницу, дословную цитату.
3. Если в контексте нет ответа — скажи ровно "В доступной нормативной базе точного требования не найдено."
4. ВАЖНО: отвечай ТОЛЬКО JSON без markdown, без ```json, без комментариев.

Формат ответа (строго JSON):
{{
  "answer": "краткое объяснение",
  "normative_basis": "название документа",
  "paragraph": "номер пункта",
  "page": 12,
  "quote": "дословная цитата из контекста",
  "status": "действует"
}}"""
            max_tokens = settings.llm_max_tokens_fast
            temp = settings.llm_temp_fast

        try:
            raw = await self.llm.generate(prompt, max_tokens=max_tokens, temperature=temp)
            # try to extract JSON — strip markdown fences first
            import json
            clean = re.sub(r'```(?:json)?', '', raw).replace('```','').strip()
            # handle truncated or extra text before/after JSON
            m = re.search(r'\{.*\}', clean, re.DOTALL)
            j = None
            if not m:
                # fallback: try to extract "answer": "..." even if JSON truncated
                am = re.search(r'"answer"\s*:\s*"([^"]+)"', clean, re.DOTALL)
                if am:
                    ans_direct = am.group(1)
                    j = {"answer": ans_direct}
                    for key in ["normative_basis", "paragraph", "page", "quote", "status"]:
                        km = re.search(rf'"{key}"\s*:\s*"([^"]*)"', clean)
                        if km:
                            j[key] = km.group(1)
                        else:
                            km2 = re.search(rf'"{key}"\s*:\s*(\d+)', clean)
                            if km2:
                                try:
                                    j[key] = int(km2.group(1))
                                except:
                                    j[key] = km2.group(1)
            if j is None and m:
                j_raw = m.group(0)
                # fix common LLM JSON errors: trailing commas
                j_raw = re.sub(r',\s*}', '}', j_raw)
                j_raw = re.sub(r',\s*]', ']', j_raw)
                try:
                    j = json.loads(j_raw)
                except Exception as e:
                    # try direct extraction as fallback
                    am = re.search(r'"answer"\s*:\s*"([^"]+)"', j_raw, re.DOTALL)
                    if am:
                        j = {"answer": am.group(1)}
                        for key in ["normative_basis", "paragraph", "page", "quote", "status"]:
                            km = re.search(rf'"{key}"\s*:\s*"([^"]*)"', j_raw)
                            if km:
                                j[key] = km.group(1)
                            else:
                                km2 = re.search(rf'"{key}"\s*:\s*(\d+)', j_raw)
                                if km2:
                                    try:
                                        j[key] = int(km2.group(1))
                                    except:
                                        j[key] = km2.group(1)
                        pass
                    else:
                        # fallback: try to find smallest valid JSON
                        try:
                            j = json.loads(re.search(r'\{[^{}]*\{.*\}[^{}]*\}', clean, re.DOTALL).group(0)) if re.search(r'\{[^{}]*\{.*\}[^{}]*\}', clean, re.DOTALL) else json.loads(j_raw)
                        except Exception as e2:
                            raise
                quote = j.get("quote", "") if j else ""
            if j is not None:
                quote = j.get("quote", "")
                # grounding check
                if quote and not quote_grounded(quote, contexts_texts):
                    quote = contexts_texts[0][:300]
                    j["quote"] = quote
                ans_text = j.get("answer") or j.get("ответ") or j.get("Answer") or ""
                if not ans_text or "```" in ans_text:
                    ans_text = re.sub(r'```.*?```', '', str(ans_text), flags=re.DOTALL).strip() or str(j.get("answer","")).strip()
                    ans_text = re.sub(r'^```(?:json)?\s*', '', ans_text).replace('```','').strip()
                if ans_text.strip().startswith('{') and '"answer"' in ans_text:
                    try:
                        inner_m = re.search(r'\{.*\}', ans_text, re.DOTALL)
                        if inner_m:
                            inner_j = json.loads(re.sub(r',\s*}', '}', re.sub(r',\s*]', ']', inner_m.group(0))))
                            if inner_j.get("answer"):
                                ans_text = str(inner_j.get("answer")).strip()
                    except:
                        pass
                ans_text = re.sub(r'^```(?:json)?\s*', '', ans_text).replace('```','').strip()
                low = ans_text.lower()
                is_not_found = any(p in low for p in ["не найдено", "не содержится", "нет информации", "не предоставлено", "не содержит", "не найден"]) or "не найдено" in quote.lower()
                top = top_chunks[0]
                if is_not_found:
                    return AnswerBlock(answer="В доступной нормативной базе точного требования не найдено.", is_grounded=False)
                basis = j.get("normative_basis") or j.get("basis") or top.get("document_title") or top.get("document_number")
                para = j.get("paragraph")
                if not para or str(para).strip() in ["—", "-", "", "null", "None"]:
                    para = top.get("paragraph")
                pg = j.get("page")
                try:
                    pg = int(pg) if pg not in [None, "", "—", "null"] else top.get("page")
                except:
                    pg = top.get("page")
                return AnswerBlock(
                    answer=ans_text[:800] if ans_text else re.sub(r'```.*?```','',clean, flags=re.DOTALL).strip()[:500],
                    normative_basis=basis,
                    paragraph=para,
                    page=pg,
                    quote=j.get("quote"),
                    status=j.get("status") or top.get("status"),
                    date_actual=datetime.utcnow().strftime("%d.%m.%Y"),
                    is_grounded=True
                )
            else:
                # no JSON, return raw as answer with top chunk grounding — strip fences
                top = top_chunks[0]
                clean_raw = re.sub(r'```.*?```', '', clean, flags=re.DOTALL).strip()
                if "не найдено" in clean_raw.lower():
                    return AnswerBlock(answer="В доступной нормативной базе точного требования не найдено.", is_grounded=False)
                # if clean still looks like JSON, try to extract answer again
                return AnswerBlock(
                    answer=clean_raw[:800],
                    normative_basis=top.get("document_title") or top.get("document_number"),
                    paragraph=top.get("paragraph"),
                    page=top.get("page"),
                    quote=top.get("text","")[:500],
                    status=top.get("status"),
                    date_actual=datetime.utcnow().strftime("%d.%m.%Y"),
                    is_grounded=True
                )
        except Exception as e:
            # fallback to top chunk
            top = top_chunks[0]
            return AnswerBlock(
                answer=f"Найдено релевантное требование в документе {top.get('document_number')}, пункт {top.get('paragraph') or '—'}. См. цитату ниже.",
                normative_basis=top.get("document_title") or top.get("document_number"),
                paragraph=top.get("paragraph"),
                page=top.get("page"),
                quote=top.get("text","")[:500],
                status=top.get("status"),
                date_actual=datetime.utcnow().strftime("%d.%m.%Y"),
                is_grounded=True
            )

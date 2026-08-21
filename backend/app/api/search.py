import time
import logging
import traceback
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.core.db import get_db
from app.schemas.search import SearchRequest, SearchResponse, SearchResultItem, AnswerBlock
from app.search.hybrid import HybridSearchService
from app.embeddings.provider import get_embedding_provider
from app.llm.answer import AnswerService
from app.config import settings
from app.core.deps import get_current_user_optional
from app.core.quota import check_quota
from app.models.user import User
from app.models.document import Chunk

logger = logging.getLogger(__name__)

limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/api", tags=["search"])

# Lazy singleton providers
_embedder = None
_search_service = None
_answer_service = None

def get_embedder():
    global _embedder
    if _embedder is None:
        _embedder = get_embedding_provider()
    return _embedder

def get_search_service():
    global _search_service
    if _search_service is None:
        _search_service = HybridSearchService(embedder=get_embedder())
    return _search_service

def get_answer_service():
    global _answer_service
    if _answer_service is None:
        from app.llm.provider import LLMProvider
        _answer_service = AnswerService(llm=LLMProvider())
    return _answer_service

@router.post("/search", response_model=SearchResponse)
@limiter.limit("30/minute")
async def search(request: Request, req: SearchRequest, db: AsyncSession = Depends(get_db), current_user: User | None = Depends(get_current_user_optional), response: Response = None):
    if settings.require_auth and not current_user:
        raise HTTPException(status_code=401, detail="Требуется вход")
    # --- Quota check (anonymous: 30/device, registered: 200/user) ---
    quota_info = check_quota(request, current_user)
    if not req.query or len(req.query.strip()) < 2:
        raise HTTPException(status_code=400, detail="Query too short")
    start = time.time()
    # личная программа: ищем в своих + общих эталонах
    search_filters = dict(req.filters) if req.filters else {}
    if current_user:
        search_filters["owner_id"] = str(current_user.id)
    else:
        search_filters["owner_id"] = None

    search_svc = get_search_service()
    try:
        results_raw = await search_svc.search(db, query=req.query, top_k=req.top_k, filters=search_filters, mode=req.mode)
    except Exception as e:
        logger.error("search error: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")

    # Convert to schema
    results = []
    for r in results_raw:
        try:
            results.append(SearchResultItem(
                chunk_id=r["id"],
                document_id=r["document_id"],
                document_number=r["document_number"] or "—",
                document_title=r["document_title"] or r["document_number"] or "Документ",
                document_type=r.get("document_type"),
                paragraph=r.get("paragraph"),
                section=r.get("section"),
                chapter=r.get("chapter"),
                page=r.get("page"),
                text=r.get("text","")[:2000],
                quote=r.get("text","")[:600],
                score=float(r.get("score", 0)),
                relevance_percent=int(r.get("relevance_percent", 0)),
                relevance_label=r.get("relevance_label",""),
                status=r.get("status","active"),
                source_url=r.get("source_url"),
                publication_date=r.get("publication_date"),
                last_checked_at=r.get("last_checked_at"),
            ))
        except Exception as e:
            logger.warning("result convert error: %s, r=%s", e, r)

    took_ms = int((time.time() - start)*1000)

    # Anti-hallucination guard — адаптивный, не режет маленькие базы
    # Раньше: vec<0.40 && bm<0.02 сразу → для 1 PDF любой запрос уходил в "не найдено"
    # Теперь: для малой базы (<2000 чанков) порог очень мягкий, для большой — строже, + проверка has_vector
    is_low_confidence = False
    if results_raw:
        top = results_raw[0]
        vec = top.get("vector_score", 0) or 0
        bm = top.get("bm25_score", 0) or 0
        fusion = top.get("fusion_score", 0) or 0
        max_bm = max((r.get("bm25_score",0) or 0 for r in results_raw), default=0)
        max_vec = max((r.get("vector_score",0) or 0 for r in results_raw), default=0)
        max_fusion = max((r.get("fusion_score",0) or 0 for r in results_raw), default=0)
        has_vector = any(r.get("vector_score") is not None for r in results_raw)

        # узнаём размер базы — для демо с 1 документом не режем
        try:
            from sqlalchemy import func as _func
            from app.models.document import Chunk as _Chunk
            _cnt_res = await db.execute(select(_func.count()).select_from(_Chunk))
            total_chunks = _cnt_res.scalar() or 0
        except:
            total_chunks = len(results_raw) * 10  # fallback

        if total_chunks < 2000:
            # малая база — только если вообще нет сигнала
            if has_vector:
                if vec < 0.25 and bm < 0.005 and max_fusion < 0.35:
                    is_low_confidence = True
                elif max_vec < 0.25 and max_bm < 0.005 and max_fusion < 0.35:
                    is_low_confidence = True
            else:
                # вектор упал (q_emb None) — судим только по BM25
                if max_bm < 0.005 and max_fusion < 0.35:
                    is_low_confidence = True
        else:
            # большая база — чуть строже, но мягче старого 0.40/0.50
            if has_vector:
                if vec < 0.32 and bm < 0.01:
                    is_low_confidence = True
                if vec < 0.33 and max_bm < 0.005 and max_vec < 0.33:
                    is_low_confidence = True
            else:
                if bm < 0.01 and fusion < 0.35:
                    is_low_confidence = True

        # лог для дебага (видно в docker logs)
        logger.info(
            "q='%s' total_chunks=%d top vec=%.3f bm=%.4f fusion=%.3f max_vec=%.3f max_bm=%.4f max_fusion=%.3f low=%s has_vec=%s",
            req.query[:60], total_chunks, vec, bm, fusion, max_vec, max_bm, max_fusion, is_low_confidence, has_vector,
        )

    # LLM answer (only if results found and not low confidence)
    answer = None
    if results_raw and not is_low_confidence:
        # For fast mode, still generate but with top 3
        # For deep mode, use top 5 and extra reasoning
        answer_svc = get_answer_service()
        # prepare top_chunks for LLM
        top_for_llm = results_raw[:5] if req.mode=="deep" else results_raw[:3]
        # Convert to dict for answer service
        llm_chunks = []
        for r in top_for_llm:
            llm_chunks.append({
                "document_title": r.get("document_title"),
                "document_number": r.get("document_number"),
                "paragraph": r.get("paragraph"),
                "page": r.get("page"),
                "text": r.get("text"),
                "status": r.get("status"),
            })
        try:
            answer = await answer_svc.generate_answer(req.query, llm_chunks, mode=req.mode)
        except Exception as e:
            logger.warning("answer error: %s", e)
            # fallback simple answer
            top = results_raw[0]
            answer = AnswerBlock(
                answer=f"Найдено релевантное требование в {top.get('document_number')}, пункт {top.get('paragraph') or '—'}.",
                normative_basis=top.get("document_title") or top.get("document_number"),
                paragraph=top.get("paragraph"),
                page=top.get("page"),
                quote=top.get("text","")[:500],
                status=top.get("status"),
                date_actual=top.get("last_checked_at").strftime("%d.%m.%Y") if top.get("last_checked_at") else "",
                is_grounded=True
            )
    elif is_low_confidence:
        answer = AnswerBlock(answer="В доступной нормативной базе точного требования не найдено.", is_grounded=False)
        # keep results but mark as low confidence (frontend will show relevance low)
    else:
        answer = AnswerBlock(answer="В доступной нормативной базе точного требования не найдено.", is_grounded=False)

    message = None
    if not results:
        message = "В доступной нормативной базе точного требования не найдено. Попробуйте переформулировать запрос, изменить фильтры или загрузите документ в Документы."
    elif is_low_confidence:
        message = "Показаны ближайшие совпадения с низкой релевантностью — попробуйте переформулировать запрос или снять фильтры."

    result = SearchResponse(
        query=req.query,
        mode=req.mode,
        answer=answer,
        results=results,
        took_ms=took_ms,
        total_found=len(results),
        message=message
    )
    if response:
        response.headers["X-Quota-Remaining"] = str(quota_info.get("remaining", 0))
        response.headers["X-Quota-Limit"] = str(quota_info.get("limit", 0))
    return result

@router.get("/search")
@limiter.limit("30/minute")
async def search_get(request: Request, q: str = Query(..., min_length=2), mode: str = Query("fast"), top_k: int = Query(10, le=20), db: AsyncSession = Depends(get_db), current_user: User | None = Depends(get_current_user_optional)):
    req = SearchRequest(query=q, mode=mode, top_k=top_k)
    return await search(request, req, db, current_user)

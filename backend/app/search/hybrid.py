import re
import time
import logging
from typing import List, Dict, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
import numpy as np
from app.models.document import Chunk, Document
from app.embeddings.provider import EmbeddingProvider
from app.config import settings

logger = logging.getLogger(__name__)

# RRF constant
RRF_K = 60

# Simple synonyms dict for строительных терминов (дополняется LLM) — расширяем бесплатно
SYNONYMS = {
    "коридор": ["проход", "проходной коридор", "эвакуационный путь", "путь эвакуации", "холл"],
    "лестница": ["лестничная клетка", "марш", "эвакуационная лестница", "ступени"],
    "ширина": ["минимальная ширина", "размер", "габарит"],
    "высота": ["высота помещения", "высота этажа", "минимальная высота", "высота подоконника", "высота окна"],
    "подоконник": ["оконный проём", "высота подоконника", "окно", "подоконная доска"],
    "окно": ["оконный проём", "остекление", "подоконник"],
    "мжк": ["жилой комплекс", "многоквартирный дом", "жилое здание", "многоквартирный жилой комплекс"],
    "многоквартирный": ["многоквартирный дом", "жилой комплекс", "МЖК"],
    "жилой": ["жилой комплекс", "многоквартирный дом", "жилое здание"],
    "здание": ["строение", "сооружение", "объект"],
    "общественное здание": ["административное здание", "общественное сооружение"],
    "эвакуационный": ["эвакуация", "пожарный", "аварийный выход"],
}

def normalize_query(q: str) -> str:
    q = q.lower()
    q = q.replace("ё", "е")
    q = re.sub(r"[^\w\s\-]", " ", q)
    q = re.sub(r"\s+", " ", q).strip()
    return q

def expand_with_synonyms(query: str) -> str:
    nq = normalize_query(query)
    expanded = [nq]
    for k, syns in SYNONYMS.items():
        if k in nq:
            for s in syns[:2]:
                expanded.append(nq.replace(k, s))
    # dedup
    return " ".join(list(dict.fromkeys(expanded))[:3])

def relevance_label(score: float) -> Tuple[int, str]:
    """
    score 0..1 (fusion score normalized) -> percent + label
    """
    pct = int(score * 100)
    pct = max(10, min(98, pct))
    if pct >= 90:
        label = "очень высокая релевантность"
    elif pct >= 75:
        label = "высокая релевантность"
    elif pct >= 55:
        label = "возможное соответствие"
    else:
        label = "низкая релевантность"
    return pct, label

# Whitelist of allowed filter columns to prevent SQL injection
ALLOWED_FILTER_COLUMNS = {"status", "type", "language"}
ALLOWED_FILTER_IDS = {"document_id", "owner_id"}


class HybridSearchService:
    def __init__(self, embedder: EmbeddingProvider):
        self.embedder = embedder

    def _build_where_clause(self, filters: Dict) -> Tuple[List[str], Dict]:
        """Build WHERE clause from whitelisted filter keys only."""
        where_clauses: List[str] = []
        params: Dict = {}

        if filters.get("status"):
            where_clauses.append("d.status = :status")
            params["status"] = filters["status"]
        elif not filters.get("include_expired"):
            where_clauses.append("d.status = 'active'")

        if filters.get("type"):
            where_clauses.append("d.type = :type")
            params["type"] = filters["type"]

        if filters.get("document_id"):
            where_clauses.append("d.id = :doc_id")
            params["doc_id"] = filters["document_id"]

        if filters.get("language"):
            where_clauses.append("d.language = :lang")
            params["lang"] = filters["language"]

        if "owner_id" in filters:
            if filters["owner_id"]:
                where_clauses.append("(d.owner_id = :owner_id OR d.owner_id IS NULL)")
                params["owner_id"] = filters["owner_id"]
            else:
                where_clauses.append("d.owner_id IS NULL")

        return where_clauses, params

    async def search(self, db: AsyncSession, query: str, top_k: int = 10, filters: Dict = None, mode: str = "fast") -> List[Dict]:
        filters = filters or {}
        start = time.time()

        is_deep = mode == "deep"
        # 1. Prepare query — deep expands synonyms, fast uses original
        norm_q = normalize_query(query)
        norm_q_search = expand_with_synonyms(query) if is_deep else norm_q
        # For vector, deep uses synonym-expanded query
        vector_query = expand_with_synonyms(query) if is_deep else query
        # Limits per mode
        bm25_limit = settings.top_k_bm25_deep if is_deep else settings.top_k_bm25_fast
        vector_limit = settings.top_k_vector_deep if is_deep else settings.top_k_vector_fast
        rerank_limit_cfg = settings.top_k_rerank_deep if is_deep else settings.top_k_rerank_fast
        # 2. Embed query
        try:
            q_emb = await self.embedder.embed_query(vector_query)
        except Exception as e:
            logger.warning("embed error: %s", e)
            q_emb = None

        # 3. BM25 / FTS search (pg) - use nested transactions to avoid abort
        # Build where clause for filters — whitelisted columns only
        where_clauses, params = self._build_where_clause(filters)
        params["q"] = norm_q

        where_sql = (" AND " + " AND ".join(where_clauses)) if where_clauses else ""

        fts_sql = f"""
            SELECT c.id, c.document_id, c.paragraph, c.section, c.chapter, c.page, c.text, c.type,
                   d.number as document_number, d.title as document_title, d.type as document_type, d.status, d.source_url, d.publication_date, d.last_checked_at,
                   ts_rank_cd(to_tsvector('russian', c.text), plainto_tsquery('russian', :q)) as bm25_score
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE to_tsvector('russian', c.text) @@ plainto_tsquery('russian', :q) {where_sql}
            ORDER BY bm25_score DESC
            LIMIT :limit
        """
        params_bm25 = dict(params)
        params_bm25["q"] = norm_q_search if is_deep else norm_q
        params_bm25["limit"] = bm25_limit
        bm25_results = []
        if len(norm_q.split()) >= 1:
            try:
                async with db.begin_nested():
                    rows = await db.execute(text(fts_sql), params_bm25)
                    for r in rows.mappings().all():
                        d = dict(r)
                        d["bm25_score"] = float(d["bm25_score"] or 0)
                        bm25_results.append(d)
            except Exception as e:
                logger.warning("bm25 error: %s", e)
                try:
                    await db.rollback()
                except:
                    pass

        # Fallback via ILIKE if no results
        if not bm25_results and len(norm_q) >= 3:
            try:
                async with db.begin_nested():
                    params2 = dict(params)
                    params2["q_like"] = (norm_q_search if is_deep else norm_q)[:100]
                    params2["limit"] = bm25_limit
                    rows = await db.execute(text(f"""
                        SELECT c.id, c.document_id, c.paragraph, c.section, c.chapter, c.page, c.text, c.type,
                               d.number as document_number, d.title as document_title, d.type as document_type, d.status, d.source_url, d.publication_date, d.last_checked_at,
                               0.5 as bm25_score
                        FROM chunks c
                        JOIN documents d ON d.id = c.document_id
                        WHERE c.text ILIKE '%' || :q_like || '%' {where_sql}
                        LIMIT :limit
                    """), params2)
                    for r in rows.mappings().all():
                        d = dict(r)
                        d["bm25_score"] = float(d["bm25_score"] or 0)
                        bm25_results.append(d)
            except Exception as e:
                logger.warning("fallback error: %s", e)
                try:
                    await db.rollback()
                except:
                    pass

        # 4. Vector search
        vector_results = []
        if q_emb is not None:
            emb_str = "[" + ",".join(map(str, q_emb)) + "]"
            vec_where = where_sql
            # Use CAST instead of :: to avoid asyncpg param parsing issue
            vec_sql = f"""
                SELECT c.id, c.document_id, c.paragraph, c.section, c.chapter, c.page, c.text, c.type,
                       d.number as document_number, d.title as document_title, d.type as document_type, d.status, d.source_url, d.publication_date, d.last_checked_at,
                       1 - (c.embedding <=> CAST(:q_emb AS vector)) as vector_score
                FROM chunks c
                JOIN documents d ON d.id = c.document_id
                WHERE c.embedding IS NOT NULL {vec_where}
                ORDER BY c.embedding <=> CAST(:q_emb AS vector)
                LIMIT :limit
            """
            try:
                async with db.begin_nested():
                    params_vec = {}
                    # only keep params that are actually in where_sql (status/type/etc) + q_emb/limit
                    for k in ["status","type","doc_id","lang","owner_id"]:
                        if k in params:
                            params_vec[k] = params[k]
                    params_vec["q_emb"] = emb_str
                    params_vec["limit"] = vector_limit
                    rows = await db.execute(text(vec_sql), params_vec)
                    for r in rows.mappings().all():
                        d = dict(r)
                        d["vector_score"] = float(d["vector_score"] or 0)
                        vector_results.append(d)
            except Exception as e:
                logger.warning("vector error: %s — falling back to no vector", e)
                try:
                    await db.rollback()
                except:
                    pass

        # 4.5 Trigram fallback for typos (бесплатно, pg_trgm) — если BM25 и вектор пустые
        if not bm25_results and not vector_results and len(norm_q) >= 4:
            try:
                trig_rows = await self.trigram_search(db, norm_q, limit=bm25_limit)
                for r in trig_rows:
                    # trigram returns sim, map to bm25_score
                    r = dict(r)
                    r["bm25_score"] = float(r.get("sim", 0)) * 0.8
                    r["vector_score"] = 0.0
                    # ensure required keys for fusion
                    if "id" not in r and "c.id" in r:
                        r["id"] = r["c.id"]
                    # fetch missing doc fields if not present
                    if "document_title" not in r:
                        r["document_title"] = r.get("document_number", "Документ")
                    bm25_results.append(r)
                logger.info("trigram fallback used, got %d", len(trig_rows))
            except Exception as e:
                logger.warning("trigram fallback error: %s", e)
                try:
                    await db.rollback()
                except:
                    pass

        # 5. Fusion via RRF
        # Create maps id -> rank
        bm25_rank = {str(r["id"]): i+1 for i, r in enumerate(bm25_results)}
        vec_rank = {str(r["id"]): i+1 for i, r in enumerate(vector_results)}
        all_ids = set(bm25_rank.keys()) | set(vec_rank.keys())
        # Also keep id -> record
        id_to_rec = {}
        for r in bm25_results:
            id_to_rec[str(r["id"])] = r
        for r in vector_results:
            if str(r["id"]) not in id_to_rec:
                id_to_rec[str(r["id"])] = r
            else:
                # merge scores
                id_to_rec[str(r["id"])]["vector_score"] = r.get("vector_score", 0)
                # keep bm25_score already

        # compute RRF score
        fused = []
        for cid in all_ids:
            rrf = 0.0
            if cid in bm25_rank:
                rrf += 1.0 / (RRF_K + bm25_rank[cid])
                # also weight by bm25_score normalized? simple boost
                rec = id_to_rec[cid]
                rrf += rec.get("bm25_score", 0) * 0.2
            if cid in vec_rank:
                rrf += 1.0 / (RRF_K + vec_rank[cid])
                rec = id_to_rec[cid]
                rrf += rec.get("vector_score", 0) * 0.3
            rec = id_to_rec[cid]
            rec["rrf_score"] = rrf
            fused.append(rec)

        if not fused:
            return []

        # Sort by rrf_score desc
        fused.sort(key=lambda x: x["rrf_score"], reverse=True)
        # Take top rerank candidates (larger pool for deep)
        candidates = fused[:rerank_limit_cfg]

        # 6. Reranker (optional, lightweight cross-encoder if available, else use normalized rrf)
        # For MVP: if sentence-transformers cross-encoder available, use it; else approximate
        # We'll attempt to load lightweight reranker via embedder similarity refine?
        # Simple: if we have both scores, combine; otherwise rrf only
        # Normalize rrf to 0..1 for relevance label
        max_rrf = max(c["rrf_score"] for c in candidates) if candidates else 1
        for c in candidates:
            # normalized fusion
            norm = c["rrf_score"] / max_rrf if max_rrf > 0 else 0
            # blend vector_score if exists
            if "vector_score" in c:
                norm = 0.6 * norm + 0.4 * c["vector_score"]
            c["fusion_score"] = float(norm)

        # If deep mode and we have cross-encoder, we could rerank more accurately (deferred to LLM rerank)
        # For now sort by fusion_score
        candidates.sort(key=lambda x: x["fusion_score"], reverse=True)

        # Final top_k
        top = candidates[:top_k]

        # Add relevance percent/label
        for c in top:
            pct, label = relevance_label(c["fusion_score"])
            c["relevance_percent"] = pct
            c["relevance_label"] = label
            # ensure fields
            c["quote"] = c["text"][:600]
            c["score"] = c["fusion_score"]

        return top

    async def trigram_search(self, db: AsyncSession, query: str, limit: int = 10) -> List[Dict]:
        # For typos: use pg_trgm similarity
        sql = text("""
            SELECT c.id, c.text, c.paragraph, c.page, d.number as document_number, similarity(c.text, :q) as sim
            FROM chunks c JOIN documents d ON d.id=c.document_id
            WHERE similarity(c.text, :q) > 0.2
            ORDER BY sim DESC LIMIT :limit
        """)
        rows = await db.execute(sql, {"q": query, "limit": limit})
        return [dict(r) for r in rows.mappings().all()]

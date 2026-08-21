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
    """Legacy: joins expansions into one string (for embed fallback). Use expand_queries_list for search."""
    nq = normalize_query(query)
    expanded = [nq]
    for k, syns in SYNONYMS.items():
        if k in nq:
            for s in syns[:2]:
                expanded.append(nq.replace(k, s))
    # dedup
    return " ".join(list(dict.fromkeys(expanded))[:3])


def expand_queries_list(query: str, max_variants: int = 3) -> List[str]:
    """Return list of separate query variants for OR-search (deep mode).
    e.g. 'ширина коридора' -> ['ширина коридора', 'минимальная ширина коридора', 'ширина прохода']
    """
    nq = normalize_query(query)
    expanded: List[str] = [nq]
    for k, syns in SYNONYMS.items():
        if k in nq:
            for s in syns[:2]:
                variant = nq.replace(k, s)
                if variant not in expanded:
                    expanded.append(variant)
                if len(expanded) >= max_variants:
                    break
        if len(expanded) >= max_variants:
            break
    return expanded[:max_variants]


def _build_tsquery_variants(expanded: List[str]) -> str:
    """Build plainto_tsquery OR string: not used directly, we iterate variants instead.
    Kept for logging / debug.
    """
    return " | ".join(expanded)

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
        # 1. Prepare query — deep expands synonyms into separate OR variants, fast uses original
        norm_q = normalize_query(query)
        expanded_queries = expand_queries_list(query, max_variants=3) if is_deep else [norm_q]
        # For vector, deep embeds multiple variants and averages (better than concatenated string)
        # Limits per mode
        bm25_limit = settings.top_k_bm25_deep if is_deep else settings.top_k_bm25_fast
        vector_limit = settings.top_k_vector_deep if is_deep else settings.top_k_vector_fast
        rerank_limit_cfg = settings.top_k_rerank_deep if is_deep else settings.top_k_rerank_fast
        # 2. Embed query — deep: embed each variant and average
        q_emb = None
        if is_deep and len(expanded_queries) > 1:
            try:
                embs = []
                for vq in expanded_queries:
                    e = await self.embedder.embed_query(vq)
                    if e is not None:
                        embs.append(np.array(e, dtype=np.float32))
                if embs:
                    # average normalized embeddings
                    avg = np.mean(embs, axis=0)
                    # re-normalize to unit length (cosine space)
                    norm = np.linalg.norm(avg)
                    if norm > 0:
                        avg = avg / norm
                    q_emb = avg.tolist()
                else:
                    q_emb = await self.embedder.embed_query(norm_q)
            except Exception as e:
                logger.warning("embed deep error: %s", e)
                try:
                    q_emb = await self.embedder.embed_query(norm_q)
                except Exception as e2:
                    logger.warning("embed fallback error: %s", e2)
                    q_emb = None
        else:
            try:
                q_emb = await self.embedder.embed_query(expanded_queries[0])
            except Exception as e:
                logger.warning("embed error: %s", e)
                q_emb = None

        # 3. BM25 / FTS search (pg) - use nested transactions to avoid abort
        # Build where clause for filters — whitelisted columns only
        where_clauses, params = self._build_where_clause(filters)
        params["q"] = norm_q

        where_sql = (" AND " + " AND ".join(where_clauses)) if where_clauses else ""

        # BM25: for deep we run each variant separately and merge (OR logic)
        # This fixes the bug where plainto_tsquery on concatenated synonyms used AND and returned 0 rows
        fts_sql_template = f"""
            SELECT c.id, c.document_id, c.paragraph, c.section, c.chapter, c.page, c.text, c.type,
                   d.number as document_number, d.title as document_title, d.type as document_type, d.status, d.source_url, d.publication_date, d.last_checked_at,
                   ts_rank_cd(to_tsvector('russian', c.text), plainto_tsquery('russian', :q)) as bm25_score
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE to_tsvector('russian', c.text) @@ plainto_tsquery('russian', :q) {where_sql}
            ORDER BY bm25_score DESC
            LIMIT :limit
        """
        bm25_results: List[Dict] = []
        bm25_by_id: Dict[str, Dict] = {}
        if len(norm_q.split()) >= 1:
            for q_variant in expanded_queries:
                params_bm25 = dict(params)
                params_bm25["q"] = q_variant
                # for deep we split limit across variants to keep total bounded, but keep at least limit
                per_variant_limit = bm25_limit if not is_deep else max(20, bm25_limit // len(expanded_queries) + 5)
                params_bm25["limit"] = per_variant_limit
                try:
                    async with db.begin_nested():
                        rows = await db.execute(text(fts_sql_template), params_bm25)
                        for r in rows.mappings().all():
                            d = dict(r)
                            d["bm25_score"] = float(d["bm25_score"] or 0)
                            cid = str(d["id"])
                            # keep max bm25_score if same chunk found via multiple variants
                            if cid not in bm25_by_id or d["bm25_score"] > bm25_by_id[cid]["bm25_score"]:
                                bm25_by_id[cid] = d
                except Exception as e:
                    logger.warning("bm25 error for q='%s': %s", q_variant[:60], e)
                    try:
                        await db.rollback()
                    except:
                        pass
            # merge and sort by bm25_score desc, trim to bm25_limit
            bm25_results = sorted(bm25_by_id.values(), key=lambda x: x["bm25_score"], reverse=True)[:bm25_limit]

        # Fallback via ILIKE if no results — fixed: OR per token instead of whole concatenated phrase
        if not bm25_results and len(norm_q) >= 3:
            # tokenise original normalized query (ignore very short tokens)
            q_tokens = [t for t in norm_q.split() if len(t) >= 3][:4]
            # also add synonym tokens for deep
            if is_deep:
                for syn_q in expanded_queries[1:]:
                    for t in syn_q.split():
                        if len(t) >= 3 and t not in q_tokens and len(q_tokens) < 6:
                            q_tokens.append(t)
            if q_tokens:
                try:
                    async with db.begin_nested():
                        # Build OR ILIKE conditions
                        ilike_conds = " OR ".join([f"c.text ILIKE :q_like_{i}" for i in range(len(q_tokens))])
                        params2 = dict(params)
                        for i, tok in enumerate(q_tokens):
                            params2[f"q_like_{i}"] = f"%{tok}%"
                        params2["limit"] = bm25_limit
                        rows = await db.execute(text(f"""
                            SELECT c.id, c.document_id, c.paragraph, c.section, c.chapter, c.page, c.text, c.type,
                                   d.number as document_number, d.title as document_title, d.type as document_type, d.status, d.source_url, d.publication_date, d.last_checked_at,
                                   0.5 as bm25_score
                            FROM chunks c
                            JOIN documents d ON d.id = c.document_id
                            WHERE ({ilike_conds}) {where_sql}
                            LIMIT :limit
                        """), params2)
                        for r in rows.mappings().all():
                            d = dict(r)
                            d["bm25_score"] = float(d["bm25_score"] or 0)
                            # dedup via bm25_by_id logic already, but fallback is empty so just append
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
        # Fixed: pass filters so we don't leak expired/replaced docs, and respect owner_id
        if not bm25_results and not vector_results and len(norm_q) >= 4:
            try:
                trig_rows = await self.trigram_search(db, norm_q, limit=bm25_limit, filters=filters)
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

        # 5. Fusion via RRF — fixed: normalize bm25/vector before boosting, balanced weights
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
                # merge scores: keep max bm25, add vector
                # ensure both scores present
                existing = id_to_rec[str(r["id"])]
                existing["vector_score"] = r.get("vector_score", 0)
                # keep higher bm25 if vector result also had bm25 (rare)
                if r.get("bm25_score"):
                    existing["bm25_score"] = max(existing.get("bm25_score", 0), r.get("bm25_score", 0))

        # normalize bm25/vector for fair weighting
        max_bm = max((r.get("bm25_score", 0) or 0 for r in id_to_rec.values()), default=1)
        max_vec = max((r.get("vector_score", 0) or 0 for r in id_to_rec.values()), default=1)
        if max_bm == 0:
            max_bm = 1
        if max_vec == 0:
            max_vec = 1

        # compute RRF score with normalized boosts
        fused = []
        for cid in all_ids:
            rrf = 0.0
            rec = id_to_rec[cid]
            if cid in bm25_rank:
                rrf += 1.0 / (RRF_K + bm25_rank[cid])
                bm_norm = (rec.get("bm25_score", 0) or 0) / max_bm
                rrf += bm_norm * 0.15
            if cid in vec_rank:
                rrf += 1.0 / (RRF_K + vec_rank[cid])
                vec_norm = (rec.get("vector_score", 0) or 0) / max_vec
                # vector gets slightly higher weight (semantic)
                rrf += vec_norm * 0.20
            rec["rrf_score"] = rrf
            fused.append(rec)

        if not fused:
            return []

        # Sort by rrf_score desc
        fused.sort(key=lambda x: x["rrf_score"], reverse=True)
        # Take top rerank candidates (larger pool for deep)
        candidates = fused[:rerank_limit_cfg]

        # 6. Reranker (optional) — normalize rrf to 0..1 for relevance label
        max_rrf = max(c["rrf_score"] for c in candidates) if candidates else 1
        if max_rrf == 0:
            max_rrf = 1
        for c in candidates:
            # normalized fusion
            norm = c["rrf_score"] / max_rrf if max_rrf > 0 else 0
            # blend vector_score if exists (boost high semantic matches)
            if "vector_score" in c and c.get("vector_score"):
                vec_n = (c.get("vector_score", 0) or 0) / max_vec
                # weighted blend: 55% rrf norm + 45% vector
                norm = 0.55 * norm + 0.45 * vec_n
            c["fusion_score"] = float(max(0.0, min(1.0, norm)))

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

    async def trigram_search(self, db: AsyncSession, query: str, limit: int = 10, filters: Dict = None) -> List[Dict]:
        # For typos: use pg_trgm similarity — fixed to respect filters (status, owner_id, etc.)
        filters = filters or {}
        where_clauses, params = self._build_where_clause(filters)
        where_sql = (" AND " + " AND ".join(where_clauses)) if where_clauses else ""
        # lower threshold to 0.15 for short typos like "ширна"
        sql = text(f"""
            SELECT c.id, c.document_id, c.text, c.paragraph, c.section, c.chapter, c.page, c.type,
                   d.number as document_number, d.title as document_title, d.type as document_type, d.status, d.source_url, d.publication_date, d.last_checked_at,
                   similarity(c.text, :q) as sim
            FROM chunks c JOIN documents d ON d.id=c.document_id
            WHERE similarity(c.text, :q) > 0.15 {where_sql}
            ORDER BY sim DESC LIMIT :limit
        """)
        params["q"] = query
        params["limit"] = limit
        rows = await db.execute(sql, params)
        return [dict(r) for r in rows.mappings().all()]

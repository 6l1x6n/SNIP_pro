#!/usr/bin/env python3
"""
eval_search.py — офлайн-линейка ретривала SNIP: воспроизводит engine.ts 1:1
(BM25 + int8-вектор + RRF + combined) и считает Hit@1/3/5 / MRR / weak% по golden.jsonl.

Запуск:
  python3 scripts/eval_search.py                 # hybrid (прод-режим смылового ранжирования)
  python3 scripts/eval_search.py --source bm25
  python3 scripts/eval_search.py --source vector
  python3 scripts/eval_search.py --tag baseline  # сохранить results_baseline.json
  python3 scripts/eval_search.py --topk 10

Эмбеддинги запросов кэшируются в scripts/eval/embed_cache.json (Cohere/Gemini по manifest).
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = ROOT / "scripts" / "eval"
INDEX = ROOT / "frontend" / "public" / "index"

sys.path.insert(0, str(ROOT / "scripts"))
from build_index import tokenize  # noqa: E402

# ---------- Синонимы (зеркало frontend/src/utils/semanticSynonyms.ts) ----------

def load_ts_semantic_synonyms() -> dict[str, list[str]]:
    p = ROOT / "frontend" / "src" / "utils" / "semanticSynonyms.ts"
    out: dict[str, list[str]] = {}
    if not p.exists():
        return out
    text = p.read_text(encoding="utf-8")
    for m in re.finditer(r"['\"]([^'\"]+)['\"]\s*:\s*\[([^\]]*)\]", text):
        key = m.group(1)
        vals = re.findall(r"['\"]([^'\"]+)['\"]", m.group(2))
        if vals:
            out[key] = vals
    return out


def norm_query(q: str) -> str:
    q = q.lower().replace("ё", "е")
    q = re.sub(r"[^a-zа-я0-9_\s-]", " ", q)
    return re.sub(r"\s+", " ", q).strip()


def expand_variants(query: str, synonyms: dict[str, list[str]], max_variants: int) -> list[str]:
    nq = norm_query(query)
    variants = [nq]
    words = [w for w in nq.split(" ") if w]
    for raw_key, syns in synonyms.items():
        key = raw_key.lower().replace("ё", "е")
        if not any(key in w for w in words):
            continue
        for s in syns[:2]:
            v = " ".join(s if key in w else w for w in words)
            if v not in variants:
                variants.append(v)
            if len(variants) >= max_variants:
                break
        if len(variants) >= max_variants:
            break
    return variants


# ---------- Индекс ----------

def load_index() -> dict:
    manifest = json.loads((INDEX / "manifest.json").read_text(encoding="utf-8"))
    docs = json.loads((INDEX / "docs.json").read_text(encoding="utf-8"))
    bm25 = json.loads((INDEX / "bm25.json").read_text(encoding="utf-8"))
    base_syn = json.loads((INDEX / "synonyms.json").read_text(encoding="utf-8"))
    syn = {**load_ts_semantic_synonyms(), **base_syn}
    n_chunk_shards = (manifest.get("shards") or {}).get("chunks", 1)
    chunks: list = []
    for k in range(n_chunk_shards):
        chunks += json.loads((INDEX / f"chunks_{k}.json").read_text(encoding="utf-8"))
    n_vec_shards = (manifest.get("shards") or {}).get("vectors", 1)
    scales_parts, int8_parts, dim = [], [], 0
    for k in range(n_vec_shards):
        fn = "vectors.bin" if (k == 0 and n_vec_shards == 1) else f"vectors_{k}.bin"
        buf = (INDEX / fn).read_bytes()
        assert buf[:4] == b"SNV1", f"{fn}: bad magic"
        dim = int.from_bytes(buf[4:8], "little")
        n = int.from_bytes(buf[8:12], "little")
        scales_parts.append(np.frombuffer(buf[12:12 + 4 * n], dtype="<f4"))
        int8_parts.append(np.frombuffer(buf[12 + 4 * n:12 + 4 * n + n * dim], dtype=np.int8))
    scales = np.concatenate(scales_parts)
    int8 = np.concatenate(int8_parts).reshape(-1, dim)
    assert len(chunks) == len(scales) == int8.shape[0], "index size mismatch"
    return {
        "manifest": manifest, "docs": docs, "chunks": chunks, "bm25": bm25,
        "synonyms": syn, "scales": scales, "int8": int8, "dim": dim,
    }


# ---------- Эмбеддинги запросов (кэш) ----------

def env_key(name: str) -> str:
    for env_file in (ROOT / "backend" / ".env", ROOT / ".env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get(name, "")


class Embedder:
    def __init__(self, manifest: dict):
        self.provider = manifest.get("provider", "gemini")
        self.model = manifest.get("model", "gemini-embedding-001")
        self.dim = int(manifest.get("dim") or 0)
        self.cache_path = EVAL_DIR / "embed_cache.json"
        self.cache: dict[str, list[float]] = {}
        if self.cache_path.exists():
            try:
                self.cache = json.loads(self.cache_path.read_text(encoding="utf-8"))
            except Exception:
                self.cache = {}
        self.keys = {
            "cohere": env_key("COHERE_API_KEY"),
            "gemini": env_key("GEMINI_API_KEY"),
            "jina": env_key("JINA_API_KEY"),
            "voyage": env_key("VOYAGE_API_KEY"),
            "mistral": env_key("MISTRAL_API_KEY"),
        }

    def _call_worker(self, q: str) -> list[float]:
        """Прод-воркер /api/embed (без mode → без списания; D1-кэш + рабочий Cohere-секрет)."""
        req = urllib.request.Request(
            "https://snip-worker.postalarchive.workers.dev/api/embed",
            data=json.dumps({"query": q}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "snip-eval/1.0"},
        )
        d = json.loads(urllib.request.urlopen(req, timeout=60).read())
        if not d.get("embedding"):
            raise RuntimeError(f"worker embed: {d}")
        return d["embedding"]

    def _call(self, provider: str, q: str) -> list[float]:
        key = self.keys.get(provider, "")
        if not key:
            raise RuntimeError(f"{provider}: нет ключа в backend/.env")
        if provider == "cohere":
            body = {"model": self.model, "texts": [q], "input_type": "search_query", "embedding_types": ["float"]}
            req = urllib.request.Request(
                "https://api.cohere.com/v2/embed",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
            )
            d = json.loads(urllib.request.urlopen(req, timeout=30).read())
            vec = (d.get("embeddings") or {}).get("float", [None])[0]
        elif provider == "gemini":
            body = {"taskType": "RETRIEVAL_QUERY", "content": {"parts": [{"text": q}]}, "outputDimensionality": 768}
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:embedContent",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
            )
            d = json.loads(urllib.request.urlopen(req, timeout=30).read())
            vec = d["embedding"]["values"]
        elif provider == "jina":
            body = {"model": self.model, "task": "retrieval.query", "input": [q]}
            req = urllib.request.Request(
                "https://api.jina.ai/v1/embeddings",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
            )
            d = json.loads(urllib.request.urlopen(req, timeout=30).read())
            vec = d["data"][0]["embedding"]
        elif provider == "voyage":
            body = {"model": self.model, "input_type": "query", "input": [q]}
            req = urllib.request.Request(
                "https://api.voyageai.com/v1/embeddings",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
            )
            d = json.loads(urllib.request.urlopen(req, timeout=30).read())
            vec = d["data"][0]["embedding"]
        else:
            raise RuntimeError(f"провайдер {provider} не поддержан в eval")
        if not vec:
            raise RuntimeError(f"{provider}: пустой вектор")
        return vec

    def embed(self, q: str) -> np.ndarray:
        ck = f"{self.provider}|{self.model}|{q}"
        vec = self.cache.get(ck)
        if vec is None:
            last = None
            try:
                vec = self._call(self.provider, q)
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  локальный {self.provider} недоступен ({e}) → прод-воркер", file=sys.stderr)
            if vec is None:
                for attempt in range(3):
                    try:
                        vec = self._call_worker(q)
                        break
                    except Exception as e:  # noqa: BLE001
                        last = e
                        wait = [2, 5, 15][attempt]
                        print(f"  worker embed retry {attempt + 1}/3 через {wait}с: {e}", file=sys.stderr)
                        time.sleep(wait)
            if vec is None:
                raise last  # type: ignore[misc]
            self.cache[ck] = vec
            self.cache_path.write_text(json.dumps(self.cache, ensure_ascii=False), encoding="utf-8")
        v = np.asarray(vec, dtype=np.float32)
        n = np.linalg.norm(v) or 1.0
        return v / n


# ---------- Понимание запроса (прод /api/rewrite) ----------

_REWRITE_CACHE_PATH = EVAL_DIR / "rewrite_cache.json"


def fetch_rewrite(query: str) -> dict:
    cache: dict = {}
    if _REWRITE_CACHE_PATH.exists():
        try:
            cache = json.loads(_REWRITE_CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            cache = {}
    if query in cache:
        return cache[query]
    req = urllib.request.Request(
        "https://snip-worker.postalarchive.workers.dev/api/rewrite",
        data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "snip-eval/1.0", "X-Device-Id": "eval-offline"},
    )
    out: dict = {"standalone": query, "queries": [], "terms": []}
    for attempt in range(3):
        try:
            out = json.loads(urllib.request.urlopen(req, timeout=30).read())
            break
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                print(f"  rewrite fail: {e}", file=sys.stderr)
            time.sleep([1, 3][attempt] if attempt < 2 else 0)
    cache[query] = out
    _REWRITE_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return out


# ---------- Скоринг ----------

def bm25_scores(tokens: list[str], idx: dict) -> dict[int, float]:
    bm25 = idx["bm25"]
    k1, b = float(bm25["k1"]), float(bm25["b"])
    avgdl = float(bm25["avgdl"])
    lens, postings = bm25["len"], bm25["postings"]
    N = len(idx["chunks"])
    scores: dict[int, float] = {}
    for term in dict.fromkeys(tokens):
        plist = postings.get(term)
        if not plist:
            continue
        df = len(plist)
        idf = math.log((N - df + 0.5) / (df + 0.5) + 1)
        for chunk_idx, tf in plist:
            dl = lens[chunk_idx] or avgdl
            scores[chunk_idx] = scores.get(chunk_idx, 0.0) + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
    return scores


def vector_scores(qvec: np.ndarray, idx: dict) -> np.ndarray:
    # dot(int8, q) * scale, как dotQueryInt8 в engine.ts (поэлементно, без clip)
    out = np.empty(idx["int8"].shape[0], dtype=np.float32)
    step = 4096
    for i in range(0, idx["int8"].shape[0], step):
        block = idx["int8"][i:i + step].astype(np.float32)
        out[i:i + step] = block @ qvec * idx["scales"][i:i + step]
    return out


def ranked_from(scores) -> list[tuple[int, float]]:
    items = scores.items() if isinstance(scores, dict) else enumerate(scores)
    return sorted(items, key=lambda x: -x[1])


def search(query: str, idx: dict, embedder: Embedder, source: str, semantic: bool, max_variants: int,
           extra_variants: list[str] | None = None, vector_queries: list[str] | None = None,
           extra_weight: float = 0.6, use_vector_queries: bool = True) -> dict:
    K = int((idx["manifest"].get("rrfK") or 60))
    variants = expand_variants(query, idx["synonyms"], max_variants)
    extras: list[str] = []
    for raw in (extra_variants or []):
        v = norm_query(raw)
        if v and v not in variants and v not in extras and len(variants) + len(extras) < max_variants + 3:
            extras.append(v)
    vec_q = [query] + ([q for q in dict.fromkeys(vector_queries or []) if q and q != query] if use_vector_queries else [])
    vecs = [embedder.embed(q) for q in vec_q[:3]]
    if len(vecs) == 1:
        qvec = vecs[0]
    else:
        acc = np.zeros_like(vecs[0])
        for v in vecs:
            acc += v / (np.linalg.norm(v) or 1.0)
        qvec = acc / (np.linalg.norm(acc) or 1.0)
    vs = vector_scores(qvec, idx)
    v_rank = np.argsort(-vs)
    v_scores: dict[int, float] = {int(i): float(vs[i]) for i in v_rank[:100]}

    rrf: dict[int, float] = {}
    best_vec: dict[int, float] = {}
    best_bm: dict[int, float] = {}
    if source in ("vector", "hybrid"):
        for rank, i in enumerate(v_rank):
            rrf[int(i)] = rrf.get(int(i), 0.0) + 1.0 / (K + rank + 1)
        for i in v_rank:
            best_vec[int(i)] = float(vs[i])
    if source in ("bm25", "hybrid"):
        for variant, w in [(v, 1.0) for v in variants] + [(v, extra_weight) for v in extras]:
            bm = bm25_scores(tokenize(variant), idx)
            for rank, (i, _s) in enumerate(ranked_from(bm)):
                rrf[i] = rrf.get(i, 0.0) + w / (K + rank + 1)
            for i, sc in bm.items():
                best_bm[i] = max(best_bm.get(i, -1e9), sc)

    if source == "vector":
        final = [(int(i), float(vs[i])) for i in v_rank]
    elif source == "bm25":
        final = ranked_from(best_bm)
    else:
        ranked = ranked_from(rrf)
        max_rrf = ranked[0][1] if ranked else 1.0
        w_rrf, w_vec = (0.45, 0.55) if semantic else (0.6, 0.4)
        final = []
        for i, r in ranked:
            combined = w_rrf * (r / max_rrf) + w_vec * max(0.0, best_vec.get(i, 0.0))
            final.append((i, combined))
        final.sort(key=lambda x: -x[1])

    top_vec = max(best_vec.values()) if best_vec else 0.0
    top_bm = max(best_bm.values()) if best_bm else 0.0
    corpus_small = len(idx["chunks"]) < 2000
    vec_min = 0.25 if corpus_small else 0.32
    weak = (top_vec < vec_min and top_bm < 0.005) if source != "bm25" else top_bm < 0.005
    return {"final": final, "variants": variants, "weak": weak, "top_vec": top_vec, "top_bm": top_bm}


_KZ_RE = re.compile(r"[әғқңөұүһі]")
_COMPLEX_RE = re.compile(
    r"сравн|отлич|разниц|противореч|почему|зачем|когда применять|когда нужно|если |несколько|"
    r"все требован|перечень|список|сводн|что лучше|плюсы|минусы|какие |каковы"
)
_DOMAIN_TERMS = [
    "ширин", "высот", "длин", "площад", "расстоян", "этаж", "коридор", "лестниц", "двер",
    "окн", "помещен", "здани", "сооружен", "уклон", "температур", "толщин", "глубин",
    "диаметр", "прочн", "нагрузк", "огнестой", "эвакуа", "пожар", "норм", "требован",
    "фундамент", "стен", "перегород", "кровл", "крыш", "потол", "полы", "пол ", "балк",
    "огражден", "проем", "проезд", "проход", "лестн", "лифт", "автостоян", "свай", "бетон",
]


def needs_rewrite(q: str) -> bool:
    nq = q.lower().replace("ё", "е")
    if _KZ_RE.search(nq):
        return True
    if _COMPLEX_RE.search(nq) or len(nq) > 140:
        return True
    if not any(t in nq for t in _DOMAIN_TERMS):
        return True
    return False


def rank_of(final: list[tuple[int, float]], expected: list[int]) -> int | None:
    for rank, (i, _s) in enumerate(final, start=1):
        if i in expected:
            return rank
    return None


# ---------- Reranking через прод-воркер (Workers AI bge-reranker) ----------

def worker_token() -> str:
    p = EVAL_DIR / ".eval_token"
    return p.read_text(encoding="utf-8").strip() if p.exists() else ""


def rerank_top(query: str, idx: dict, candidate_ids: list[int], top_n: int = 8, provider: str = "") -> tuple[list[int], str, list[str]]:
    token = worker_token()
    if not token:
        raise RuntimeError("нет scripts/eval/.eval_token — задайте wrangler secret EVAL_TOKEN")
    texts = [idx["chunks"][i]["t"] for i in candidate_ids]
    req = urllib.request.Request(
        "https://snip-worker.postalarchive.workers.dev/api/eval/rerank",
        data=json.dumps({"query": query, "texts": texts, **({"provider": provider} if provider else {})}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "snip-eval/1.0", "X-Eval-Token": token},
    )
    last: Exception | None = None
    d: dict = {}
    for attempt in range(4):
        try:
            d = json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception as e:  # noqa: BLE001
            last = e
            d = {}
        # форсированный провайдер ответил не собой (429/брейкер) — ждём и повторяем
        if d and (not provider or d.get("model") == provider):
            break
        if attempt < 3:
            time.sleep(7 if provider else 1)
    if not d:
        raise last if last else RuntimeError("rerank: пустой ответ")
    order = [candidate_ids[k] for k in d.get("order", []) if 0 <= k < len(candidate_ids)]
    rest = [i for i in candidate_ids if i not in order]
    return order + rest, str(d.get("model", "?")), [str(x) for x in (d.get("errors") or [])]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="hybrid", choices=["hybrid", "bm25", "vector"])
    ap.add_argument("--semantic", action="store_true", default=True)
    ap.add_argument("--no-semantic", dest="semantic", action="store_false")
    ap.add_argument("--topk", type=int, default=10)
    ap.add_argument("--tag", default="")
    ap.add_argument("--max-variants", type=int, default=5)
    ap.add_argument("--rerank", action="store_true", help="переранжировать top-24 через прод-воркер (bge-reranker)")
    ap.add_argument("--rerank-top", type=int, default=8)
    ap.add_argument("--rerank-provider", default="", help="форсировать rerank-звено (jina-rerank|cohere-rerank|voyage-rerank|llm-rerank|workers-rerank)")
    ap.add_argument("--rewrite", action="store_true", help="использовать прод /api/rewrite: BM25-варианты + усреднённый вектор")
    ap.add_argument("--rewrite-mode", default="both", choices=["both", "bm25", "vector"], help="как использовать rewrite-запросы")
    ap.add_argument("--rewrite-candidates", action="store_true", help="rewrite добавляет кандидатов после базового top-24 (для rerank), не меняя базовый порядок")
    ap.add_argument("--rewrite-gate", action="store_true", help="применять rewrite только для kz/сложных/разговорных запросов")
    ap.add_argument("--rewrite-vec-candidates", action="store_true", help="+ векторные кандидаты по rewrite-запросам (для kz/кросс-языка)")
    ap.add_argument("--extra-weight", type=float, default=0.6, help="вес RRF-голоса rewrite-вариантов (база=1.0)")
    args = ap.parse_args()

    golden = [json.loads(line) for line in (EVAL_DIR / "golden.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    t0 = time.time()
    idx = load_index()
    print(f"индекс: {len(idx['chunks'])} чанков, dim={idx['dim']}, провайдер={idx['manifest'].get('provider')}/{idx['manifest'].get('model')}")
    embedder = Embedder(idx["manifest"])
    print(f"golden: {len(golden)} кейсов, source={args.source}, semantic={args.semantic}, эмбеддер={embedder.provider}")

    case_results = []
    rerank_models: set[str] = set()
    rerank_errors: list[str] | None = None
    for n, case in enumerate(golden, 1):
        expected = [case["chunk"]] if "chunk" in case else list(case.get("chunks", []))
        rw = fetch_rewrite(case["q"]) if (args.rewrite and (not args.rewrite_gate or needs_rewrite(case["q"]))) else None
        used_rewrite = bool((rw or {}).get("queries"))
        rw_queries = (rw or {}).get("queries") or []
        if args.rewrite_gate and not used_rewrite:
            rw_queries = []
        res = search(
            case["q"], idx, embedder, args.source, args.semantic, args.max_variants,
            extra_variants=None if args.rewrite_candidates else (rw_queries if args.rewrite_mode in ("both", "bm25") else None),
            vector_queries=None if args.rewrite_candidates else (rw_queries if args.rewrite_mode in ("both", "vector") else None),
            extra_weight=args.extra_weight,
            use_vector_queries=args.rewrite_mode in ("both", "vector"),
        )
        final = res["final"]
        if args.rewrite_candidates and rw_queries:
            cand = [i for i, _s in final[:24]]
            for rq in rw_queries[:3]:
                bm = bm25_scores(tokenize(rq), idx)
                for i, _sc in ranked_from(bm)[:8]:
                    if i not in cand:
                        cand.append(i)
            if args.rewrite_vec_candidates:
                for rq in rw_queries[:2]:
                    vs = vector_scores(embedder.embed(rq), idx)
                    for i in np.argsort(-vs)[:8]:
                        if int(i) not in cand:
                            cand.append(int(i))
            final = [(i, 0.0) for i in cand]
        if args.rerank and final:
            cand = [i for i, _s in final[:32]]
            ordered, model, rerr = rerank_top(case["q"], idx, cand, args.rerank_top, args.rerank_provider)
            rerank_models.add(model)
            if rerr and rerank_errors is None:
                rerank_errors = rerr
            base_ids = [i for i, _s in final]
            final = [(i, 0.0) for i in ordered] + [(i, 0.0) for i in base_ids[32:] if i not in ordered]
        rank = rank_of(final, expected)
        hit5 = rank is not None and rank <= 5
        top_chunk = final[0][0] if final else -1
        case_results.append({
            "q": case["q"], "tag": case.get("tag", ""), "expected": expected, "rank": rank,
            "hit1": rank == 1, "hit3": rank is not None and rank <= 3, "hit5": hit5,
            "weak": res["weak"], "top": top_chunk, "top_vec": round(res["top_vec"], 3), "top_bm": round(res["top_bm"], 4),
            "variants": res["variants"][:3], "rewrite_used": used_rewrite,
        })
        mark = "✓" if rank == 1 else ("•" if hit5 else "✗")
        print(f"  {mark} {'#' + str(rank) if rank else '—':>4}  {case['q'][:74]}")

    def metrics(rows: list[dict]) -> dict:
        n = len(rows) or 1
        ranks = [r["rank"] for r in rows]
        return {
            "n": len(rows),
            "hit1": sum(1 for r in rows if r["hit1"]) / n,
            "hit3": sum(1 for r in rows if r["hit3"]) / n,
            "hit5": sum(1 for r in rows if r["hit5"]) / n,
            "mrr": sum(1.0 / r for r in ranks if r) / n,
            "weak": sum(1 for r in rows if r["weak"]) / n,
        }

    overall = metrics(case_results)
    print("\n== ИТОГО ==")
    print(f"  n={overall['n']}  Hit@1={overall['hit1']:.1%}  Hit@3={overall['hit3']:.1%}  Hit@5={overall['hit5']:.1%}  MRR={overall['mrr']:.3f}  weak={overall['weak']:.1%}")
    by_tag: dict[str, dict] = {}
    for tag in sorted({r["tag"] for r in case_results}):
        by_tag[tag] = metrics([r for r in case_results if r["tag"] == tag])
        m = by_tag[tag]
        print(f"  {tag:10s} n={m['n']:2d}  Hit@1={m['hit1']:.0%}  Hit@3={m['hit3']:.0%}  Hit@5={m['hit5']:.0%}  MRR={m['mrr']:.2f}")

    out = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": args.source, "semantic": args.semantic, "max_variants": args.max_variants,
        "rewrite": args.rewrite, "rewrite_gate": args.rewrite_gate, "rewrite_mode": args.rewrite_mode, "rewrite_candidates": args.rewrite_candidates, "rewrite_vec_candidates": args.rewrite_vec_candidates, "extra_weight": args.extra_weight,
        "rerank": args.rerank, "rerank_provider": args.rerank_provider, "rerank_models": sorted(rerank_models),
        "rerank_errors": (rerank_errors or [])[:3],
        "manifest_builtAt": idx["manifest"].get("builtAt"),
        "overall": overall, "by_tag": by_tag, "cases": case_results, "took_s": round(time.time() - t0, 1),
    }
    tag = args.tag or f"{args.source}{'_sem' if args.semantic and args.source == 'hybrid' else ''}{'_rwcv' if args.rewrite_vec_candidates else ('_rwc' if args.rewrite_candidates else ('_rwg' if args.rewrite_gate else ('_rw' + args.rewrite_mode + str(args.extra_weight) if args.rewrite else '')))}{'_rr' if args.rerank else ''}"
    (EVAL_DIR / f"results_{tag}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nсохранено: scripts/eval/results_{tag}.json ({out['took_s']}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

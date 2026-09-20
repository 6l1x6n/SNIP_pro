"""verify_search.py — проверка точности поиска по прод-индексу (как в браузере)."""
import json, math, re, subprocess, urllib.request

BASE = "https://snippy-llm.pages.dev/index"
def _get(url, data=None, hdr=None):
    cmd = ["curl", "-s", "--compressed", url]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "--data", data]
    if hdr: cmd += ["-H", hdr]
    return subprocess.run(cmd, capture_output=True, check=True).stdout
J = lambda p: json.loads(_get(f"{BASE}/{p}"))

manifest = J("manifest.json")
docs = J("docs.json")
chunks = []
for k in range(manifest["shards"]["chunks"]):
    chunks += J(f"chunks_{k}.json")
scales = bytearray(); int8 = bytearray()
for k in range(manifest["shards"]["vectors"]):
    buf = _get(f"{BASE}/vectors_{k}.bin")
    assert buf[:4] == b"SNV1", buf[:4]
    dim = int.from_bytes(buf[4:8], "little")
    n = int.from_bytes(buf[8:12], "little")
    scales += buf[12:12 + 4 * n]
    int8 += buf[12 + 4 * n:12 + 4 * n + n * dim]
import struct
scales = struct.unpack(f"<{len(scales)//4}f", bytes(scales))
print(f"chunks={len(chunks)}, count={manifest['count']}, dim={dim}")

# Токенизатор — единый источник истины (как в eval_search.py), а не третья копия.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from build_index import tokenize  # noqa: E402

# BM25
bm25 = J("bm25.json")
POSTINGS, N = bm25["postings"], manifest["count"]
AVDL = bm25.get("avgdl") or bm25.get("avgDl") or sum(p.get("dl", p.get("len", 0)) for p in [POSTINGS[t][0]] for t in []) or None
# структура postings: term -> [df, [(idx,tf),...]]? печ.Unmarshal в engine — заглянем в ключи
k0 = next(iter(POSTINGS))
print("posting sample:", k0, str(POSTINGS[k0])[:120])

def bm25_scores(qtok):
    k1 = 1.2
    sc = {}
    for t in qtok:
        v = POSTINGS.get(t)
        if not v: continue
        df = len(v)
        idf = math.log(1 + (N - df + 0.5) / (df + 0.5))
        for idx, tf in v:
            sc[idx] = sc.get(idx, 0) + idf * tf / (tf + k1)
    return sc

def embed(q):
    out = _get("https://snip-worker.postalarchive.workers.dev/api/embed",
               data=json.dumps({"query": q}))
    return json.loads(out)["embedding"]

def search(query, k=3):
    qtok = tokenize(query)
    bm = bm25_scores(qtok)
    e = embed(query)
    vs = {}
    for i in range(manifest["count"]):
        off = i * dim
        dot = 0.0
        for j in range(dim):
            dot += (int8[off + j] - 128) * e[j]
        vs[i] = dot * scales[i]
    rrf = {}
    bm_rank = sorted(bm, key=lambda x: -bm[x])
    v_rank = sorted(vs, key=lambda x: -vs[x])
    for r, i in enumerate(bm_rank[:50]):
        rrf[i] = rrf.get(i, 0) + 1 / (60 + r + 1)
    for r, i in enumerate(v_rank[:50]):
        rrf[i] = rrf.get(i, 0) + 1 / (60 + r + 1)
    top = sorted(rrf, key=lambda x: -rrf[x])[:k]
    return [(chunks[i], rrf[i], vs[i]) for i in top]

TESTS = [
    "ширина коридора в жилых зданиях",
    "ширина лестничного марша в общественных зданиях",
    "снеговая нагрузка Алматы",
    "высота этажа жилого дома",
    "противопожарные расстояния между зданиями",
]
for t in TESTS:
    print("\n▶", t)
    for c, s, v in search(t):
        doc = docs[c["d"]]
        print(f"  [{s:.4f} vec={v:.2f}] {doc['number']} п.{c.get('p')} стр.{c.get('pg')}: {c['t'][:150]}...")

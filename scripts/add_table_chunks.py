"""add_table_chunks.py — хирургическое добавление таблиц (ty=table) в готовый индекс.

Полный build_index.py пере-извлекает все PDF и пере-эмбеддит чанки: час времени и
квота API. Здесь: достаём ТОЛЬКО таблицы (page.find_tables) → чанки, эмбеддим их
провайдером из manifest (векторная модель в индексе одна!), дописываем в хвост
chunks/vectors (порядок прозы не трогаем — golden и кэш векторов валидны),
затем shard_index.py и rebuild_text_index.py досчитают bm25/values/builtAt.

PDF обрабатываются в subprocess-пуле: зависший документ (кривой скан в OCR/fitz)
убивается по таймауту, а не топит всю сборку (signal.alarm не пробивает
блокирующие C-вызовы).

Запуск:  python3 -u scripts/add_table_chunks.py [--timeout 600] [--index frontend/public/index]
Затем:   python3 scripts/shard_index.py && python3 scripts/rebuild_text_index.py
"""

import argparse
import json
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_index import SUPPORTED_EXTS, parse_doc_meta, _quantize_one  # noqa: E402


# ---------- 1. Извлечение таблиц (в отдельном процессе) ----------

def extract_doc_tables(file_path: str) -> list[dict]:
    """Только табличные псевдо-страницы документа → черновые чанки."""
    import re
    sys.path.insert(0, str(ROOT / "scripts"))
    from pipeline.extractor import PDFExtractor
    from pipeline.chunker import SNIPChunker

    path = Path(file_path)
    ex = PDFExtractor().extract(path)
    table_pages = [p for p in ex.pages if p.table]
    if not table_pages:
        return []
    ch = SNIPChunker()
    raw = ch.chunk([{"page": p.page_num, "text": p.text, "ty": "table"} for p in table_pages],
                   {"title": ex.title})
    return [{"p": c.paragraph or "", "pg": c.page, "t": c.text, "ty": "table"} for c in raw]


def collect_table_chunks(input_dir: Path, meta_all: dict, timeout: int) -> list[tuple[dict, list[dict]]]:
    """[(doc_info, [черновые чанки])] — только PDF; txt/docx идут через make_doc без таблиц."""
    files = sorted(
        (f for f in input_dir.rglob("*")
         if f.is_file() and f.suffix.lower() in SUPPORTED_EXTS and not f.name.startswith(".")),
        key=lambda f: str(f.relative_to(input_dir)).lower(),
    )
    pdfs = []
    for f in files:
        info = parse_doc_meta(f, meta_all)
        if not info.get("skip") and f.suffix.lower() == ".pdf":
            pdfs.append((f, info))
    out: list[tuple[dict, list[dict]]] = []
    with ProcessPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(extract_doc_tables, str(f)): (f, info) for f, info in pdfs}
        for fut, (f, info) in futures.items():
            try:
                chunks = fut.result(timeout=timeout)
            except Exception as e:
                print(f"  ⚠️ {f.name}: таблицы пропущены ({type(e).__name__}: {str(e)[:80]})")
                continue
            if chunks:
                print(f"  {info['number']}: {len(chunks)} табличных чанков")
                out.append((info, chunks))
    return out


# ---------- 2. Эмбеддинг табличных чанков (провайдер из манифеста) ----------

def embed_texts(texts: list[str], provider: str, model: str, dim: int, batch: int = 96) -> list[tuple[float, bytes]]:
    from pipeline.provider import get_fallback_chain
    chain = [(n, e) for n, e in get_fallback_chain() if n == provider and getattr(e, "model", "") == model]
    if not chain:
        sys.exit(f"провайдер {provider}/{model} недоступен — нет ключа в .env; индекс нельзя мешать с другой моделью")
    _, embedder = chain[0]
    if embedder.dim != dim:
        sys.exit(f"dim провайдера {embedder.dim} != dim индекса {dim}")

    import asyncio

    out: list[tuple[float, bytes]] = []
    t_start = time.time()

    async def _run() -> None:
        # один event loop на все батчи: httpx.AsyncClient провайдера привязан к нему
        for i in range(0, len(texts), batch):
            part = texts[i:i + batch]
            for attempt in range(20):
                try:
                    vecs = await embedder.embed(part)
                    break
                except Exception as e:
                    msg = str(e)[:100]
                    if attempt == 19:
                        raise
                    wait = 60 if "429" in msg or "rate" in msg.lower() else 5 * (attempt + 1)
                    print(f"  [{i}/{len(texts)}] retry {attempt + 1}: {msg} — ждём {wait}s", flush=True)
                    await asyncio.sleep(wait)
            for v in vecs:
                out.append(_quantize_one(v))
            done = min(i + batch, len(texts))
            rate = done / max(1e-9, time.time() - t_start)
            eta = (len(texts) - done) / max(1e-9, rate)
            print(f"  {done}/{len(texts)} векторов ({rate:.0f}/s, ETA {eta:.0f}s)", flush=True)

    asyncio.run(_run())
    return out


# ---------- 3. Дописывание в индекс ----------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "norms"))
    ap.add_argument("--index", default=str(ROOT / "frontend" / "public" / "index"))
    ap.add_argument("--timeout", type=int, default=600, help="секунд на документ (зависшие убиваются)")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--provider", default="",
                    help="переключить провайдер индекса (например mistral): ПОЛНАЯ пере-эмбеддировка "
                         "всех текстов чанков из готового индекса + таблицы. Смешивать векторы "
                         "разных моделей нельзя — без этого флага таблицы эмбеддятся текущим провайдером")
    args = ap.parse_args()
    out = Path(args.index)

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    cur_provider, cur_model, cur_dim = manifest["provider"], manifest["model"], manifest["dim"]

    from pipeline.provider import get_fallback_chain

    # целевой провайдер
    if args.provider:
        chain = [(n, e) for n, e in get_fallback_chain() if n == args.provider]
        if not chain:
            sys.exit(f"провайдер {args.provider} недоступен — нет ключа в .env")
        _, emb = chain[0]
        new_provider, new_model, new_dim = args.provider, getattr(emb, "model", ""), emb.dim
        print(f"переключение провайдера: {cur_provider}/{cur_model} → {new_provider}/{new_model} ({new_dim}d)")
        if new_dim != cur_dim:
            print(f"  ⚠️ dim меняется {cur_dim} → {new_dim}: engine адаптируется по manifest (проверь UI)")
        target = (new_provider, new_model, new_dim)
        reembed_all = True
    else:
        target = (cur_provider, cur_model, cur_dim)
        reembed_all = False

    provider, model, dim = target
    meta_all = {}
    meta_file = Path(args.input) / "meta.json"
    if meta_file.exists():
        meta_all = json.loads(meta_file.read_text(encoding="utf-8"))

    # ---- чанки существующего индекса (порядок не трогаем) ----
    existing: set[str] = set()
    k = 0
    while (out / f"chunks_{k}.json").exists():
        for c in json.loads((out / f"chunks_{k}.json").read_text(encoding="utf-8")):
            existing.add(c["t"])
        k += 1
    n_before = sum(len(json.loads((out / f"chunks_{j}.json").read_text(encoding="utf-8"))) for j in range(k))

    print("── 1/4 извлечение таблиц (пул процессов, timeout", args.timeout, "s)")
    per_doc = collect_table_chunks(Path(args.input), meta_all, args.timeout)
    draft: list[dict] = []
    for info, chunks in per_doc:
        for c in chunks:
            c["number"] = info["number"]
            draft.append(c)
    print(f"табличных чанков: {len(draft)}")

    # doc id = номер документа в docs.json (документы уже в индексе)
    docs = json.loads((out / "docs.json").read_text(encoding="utf-8"))
    num_to_id = {d["number"]: d["id"] for d in docs}
    unknown = {c["number"] for c in draft if c["number"] not in num_to_id}
    if unknown:
        print(f"  ⚠️ нет в docs.json (скипаю): {sorted(unknown)}")
        draft = [c for c in draft if c["number"] in num_to_id]

    draft = [c for c in draft if c["t"] not in existing]
    print(f"после дедупликации: {len(draft)} (уникальных табличных текстов)")

    # ---- эмбеддинг ----
    if reembed_all:
        # тексты прозы берём из готового индекса (PDF заново НЕ извлекаем)
        prose_texts: list[str] = []
        for j in range(k):
            for c in json.loads((out / f"chunks_{j}.json").read_text(encoding="utf-8")):
                prose_texts.append(c["t"])
        print(f"── 2/4 полная пере-эмбеддировка {len(prose_texts)} + {len(draft)} текстов через {provider}/{model}")
        vecs_prose = embed_texts(prose_texts, provider, model, dim, args.batch)
        vecs_tables = embed_texts([c["t"] for c in draft], provider, model, dim, args.batch) if draft else []
    else:
        if not draft:
            print("все таблицы уже в индексе — нечего делать")
            return
        print(f"── 2/4 эмбеддинг {len(draft)} таблиц через {provider}/{model}")
        vecs_prose = None
        vecs_tables = embed_texts([c["t"] for c in draft], provider, model, dim, args.batch)

    print("── 3/4 дописываю chunks и vectors")
    if draft:
        # чанки: дописываем в ПОСЛЕДНИЙ шард чанков (индексы прозы не двигаются)
        last = k - 1
        chunks_last = json.loads((out / f"chunks_{last}.json").read_text(encoding="utf-8"))
        for j, c in enumerate(draft):
            chunks_last.append({
                "i": n_before + j,
                "d": num_to_id[c["number"]],
                "p": c["p"], "pg": c["pg"], "t": c["t"], "ty": c["ty"],
            })
        (out / f"chunks_{last}.json").write_text(json.dumps(chunks_last, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # vectors: склеить шарды → (при переключении заменить) → дописать → vectors.bin
    if reembed_all:
        assert vecs_prose is not None and len(vecs_prose) == n_before, \
            f"пере-эмбеддировка покрыла {len(vecs_prose) if vecs_prose else 0}/{n_before} — не та длина"
        scales, data = [s for s, _ in vecs_prose], bytearray(b"".join(q for _, q in vecs_prose))
        total = n_before
    else:
        scales, data = [], bytearray()
        total = 0
        sd = 0
        while (out / f"vectors_{sd}.bin").exists():
            raw = (out / f"vectors_{sd}.bin").read_bytes()
            magic, d, n = struct.unpack_from("<4sII", raw, 0)
            assert magic == b"SNV1" and d == dim
            scales += list(struct.unpack_from(f"<{n}f", raw, 12))
            data += raw[12 + 4 * n:]
            total += n
            sd += 1
        assert total == n_before, f"векторов {total} != чанков {n_before}"
    for s, q in vecs_tables:
        scales.append(s)
        data += q
    (out / "vectors.bin").write_bytes(
        struct.pack("<4sII", b"SNV1", dim, total + len(vecs_tables))
        + struct.pack(f"<{total + len(vecs_tables)}f", *scales) + bytes(data))
    for sd in range(40):
        p = out / f"vectors_{sd}.bin"
        if p.exists():
            p.unlink()

    print("── 4/4 shard_index.py (перешардирование) + manifest")
    manifest["count"] = n_before + len(draft)
    if reembed_all:
        manifest["provider"], manifest["model"], manifest["dim"] = provider, model, dim
    if draft:
        manifest["tables"] = {"version": 1, "chunks": len(draft)}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    import subprocess
    subprocess.run([sys.executable, str(ROOT / "scripts" / "shard_index.py")], check=True)
    print("готово: теперь запусти scripts/rebuild_text_index.py (bm25/values/builtAt)")


if __name__ == "__main__":
    main()

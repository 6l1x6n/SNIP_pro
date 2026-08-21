"""
build_index.py — оффлайн-сборка статического поискового индекса SNIP.

Вход:  norms/*.pdf (пакет нормативки; опционально norms/meta.json с номерами/названиями)
Выход: frontend/public/index/{manifest.json, docs.json, chunks.json, vectors.bin, bm25.json, synonyms.json}

Запуск:
  /opt/homebrew/bin/python3 scripts/build_index.py                 # norms/ + демо-документы
  /opt/homebrew/bin/python3 scripts/build_index.py --no-demo       # только norms/
  /opt/homebrew/bin/python3 scripts/build_index.py --input DIR --out DIR

Токенизация ДОЛЖНА совпадать 1:1 с JS-портом в frontend/src/search/engine.ts:
нижний регистр, ё→е, токены [а-яa-z0-9]+, стоп-слова, отсечение ОДНОГО суффикса.
"""
import sys
import json
import re
import time
import struct
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

# ---------- Токенизатор (зеркалится в engine.ts) ----------

STOPWORDS = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по
только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть
был него до вас нибудь опять уж вам сказал ведь там потом себя ничего ей может они тут где есть надо
ней для мы тебя их чем была сам чтоб без будто человек чего раз тоже себе под жизнь будет ж тогда кто
этот говорил того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее кажется сейчас
были куда зачем сказать всех никогда сегодня можно при наконец два об другой хоть после над больше тот
через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше
чуть том нельзя такой им более всегда конечно всю между это который которые которых также очень своих
таких является""".split())

SUFFIXES = sorted([
    "ования", "ование", "ениями", "ение", "ениям", "ениях", "ироваться",
    "ирован", "ировать", "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими",
    "ая", "ое", "ые", "ий", "ый", "ой", "ей", "ом", "ем", "ах", "ях", "ую", "юю",
    "ее", "ии", "ия", "ие", "ов", "ев", "ь", "а", "я", "о", "е", "у", "ю", "ы", "и", "й",
], key=len, reverse=True)

TOKEN_RE = re.compile(r"[а-яa-z0-9]+")

def tokenize(text: str) -> list[str]:
    out = []
    for w in TOKEN_RE.findall(text.lower().replace("ё", "е")):
        if w in STOPWORDS or len(w) < 2:
            continue
        if w.isdigit():
            out.append(w)
            continue
        for suf in SUFFIXES:
            if w.endswith(suf) and len(w) - len(suf) >= 3 and not suf.isdigit():
                w = w[: -len(suf)]
                break
        if w not in STOPWORDS and len(w) >= 2:
            out.append(w)
    return out

# ---------- Демо-корпус (те же тексты, что были в seed.py) ----------

DEMO_DOCS = [
    {
        "number": "СН РК 3.02-43-2011",
        "title": "Жилые здания. Строительные нормы Республики Казахстан",
        "type": "СН РК", "status": "active",
        "chunks": [
            ("5.8", 42, "Ширина коридоров в жилых зданиях должна быть не менее 1,4 м при длине коридора до 10 м и не менее 1,6 м при большей длине. Ширина коридоров, ведущих к эвакуационным выходам, должна быть не менее 1,2 м."),
            ("5.9", 42, "Ширина эвакуационных путей и выходов должна обеспечивать беспрепятственное движение людей. Минимальная ширина эвакуационного выхода из помещения — 0,9 м, из здания — 1,2 м. Высота эвакуационных путей в свету — не менее 2,0 м."),
            ("6.12", 55, "Лестничные клетки в жилых зданиях должны иметь ширину марша не менее 1,05 м. Ширина лестничной площадки — не менее ширины марша. Уклон марша — не более 1:1,5."),
            ("7.3", 60, "Минимальная высота жилых помещений от пола до потолка — 2,5 м, в климатических районах с повышенной влажностью — 2,7 м. Высота коридоров и холлов — не менее 2,1 м."),
        ],
    },
    {
        "number": "СП РК 3.02-101-2012",
        "title": "Общественные здания и сооружения. Свод правил Республики Казахстан",
        "type": "СП РК", "status": "active",
        "chunks": [
            ("4.15", 28, "Ширина коридоров в общественных зданиях при двустороннем расположении помещений — не менее 1,5 м, при одностороннем — не менее 1,3 м. Ширина проходов, ведущих к эвакуационным выходам, — не менее 1,2 м."),
            ("4.16", 28, "Ширина эвакуационных коридоров, по которым могут эвакуироваться более 50 человек, должна быть не менее 1,2 м. Двери на путях эвакуации должны открываться по направлению выхода."),
            ("5.22", 35, "Минимальная ширина лестничного марша в общественных зданиях — 1,35 м для зданий с числом пребывающих более 200 человек, 1,2 м — для остальных. Ширина лестничной площадки — не менее ширины марша."),
            ("6.4", 40, "Расстояние между зданиями определяется в зависимости от степени огнестойкости и должно быть не менее 6 м для зданий I-II степени и не менее 8 м для III степени огнестойкости."),
        ],
    },
    {
        "number": "СН РК 2.02-01-2014",
        "title": "Пожарная безопасность зданий и сооружений. Строительные нормы РК",
        "type": "СН РК", "status": "active",
        "chunks": [
            ("8.1.3", 15, "Ширина эвакуационных путей должна быть не менее 1,0 м, дверей — не менее 0,8 м. При числе эвакуирующихся более 50 человек ширина прохода — не менее 1,2 м."),
            ("8.2.1", 16, "Эвакуационные лестничные клетки должны иметь ширину марша не менее 1,15 м. Двери выходов из лестничных клеток — не менее 0,9 м."),
            ("9.4", 20, "Минимальная ширина прохода (коридора) для маломобильных групп населения — 1,5 м, площадки для разворота кресла-коляски — 1,8×1,8 м."),
        ],
    },
]

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

DOC_NUMBER_RE = re.compile(r"(?:СН|СП|СТ|СНиП|ГОСТ)[\s._-]*РК?[\s._-]*[\d.]+-?\d*", re.IGNORECASE)


def parse_doc_meta(pdf_path: Path, meta_all: dict) -> dict:
    key = pdf_path.stem
    m = meta_all.get(key) or meta_all.get(pdf_path.name) or {}
    number = m.get("number")
    if not number:
        found = DOC_NUMBER_RE.search(pdf_path.stem.replace("_", " "))
        number = found.group(0).replace("_", " ").strip() if found else pdf_path.stem
    return {"number": number, "title": m.get("title") or pdf_path.stem.replace("_", " "), "status": m.get("status", "active")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "norms"))
    ap.add_argument("--out", default=str(ROOT / "frontend" / "public" / "index"))
    ap.add_argument("--no-demo", action="store_true", help="не добавлять встроенные демо-документы")
    ap.add_argument("--batch", type=int, default=64)
    args = ap.parse_args()

    from app.pipeline.extractor import PDFExtractor
    from app.pipeline.chunker import SNIPChunker
    from app.embeddings.provider import get_embedding_provider

    input_dir = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    meta_all = {}
    meta_file = input_dir / "meta.json"
    if meta_file.exists():
        meta_all = json.loads(meta_file.read_text(encoding="utf-8"))

    # ---- 1. Собираем чанки ----
    docs = []          # {id, number, title, status, pages}
    chunks = []        # {d, p, pg, t, ty}
    extractor = PDFExtractor()
    chunker = SNIPChunker()

    pdfs = sorted(input_dir.glob("*.pdf")) if input_dir.exists() else []
    print(f"PDF в {input_dir}: {len(pdfs)}")

    for pdf_path in pdfs:
        print(f"  extract: {pdf_path.name}")
        doc_info = parse_doc_meta(pdf_path, meta_all)
        extracted = extractor.extract(pdf_path)
        if extracted.is_scanned:
            print(f"    скан → OCR fallback")
            extracted = extractor.extract_with_ocr(pdf_path, lang="rus+eng")
        raw_chunks = chunker.chunk_extracted(extracted)
        d_idx = len(docs)
        docs.append({
            "id": str(d_idx), "number": doc_info["number"], "title": doc_info["title"],
            "status": doc_info["status"], "pages": extracted.total_pages,
            "file": pdf_path.name,
        })
        for c in raw_chunks:
            chunks.append({"d": d_idx, "p": c.paragraph or "", "pg": c.page, "t": c.text, "ty": c.type})
        print(f"    -> {len(raw_chunks)} чанков ({doc_info['number']})")

    if not args.no_demo:
        for dd in DEMO_DOCS:
            d_idx = len(docs)
            docs.append({"id": str(d_idx), "number": dd["number"], "title": dd["title"],
                         "status": dd["status"], "pages": 100, "file": ""})
            n0 = len(chunks)
            for para, page, text in dd["chunks"]:
                chunks.append({"d": d_idx, "p": para, "pg": page, "t": text, "ty": "paragraph"})
            print(f"демо: {dd['number']} -> {len(chunks) - n0} чанков")

    if not chunks:
        print("Нет чанков — положи PDF в norms/ или убери --no-demo"); sys.exit(1)

    # ---- 2. Эмбеддинги ----
    embedder = get_embedding_provider()
    dim = None
    vectors = []  # float lists
    t0 = time.time()
    B = args.batch
    for i in range(0, len(chunks), B):
        batch_texts = [c["t"][:8000] for c in chunks[i : i + B]]
        embs = _embed_sync(embedder, batch_texts)
        if dim is None:
            dim = len(embs[0])
        vectors.extend(embs)
        done = min(i + B, len(chunks))
        print(f"embed {done}/{len(chunks)} ({time.time()-t0:.0f}s)")
        if i + B < len(chunks):
            time.sleep(2)

    # ---- 3. Квантование int8 (per-vector scale) ----
    scales = []
    q = bytearray()
    for v in vectors:
        s = max(max(v), -min(v)) / 127.0 or 1.0
        scales.append(s)
        q.extend((max(-128, min(127, round(x / s))) & 0xFF) for x in v)

    vec_bin = struct.pack("<4sII", b"SNV1", dim, len(vectors)) + struct.pack(f"<{len(scales)}f", *scales) + bytes(q)
    (out_dir / "vectors.bin").write_bytes(vec_bin)
    print(f"vectors.bin: {len(vec_bin)/1024:.0f} KB ({len(vectors)} x {dim}d int8)")

    # ---- 4. BM25 инвертированный индекс ----
    postings: dict[str, list] = {}
    doc_len = []
    for idx, c in enumerate(chunks):
        toks = tokenize(c["t"])
        doc_len.append(len(toks))
        tf: dict[str, int] = {}
        for tok in toks:
            tf[tok] = tf.get(tok, 0) + 1
        for term, freq in tf.items():
            postings.setdefault(term, []).append([idx, freq])
    avgdl = sum(doc_len) / max(1, len(doc_len))
    bm25 = {"k1": 1.2, "b": 0.75, "avgdl": round(avgdl, 2),
            "len": doc_len,
            "postings": {term: plist for term, plist in sorted(postings.items())}}
    (out_dir / "bm25.json").write_text(json.dumps(bm25, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"bm25.json: {len(postings)} терминов")

    # ---- 5. Прочие артефакты ----
    compact = [{"i": k, "d": c["d"], "p": c["p"], "pg": c["pg"], "t": c["t"], "ty": c["ty"]} for k, c in enumerate(chunks)]
    (out_dir / "chunks.json").write_text(json.dumps(compact, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out_dir / "docs.json").write_text(json.dumps(docs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out_dir / "synonyms.json").write_text(json.dumps(SYNONYMS, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    manifest = {
        "version": 1,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dim": dim, "count": len(chunks), "quantization": "int8-per-vector",
        "model": getattr(embedder, "model", "unknown"),
        "bm25": {"k1": 1.2, "b": 0.75},
        "rrfK": 60,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    total_kb = sum(f.stat().st_size for f in out_dir.iterdir()) / 1024
    print(f"\nГотово: {out_dir} ({total_kb:.0f} KB суммарно)")


def _embed_sync(embedder, texts):
    import asyncio
    return asyncio.run(embedder.embed(texts))


if __name__ == "__main__":
    main()

"""
build_index.py — оффлайн-сборка статического поискового индекса SNIP.

Вход:  «СНиП РК»/**/*.{pdf,docx,doc,txt} — рекурсивно, все подпапки
       (опционально meta.json в корне папки с номерами/названиями)
Выход: frontend/public/index/{manifest.json, docs.json, chunks.json, vectors.bin, bm25.json, synonyms.json}

Запуск:
  /opt/homebrew/bin/python3 scripts/build_index.py                 # папка «СНиП РК»
  /opt/homebrew/bin/python3 scripts/build_index.py --with-demo     # «СНиП РК» + демо-документы
  /opt/homebrew/bin/python3 scripts/build_index.py --no-input      # только демо (для тестов)
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
    clean_stem = pdf_path.stem.replace("_", " ").replace("+", " ")
    m = meta_all.get(key) or meta_all.get(pdf_path.name) or {}
    number = m.get("number")
    if not number:
        found = DOC_NUMBER_RE.search(clean_stem)
        number = found.group(0).replace("_", " ").replace("+", " ").strip() if found else clean_stem
    return {"number": number, "title": m.get("title") or clean_stem, "status": m.get("status", "active")}


# ---------- Извлечение текста из PDF/DOCX/DOC/TXT ----------

SUPPORTED_EXTS = {".pdf", ".docx", ".doc", ".txt"}
_DOCX_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def extract_text(path: Path) -> str:
    """Текст из .txt / .docx / .doc (для .pdf используется PDFExtractor)."""
    ext = path.suffix.lower()
    if ext == ".txt":
        return _extract_txt(path)
    if ext == ".docx":
        return _extract_docx(path)
    if ext == ".doc":
        return _extract_doc(path)
    raise ValueError(f"Неподдерживаемый формат: {ext}")


def _extract_txt(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8", "cp1251"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def _extract_docx(path: Path) -> str:
    """DOCX = zip с word/document.xml; достаём абзацы без внешних зависимостей."""
    import zipfile
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    paras = []
    for p in root.iter(f"{_DOCX_NS}p"):
        line = "".join(t.text or "" for t in p.iter(f"{_DOCX_NS}t")).strip()
        if line:
            paras.append(line)
    return "\n".join(paras)


def _extract_doc(path: Path) -> str:
    """Старый бинарный .doc: на macOS конвертируем штатным textutil, иначе эвристика по байтам."""
    import subprocess

    try:
        out = subprocess.run(
            ["textutil", "-convert", "txt", "-stdout", str(path)],
            capture_output=True, timeout=120,
        )
        if out.returncode == 0:
            text = out.stdout.decode("utf-8", errors="ignore")
            if len(text.strip()) > 200:
                return text
    except Exception:
        pass
    return _scrape_doc_binary(path)


def _scrape_doc_binary(path: Path) -> str:
    """Fallback без textutil: вытягиваем читаемые строки из OLE-бинарника (utf-16le/cp1251)."""
    def readable(s: str) -> bool:
        if len(s) < 12:
            return False
        good = sum(1 for ch in s if ch.isalnum() or ch.isspace() or ch in ".,;:!?()%№+-–—«»\"'/")
        return good / len(s) > 0.85

    data = path.read_bytes()
    lines, seen = [], set()
    for enc in ("utf-16-le", "cp1251"):
        for line in data.decode(enc, errors="ignore").split("\n"):
            line = line.strip()
            key = line[:80]
            if readable(line) and key not in seen:
                seen.add(key)
                lines.append(line)
    return "\n".join(lines)


def make_doc(title: str, text: str, source_format: str):
    """Сплошной текст -> ExtractedDoc с псевдо-страницами (~3000 символов), как у PDF."""
    from app.pipeline.extractor import PageText, ExtractedDoc

    pages, buf, size = [], [], 0
    for line in text.splitlines():
        buf.append(line)
        size += len(line) + 1
        if size >= 3000:
            pages.append(PageText(page_num=len(pages) + 1, text="\n".join(buf), has_text=True))
            buf, size = [], 0
    tail = "\n".join(buf)
    if tail or not pages:
        pages.append(PageText(page_num=len(pages) + 1, text=tail, has_text=len(tail.strip()) > 40))
    return ExtractedDoc(title=title, pages=pages, total_pages=len(pages),
                        is_scanned=False, metadata={"source_format": source_format})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "СНиП РК"))
    ap.add_argument("--out", default=str(ROOT / "frontend" / "public" / "index"))
    ap.add_argument("--no-input", action="store_true", help="не читать «СНиП РК» (только демо)")
    ap.add_argument("--with-demo", action="store_true", help="добавить встроенные демо-документы")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--provider", default="", help="форсировать провайдера: gemini|jina|voyage|cohere|mistral")
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

    files = []
    if not args.no_input and input_dir.exists():
        files = sorted(
            (f for f in input_dir.rglob("*")
             if f.is_file() and f.suffix.lower() in SUPPORTED_EXTS and not f.name.startswith(".")),
            key=lambda f: str(f.relative_to(input_dir)).lower(),
        )
    if not args.no_input:
        print(f"Файлов в {input_dir}: {len(files)} ({', '.join(sorted(SUPPORTED_EXTS))})")

    for file_path in files:
        rel = file_path.relative_to(input_dir)
        ext = file_path.suffix.lower()
        print(f"  extract[{ext}]: {rel}")
        doc_info = parse_doc_meta(file_path, meta_all)
        if ext == ".pdf":
            extracted = extractor.extract(file_path)
            if extracted.is_scanned:
                print(f"    скан → OCR fallback")
                extracted = extractor.extract_with_ocr(file_path, lang="rus+eng")
        else:
            try:
                text = extract_text(file_path)
            except Exception as e:
                print(f"    ⚠️ пропуск: {e}")
                continue
            if len(text.strip()) < 100:
                print(f"    ⚠️ пустой документ — пропуск")
                continue
            extracted = make_doc(doc_info["title"], text, ext.lstrip("."))
        raw_chunks = chunker.chunk_extracted(extracted)
        d_idx = len(docs)
        docs.append({
            "id": str(d_idx), "number": doc_info["number"], "title": doc_info["title"],
            "status": doc_info["status"], "pages": extracted.total_pages,
            "file": file_path.name,
        })
        for c in raw_chunks:
            chunks.append({"d": d_idx, "p": c.paragraph or "", "pg": c.page, "t": c.text, "ty": c.type})
        print(f"    -> {len(raw_chunks)} чанков ({doc_info['number']})")

    if args.with_demo:
        for dd in DEMO_DOCS:
            d_idx = len(docs)
            docs.append({"id": str(d_idx), "number": dd["number"], "title": dd["title"],
                         "status": dd["status"], "pages": 100, "file": ""})
            n0 = len(chunks)
            for para, page, text in dd["chunks"]:
                chunks.append({"d": d_idx, "p": para, "pg": page, "t": text, "ty": "paragraph"})
            print(f"демо: {dd['number']} -> {len(chunks) - n0} чанков")

    if not chunks:
        print("Нет чанков — положи файлы (pdf/docx/doc/txt) в «СНиП РК» или включи --with-demo"); sys.exit(1)

    # ---- 2. Эмбеддинги: цепочка «мощные → хорошие → средние» ----
    # Весь индекс строится ОДНИМ провайдером; если его квота исчерпана —
    # берём следующего. Выбранный пишем в manifest.json, воркер /api/embed
    # читает его и эмбеддит запросы той же моделью.
    from app.embeddings.provider import get_fallback_chain

    chain = get_fallback_chain()
    if args.provider:
        chain = [(n, e) for n, e in chain if n == args.provider]
        if not chain:
            sys.exit(f"Провайдер '{args.provider}' недоступен — нет ключа в backend/.env")
    if not chain:
        sys.exit("Нет ни одного ключа эмбеддингов (GEMINI/JINA/VOYAGE/COHERE/MISTRAL_API_KEY)\n"
                 "Добавьте хотя бы один в backend/.env — все бесплатные, без карты")
    print("Цепочка провайдеров:", " → ".join(n for n, _ in chain))

    global _GOOD_SIZE
    vectors = None
    chosen = None
    dim = None
    for pname, embedder in chain:
        _GOOD_SIZE = None  # у каждого API свои лимиты — ищем заново
        print(f"── эмбеддинги через {pname} ({getattr(embedder, 'model', '?')}, {embedder.dim}d)")
        try:
            vs: list = []
            dim = None
            t0 = time.time()
            B = args.batch
            for i in range(0, len(chunks), B):
                batch_texts = [c["t"][:8000] for c in chunks[i : i + B]]
                embs = _embed_sync(embedder, batch_texts)
                if dim is None:
                    dim = len(embs[0])
                vs.extend(embs)
                done = min(i + B, len(chunks))
                print(f"embed {done}/{len(chunks)} ({time.time()-t0:.0f}s)")
            vectors, chosen = vs, pname
            break
        except Exception as e:
            print(f"⚠️ {pname} не подошёл: {e}")
            print("   → переключаюсь на следующего провайдера цепочки")
            continue
    if vectors is None:
        sys.exit("Все провайдеры цепочки исчерпали квоты — попробуйте позже или добавьте ещё ключей")

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
        "provider": chosen,
        "model": next(e.model for n, e in chain if n == chosen),
        "bm25": {"k1": 1.2, "b": 0.75},
        "rrfK": 60,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    total_kb = sum(f.stat().st_size for f in out_dir.iterdir()) / 1024
    print(f"\nГотово: {out_dir} ({total_kb:.0f} KB суммарно)")


_EMBED_LOOP = None  # один цикл на все батчи: httpx.AsyncClient привязан к первому loop
_GOOD_SIZE = None  # последний размер запроса, который прошёл без 429 — к нему и стремимся

def _embed_sync(embedder, texts, _depth=0):
    """Батч с защитой от 429 free-tier: пара пауз с backoff, затем АДАПТИВНОЕ дробление
    (делим на 4 — так быстрее находим проходящий размер). Найденный размер запоминаем
    в _GOOD_SIZE, чтобы следующие батчи сразу резать по нему."""
    import asyncio
    global _EMBED_LOOP, _GOOD_SIZE
    if _EMBED_LOOP is None or _EMBED_LOOP.is_closed():
        _EMBED_LOOP = asyncio.new_event_loop()
    # уже знаем проходящий размер — режем сразу, без лишних 429
    if _GOOD_SIZE and len(texts) > _GOOD_SIZE:
        out = []
        for i in range(0, len(texts), _GOOD_SIZE):
            out.extend(_embed_sync(embedder, texts[i:i + _GOOD_SIZE], _depth))
            time.sleep(1)
        return out
    delay = 65.0
    for attempt in range(6):
        try:
            res = _EMBED_LOOP.run_until_complete(embedder.embed(texts))
            _GOOD_SIZE = max(_GOOD_SIZE or 0, len(texts))
            return res
        except Exception as e:
            msg = str(e)
            low = msg.lower()
            rate_limited = "429" in msg or "too many requests" in low or "retries exhausted" in msg
            # разовые сетевые глоки (TLS, таймауты, разрывы) — не повод хоронить провайдера
            transient = (not rate_limited) and (
                any(t in low for t in ("ssl", "bad record mac", "timeout", "timed out",
                                       "connection", "reset by peer", "broken pipe",
                                       "eof occurred", "network"))
                or isinstance(e, (TimeoutError, ConnectionError))
            )
            if not rate_limited and not transient:
                raise
            # квота держится даже после пауз — дробим батч на четверти;
            # сетевые сбои просто перетраиваем тем же размером
            if rate_limited and attempt >= 2 and len(texts) > 1 and _depth < 10:
                part = max(1, len(texts) // 4)
                print(f"    ↯ 429 держится — дроблю батч {len(texts)} на {part}+{len(texts) - part}")
                return (_embed_sync(embedder, texts[:part], _depth + 1)
                        + _embed_sync(embedder, texts[part:], _depth + 1))
            pause = min(delay, 300) if rate_limited else min(20 * (attempt + 1), 90)
            kind = "429 rate limit" if rate_limited else "сетевой сбой"
            print(f"    ⚠️ {kind}, пауза {pause:.0f}s (попытка {attempt + 1}/6): {msg[:80]}")
            time.sleep(pause)
            if rate_limited:
                delay = min(delay * 2, 300)
    # попытки исчерпаны — последняя надежда на дробление
    if len(texts) > 1 and _depth < 10:
        part = max(1, len(texts) // 4)
        return (_embed_sync(embedder, texts[:part], _depth + 1)
                + _embed_sync(embedder, texts[part:], _depth + 1))
    raise RuntimeError("эмбеддинг недоступен: повторные сетевые сбои или исчерпанная квота")


if __name__ == "__main__":
    main()

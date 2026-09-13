"""
rebuild_text_index.py — хирургическая пересборка ТЕКСТОВЫХ артефактов индекса.

Полный build_index.py тянет PDF-экстракцию всех норм + платные эмбеддинги.
Здесь: читаем готовые chunks_*.json + docs.json, перестраиваем только
  - bm25.json (новый токенизатор: цифры + числительные словами → цифры),
  - synonyms.json (из SYNONYMS build_index.py),
  - values.json (свежий values_extract),
  - manifest.json (тот же dim/count/provider/model, новый builtAt + values.count).

Векторы/chunks/docs не трогаем — квоты API не тратятся.
Новый builtAt инвалидирует ask_cache (ключ содержит тег сборки) — отравленные
ответы («Да на 7 этаже», «стр.101») смываются автоматически.

Запуск:  python3 scripts/rebuild_text_index.py [--index frontend/public/index]
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))

from build_index import tokenize, SYNONYMS  # noqa: E402
from values_extract import extract_values  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=str(ROOT / "frontend" / "public" / "index"))
    args = ap.parse_args()
    out = Path(args.index)

    # чанки — строго по порядку шардов (глобальный индекс = позиция в конкатенации)
    shard_files = sorted(out.glob("chunks_*.json"),
                         key=lambda p: int(p.stem.split("_")[1]))
    if not shard_files:
        sys.exit(f"нет chunks_*.json в {out}")
    chunks: list = []
    for fn in shard_files:
        chunks.extend(json.loads(fn.read_text(encoding="utf-8")))
    print(f"чанков: {len(chunks)} из {len(shard_files)} шардов")

    # values.json — свежий экстракт (позиции i совпадают с порядком чанков)
    for ci, c in enumerate(chunks):
        c["i"] = ci
    values = extract_values(chunks)
    (out / "values.json").write_text(
        json.dumps({"version": 1, "count": len(values), "facts": values},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    print(f"values.json: {len(values)} фактов")

    # bm25.json — тот же формат, что в build_index.py §4
    postings: dict[str, list] = {}
    doc_len = []
    for idx, c in enumerate(chunks):
        toks = tokenize(c.get("t") or "")
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
    (out / "bm25.json").write_text(json.dumps(bm25, ensure_ascii=False, separators=(",", ":")),
                                   encoding="utf-8")
    print(f"bm25.json: {len(postings)} терминов, avgdl={avgdl:.2f}")

    # sanity: цифры и словоформы в постинге
    for probe in ("7", "5", "этаж"):
        print(f"  postings[{probe}]: {'ЕСТЬ df=' + str(len(postings[probe])) if probe in postings else 'НЕТ'}")

    (out / "synonyms.json").write_text(json.dumps(SYNONYMS, ensure_ascii=False, separators=(",", ":")),
                                       encoding="utf-8")
    print(f"synonyms.json: {len(SYNONYMS)} ключей")

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.get("count") == len(chunks), \
        f"manifest.count={manifest.get('count')} != чанков {len(chunks)} — полная пересборка, не хирургическая!"
    manifest["builtAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest["values"] = {"version": 1, "count": len(values), "file": "values.json"}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
    print(f"manifest.json: builtAt={manifest['builtAt']}")


if __name__ == "__main__":
    main()

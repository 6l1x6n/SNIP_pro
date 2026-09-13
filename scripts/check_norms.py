"""Проверка соответствия docs.json и PDF-пакета (защита от Invalid PDF structure).

Для каждой записи frontend/public/index/docs.json проверяет:
  1. файл существует в frontend/public/norms/
  2. расширение .pdf и магические байты %PDF (иначе pdf.js кинет InvalidPDFException)

Запуск: python3 scripts/check_norms.py  (exit 1 при расхождениях)
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "frontend" / "public" / "index" / "docs.json"
NORMS = ROOT / "frontend" / "public" / "norms"


def main() -> int:
    docs = json.loads(DOCS.read_text(encoding="utf-8"))
    errors: list[str] = []
    for d in docs:
        f = d.get("file", "")
        if not f:
            print(f"  id={d.get('id')} {d.get('number')}: без файла (только текст в поиске)")
            continue
        p = NORMS / f
        if not p.exists():
            errors.append(f"id={d.get('id')} {d.get('number')}: нет файла {f}")
            continue
        if p.suffix.lower() != ".pdf":
            errors.append(f"id={d.get('id')} {d.get('number')}: не PDF ({f})")
            continue
        if not p.open("rb").read(4).startswith(b"%PDF"):
            errors.append(f"id={d.get('id')} {d.get('number')}: битый PDF ({f})")
    if errors:
        print("ОШИБКИ:")
        for e in errors:
            print("  " + e)
        return 1
    print(f"OK: {len(docs)} документов, все PDF на месте")
    return 0


if __name__ == "__main__":
    sys.exit(main())

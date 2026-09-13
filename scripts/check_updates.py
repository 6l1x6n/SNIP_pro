"""
check_updates.py — dry-run сверка adilet.zan.kz с локальной базой норм.

Что нового/изменилось на официальном источнике vs norms/meta.json + docs.json.
Сетевой dry-run: ничего не скачивает и не меняет, только печатает отчёт.

Запуск:  python3 scripts/check_updates.py [--report PATH]
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.collector.sources.adilet import AdiletFetcher  # noqa: E402


def local_numbers() -> set[str]:
    known: set[str] = set()

    def norm(s: str) -> str:
        return " ".join((s or "").lower().replace("ё", "е").split())

    meta_file = ROOT / "norms" / "meta.json"
    if meta_file.exists():
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        for k, v in meta.items():
            if isinstance(v, dict) and v.get("skip"):
                continue
            num = v.get("number") if isinstance(v, dict) else None
            known.add(norm(num or k))
    docs_file = ROOT / "frontend" / "public" / "index" / "docs.json"
    if docs_file.exists():
        for d in json.loads(docs_file.read_text(encoding="utf-8")):
            if d.get("number"):
                known.add(norm(d["number"]))
    return {k for k in known if k}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default="")
    args = ap.parse_args()

    known = local_numbers()
    print(f"локально известно номеров: {len(known)}")

    fetcher = AdiletFetcher()
    try:
        diff = await fetcher.check_updates(sorted(known))
    finally:
        try:
            await fetcher.client.aclose()
        except Exception:
            pass

    new_docs = diff.get("new", []) if isinstance(diff, dict) else []
    lines = [
        f"Найдено на adilet: {diff.get('total_remote', '?') if isinstance(diff, dict) else '?'}",
        f"Новых документов: {len(new_docs)}",
        *[f"  NEW: {d.get('number') or d.get('title')} — {d.get('url', '')}" for d in new_docs],
        "Изменённые редакции collector не детектирует — статусы проверяй вручную",
        "(открой страницу документа на adilet.zan.kz: «утратил силу» / «заменён»)",
    ]
    print("\n".join(lines))
    if args.report:
        Path(args.report).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"отчёт: {args.report}")


if __name__ == "__main__":
    asyncio.run(main())

"""
verify_values.py — отчёт о качестве извлечения числовых требований.

Читает собранный индекс (frontend/public/index/chunks_*.json + docs.json),
прогоняет values_extract и печатает:
  - покрытие (чанки/факты, топ-ключи с примерами),
  - гистограммы операторов и единиц,
  - подозрительные факты (неправдоподобные величины),
  - случайную выборку для глазной проверки.

Запуск:  python3 scripts/verify_values.py [--index DIR] [--samples N] [--seed N]
"""
import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from values_extract import extract_values  # noqa: E402

# Подозрительные диапазоны: (единица, min, max)
SANITY = {
    "м": (0.0001, 10000),
    "мм": (0.01, 50000),
    "см": (0.01, 100000),
    "км": (0.001, 1000),
    "м²": (0.001, 10_000_000),
    "м³": (0.001, 10_000_000),
    "%": (0, 100),
    "°C": (-100, 1000),
    "дБ": (0, 200),
    "лк": (0, 100000),
    "ч": (0, 100000),
    "мин": (0, 100000),
    "сек": (0, 100000),
    "сут": (0, 36500),
    "лет": (0, 500),
    "эт": (0, 200),
    "чел": (0, 1000000),
    "шт": (0, 100000),
    "кг": (0, 10_000_000),
    "т": (0, 1_000_000),
    "кН": (0, 10_000_000),
    "МПа": (0, 100000),
    "Вт": (0, 100_000_000),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=str(ROOT / "frontend" / "public" / "index"))
    ap.add_argument("--samples", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    idx = Path(args.index)
    docs = {d["id"]: d for d in json.loads((idx / "docs.json").read_text(encoding="utf-8"))}
    chunks: list[dict] = []
    for part in sorted(idx.glob("chunks_*.json")) or [idx / "chunks.json"]:
        if part.exists():
            chunks.extend(json.loads(part.read_text(encoding="utf-8")))
    print(f"чанков: {len(chunks)}, документов: {len(docs)}")

    facts = extract_values(chunks)
    print(f"фактов извлечено: {len(facts)}")

    with_vals = len({(f["d"], f["p"], f["pg"]) for f in facts})
    print(f"покрытие: фактов на чанк ~ {len(facts) / max(1, len(chunks)):.2f}")

    print("\n== Топ-30 ключей ==")
    by_key = Counter(f["k"] for f in facts)
    first_seen: dict[str, dict] = {}
    for f in facts:
        first_seen.setdefault(f["k"], f)
    for k, n in by_key.most_common(30):
        f = first_seen[k]
        doc = docs.get(str(f["d"]), {}).get("number", "?")
        print(f"  {n:5d}  {k}  |  напр: {f['op']}{f['v']} {f['u']} ({doc} п.{f['p']})")

    print("\n== Операторы ==")
    for op, n in Counter(f["op"] for f in facts).most_common():
        print(f"  {op:6s} {n}")

    print("\n== Единицы ==")
    for u, n in Counter(f["u"] for f in facts).most_common():
        print(f"  {u:5s} {n}")

    print("\n== Без объекта (только параметр) ==")
    nosubj = Counter(f["k"] for f in facts if ":" not in f["k"])
    print(f"  фактов: {sum(nosubj.values())} ({100 * sum(nosubj.values()) / max(1, len(facts)):.1f}%)")
    for k, n in nosubj.most_common(10):
        print(f"    {n:5d}  {k}")

    print("\n== Подозрительные величины ==")
    bad = 0
    for f in facts:
        if f["v"] is None:
            continue
        lo, hi = SANITY.get(f["u"], (None, None))
        vals = [f["v"]] + ([f["hi"]] if "hi" in f else [])
        if lo is not None and any(not (lo <= v <= hi) for v in vals):
            if bad < 25:
                doc = docs.get(str(f["d"]), {}).get("number", "?")
                print(f"  {f['k']} {f['op']}{f['v']} {f['u']} | {doc} п.{f['p']} | {f['s'][:110]}")
            bad += 1
    print(f"  всего подозрительных: {bad} ({100 * bad / max(1, len(facts)):.1f}%)")

    print(f"\n== Случайная выборка ({args.samples}) ==")
    rnd = random.Random(args.seed)
    for f in rnd.sample(facts, min(args.samples, len(facts))):
        doc = docs.get(str(f["d"]), {}).get("number", "?")
        hi = f"–{f['hi']}" if "hi" in f else ""
        print(f"  [{f['k']}] {f['op']}{f['v']}{hi} {f['u']} | {doc} п.{f['p']} стр.{f['pg']}")
        print(f"    «{f['s'][:160]}»")

    # компактный JSON для values.json — заодно проверяем сериализуемость
    blob = json.dumps({"version": 1, "count": len(facts), "facts": facts}, ensure_ascii=False)
    print(f"\nvalues.json оценка: {len(blob) / 1024:.0f} КБ")


if __name__ == "__main__":
    main()

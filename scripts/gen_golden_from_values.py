"""
gen_golden_from_values.py — расширяет scripts/eval/golden.jsonl кейсами из values.json.

Подход: вопрос строится ИЗ предложения факта (s), а не из леммы k — иначе
получаем грамматику вида «ширина коридор». Берём только факты, где s начинается
с именительного падежа размерной головы («Ширина коридора должна быть не менее…»)
и содержит триггер «не менее/не более» + число. Тогда вопрос «какая {prefix}?»
звучит естественно. Кейсы помечены tag="values", чтобы отличать от ручных.

Фильтры: юнит из белого списка, предложение без формул/латиницы, чанк ещё не
покрыт golden, q уникально, разброс по документам и головам. Детерминировано
(seed), идемпотентно: повторный запуск не дублирует.

Запуск: python3 scripts/gen_golden_from_values.py [--max-new 60]
"""
import argparse
import json
import random
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "scripts" / "eval" / "golden.jsonl"
VALUES = ROOT / "frontend" / "public" / "index" / "values.json"
DOCS = ROOT / "frontend" / "public" / "index" / "docs.json"

HEADS = {
    "ширина", "высота", "длина", "толщина", "глубина", "площадь",
    "расстояние", "диаметр", "уклон", "количество", "этажность",
}
UNITS = {"м", "мм", "см", "м2", "м3", "эт", "шт", "чел", "%", "мин", "ч"}
OPS = {">=": "минимальная", "<=": "максимальная"}
NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")
OP_WORDS = ("не менее", "не больше", "не более", "не меньше", "не выше", "не ниже", "минимум", "максимум")
LATIN = re.compile(r"[a-zA-Z]")
CYR = re.compile(r"[а-яё]")
MAX_PREFIX = 130


def clean_prefix(prefix: str) -> str | None:
    prefix = prefix.strip().rstrip(",;:—-–").strip()
    low = prefix.lower()
    for w in OP_WORDS:  # хвостовые «не менее» убираем — вопрос про величину, не про оператор
        if low.endswith(w):
            prefix = prefix[: -len(w)].rstrip().rstrip(",;:—-–")
            low = prefix.lower()
            break
    parts = low.split()
    if not parts:
        return None
    first = parts[0]
    if first not in HEADS:
        return None  # не именительный падеж размерной головы — вопрос будет кривым
    if len(prefix) < 15 or len(prefix) > MAX_PREFIX:
        return None
    return prefix


def question_for(prefix: str, h: int) -> str:
    low = prefix.lower()
    for tail in ("должна быть", "должно быть", "должны быть"):
        if low.endswith(tail):
            stem = lc_first(prefix[: -len(tail)].rstrip().rstrip(","))
            return f"какой должна быть {stem}?"
    return f"какая {lc_first(prefix)}?" if h % 2 == 0 else f"{prefix} — какая величина?"


def lc_first(s: str) -> str:
    return s[:1].lower() + s[1:] if s else s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-new", type=int, default=60)
    args = ap.parse_args()

    golden = [json.loads(l) for l in GOLDEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    covered_chunks = {c.get("chunk") for c in golden if "chunk" in c}
    seen_q = {c["q"].lower() for c in golden}
    facts = json.loads(VALUES.read_text(encoding="utf-8"))["facts"]
    docs_list = json.loads(DOCS.read_text(encoding="utf-8"))
    docs = {i: d.get("number", "?") for i, d in enumerate(docs_list)}  # d — индекс в docs.json

    # кандидаты группируем по (голова, документ) — качаем равномерно
    buckets: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for f in facts:
        if f.get("op") not in OPS or f.get("v") is None or f.get("u") not in UNITS:
            continue
        if f["i"] in covered_chunks:
            continue
        s = (f.get("s") or "").strip()
        if not s or "=" in s or "Σ" in s:
            continue
        if CYR.search(s) is None:
            continue
        # кириллицы должно быть большинство (отсекаем формулы и латиницу)
        if len(CYR.findall(s)) < 0.5 * len(s):
            continue
        m = NUM_RE.search(s)
        if not m or m.start() > MAX_PREFIX:
            continue
        prefix = clean_prefix(s[: m.start()])
        if not prefix:
            continue
        head = prefix.lower().split()[0]
        buckets[(head, f["d"])].append((f, prefix))

    rng = random.Random(20260914)
    new: list[dict] = []
    # раунды по бакетам: по одному кейсу из бакета за раунд — разброс по головам/докам
    keys = sorted(buckets)
    round_robin = {k: 0 for k in keys}
    while len(new) < args.max_new and any(round_robin[k] < len(buckets[k]) for k in keys):
        rng.shuffle(keys)
        for k in keys:
            if len(new) >= args.max_new or round_robin[k] >= len(buckets[k]):
                continue
            f, prefix = buckets[k][round_robin[k]]
            round_robin[k] += 1
            q = question_for(prefix, len(new))
            if q.lower() in seen_q:
                continue
            seen_q.add(q.lower())
            covered_chunks.add(f["i"])
            new.append({
                "q": q,
                "chunk": f["i"],
                "tag": "values",
                "note": f"{docs.get(f['d'], '?')} п.{f.get('p')} {f['op']}{f['v']}{f['u']} | {f.get('k')}",
            })

    out = golden + new
    GOLDEN.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in out), encoding="utf-8")
    print(f"✅ golden: {len(golden)} → {len(out)} (+{len(new)}, tag=values)")


if __name__ == "__main__":
    main()

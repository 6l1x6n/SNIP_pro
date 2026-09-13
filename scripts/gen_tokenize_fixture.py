"""
gen_tokenize_fixture.py — генерирует фикстуру паритет-теста токенизатора.

Источник эталона — настоящий tokenize() из build_index.py. Тексты: случайные
чанки реального корпуса + ручные краевые случаи (числа, числительные словами,
ё, стоп-слова, латиница). Фикстуру коммитим: фронтовый vitest сверяет
frontend/src/utils/stem.ts с ней без Python-рантайма.

Запуск:  python3 scripts/gen_tokenize_fixture.py
Выход:   frontend/src/utils/__fixtures__/tokenize_fixture.json
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_index import tokenize  # noqa: E402

N_CHUNKS = 40
SEED = 20260914

EDGE_CASES = [
    "Ширина коридора должна быть не менее 1,4 м",
    "не выше пятого этажа",
    "ЁЖИК, ёлка, подъезд — трёхкомнатная квартира",
    "СН РК 3.02-43-2011, пункт 5.8 (таблица 7.2)",
    "on the 3rd floor of the building",
    "ЭВАКУАЦИОННЫЕ ВЫХОДЫ ИЗ ПОМЕЩЕНИЙ",
    "не менее 0,9 м, но не более 2,5 метров",
    "пятнадцать минут, двадцать этажей, одиннадцать окон",
    "в 2 рядах по 3 штуки — итого 6",
    "высота ограждения лестниц перила 0.9м",
    "а, и, в, на, не, что",
    "ТРЕБУЕТСЯ уточнение проектной документации",
    "2026 года, 1971-й, 12/25/2020",
    "пожарные краны ПК-50 и гидранты",
    "ширина марша лестничной площадки ≥1,2 м",
]

def main() -> None:
    chunks_path = ROOT / "frontend" / "public" / "index" / "chunks_0.json"
    texts: list[str] = list(EDGE_CASES)
    if chunks_path.exists():
        chunks = json.loads(chunks_path.read_text(encoding="utf-8"))
        rng = random.Random(SEED)
        # разные длины: начало, середина, куски покороче
        for c in rng.sample(chunks, N_CHUNKS):
            t = c.get("t") or ""
            if len(t) > 400:
                off = rng.randrange(0, len(t) - 400)
                t = t[off : off + rng.randrange(200, 400)]
            if t.strip():
                texts.append(t.strip())
    fixture = [[t, tokenize(t)] for t in texts]
    out = ROOT / "frontend" / "src" / "utils" / "__fixtures__" / "tokenize_fixture.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✅ {len(fixture)} кейсов → {out.relative_to(ROOT)}")

if __name__ == "__main__":
    main()

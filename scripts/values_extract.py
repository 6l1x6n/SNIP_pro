"""
values_extract.py — офлайн-извлечение числовых нормативных требований из чанков.

Покрывает типичные формулировки норм:
  «ширина ... не менее 1,4 м», «высотой 10 м и более», «не более 15 м»,
  «размером 1,2 м × 0,9 м», «ширина ... 1,5–1,8 м», «уклон не более 1:1,5»,
  «предусматриваются не менее двух эвакуационных выходов».

Шум отсекается требованием ЕДИНИЦЫ измерения: номера пунктов (п. 5.8),
классы (Ф1.2, REI 45), годы, страницы — единиц не имеют и пропускаются.

Выход extract_values(chunks) -> list[fact], где fact:
  {"k": "ширина:коридор", "op": ">=", "v": 1.4, "u": "м",
   "raw": "1,4 м", "d": 0, "p": "5.8", "pg": 42, "s": "сниппет…"}
op: ">=" | "<=" | ">" | "<" | "=" | "range" (v=lo, hi=hi) | "ratio" (v=None)
"""

import re

# ---------- Нормализация ----------

def norm(s: str) -> str:
    return (s or "").lower().replace("ё", "е").replace("\u00a0", " ").replace("\u2212", "-")


# ---------- Единицы ----------

# (каноническая, словесные формы, символьные формы)
# Словесные формы — со строгими границами слов; символьные — только правая граница
# (чтобы «50%», «200 м2» ловились без пробела).
UNITS = [
    ("мм", ["мм"], []),
    ("см", ["см"], []),
    ("км", ["км"], []),
    ("м²", ["квадратных"], ["м2", "м²", "кв.м", "кв м", "кв. м"]),
    ("м³", ["кубических"], ["м3", "м³", "куб.м", "куб м"]),
    ("м", ["м", "метр", "метра", "метров", "метром", "метре", "пог.м", "пог м"], []),
    ("%", ["процент", "процента", "процентов"], ["%"]),
    ("°C", ["градус", "градуса", "градусов", "градусе", "град"], ["°c", "°с"]),
    ("дБ", ["дб", "дба"], []),
    ("лк", ["лк", "люкс", "люкса"], []),
    ("ч", ["ч", "час", "часа", "часов"], []),
    ("мин", ["мин", "минута", "минуты", "минуту", "минут"], []),
    ("сек", ["сек", "секунда", "секунды", "секунду", "секунд"], []),
    ("сут", ["сут", "сутки", "суток", "суткам"], []),
    ("лет", ["лет", "год", "года", "году", "годов"], []),
    ("эт", ["этаж", "этажа", "этажу", "этажей", "этаже",
            "этажность", "этажности", "этажностью"], []),
    ("чел", ["чел", "человек", "человека", "людей"], []),
    ("кг", ["кг", "килограмм", "килограммов"], []),
    ("т", ["тонн", "тонны", "тонна", "тонной"], []),
    ("кН", ["кн"], []),
    ("МПа", ["мпа", "кпа"], []),
    ("л/с", [], ["л/с", "л/c"]),
    ("м/с", [], ["м/с", "м/c"]),
    ("Вт", ["вт", "квт", "ватт"], []),
]

_WORD_FORMS: list[str] = []
_WORD2UNIT: dict[str, str] = {}
_SYM_FORMS: list[str] = []
_SYM2UNIT: dict[str, str] = {}
for _canon, _words, _syms in UNITS:
    for _f in _words:
        _WORD_FORMS.append(_f)
        _WORD2UNIT[_f] = _canon
    for _f in _syms:
        _SYM_FORMS.append(_f)
        _SYM2UNIT[_f] = _canon
_WORD_FORMS.sort(key=len, reverse=True)
_SYM_FORMS.sort(key=len, reverse=True)

_BND = r"(?<![а-яa-z0-9])"
_BND_R = r"(?![а-яa-z0-9])"
_WORD_ALT = _BND + "(" + "|".join(re.escape(f) for f in _WORD_FORMS) + ")" + _BND_R
# у символьных — левая граница только против букв (чтобы «см2» не дало «м2»),
# цифры слева разрешены («50%», «200 м2» — пробел и так чистится отдельно)
_SYM_ALT = r"(?<![а-яa-z])(" + "|".join(re.escape(f) for f in _SYM_FORMS) + ")" + _BND_R
# Символьные ПЕРВЫЕ: «м/с» должно бить «м», «м2» — «м».
_UNIT_CORE = r"(?:" + _SYM_ALT + r"|" + _WORD_ALT + r")"
UNIT_RE = re.compile(r"\s*" + _UNIT_CORE)          # поиск внутри фрагмента / строго в начале


def _unit_from_match(m: re.Match) -> tuple[str, str, int, int] | None:
    for i, g in enumerate(m.groups(), 1):
        if g is None:
            continue
        raw = g
        key = norm(raw).rstrip(".")
        canon = _SYM2UNIT.get(key) if i == 1 else _WORD2UNIT.get(key)
        if canon:
            return canon, raw, m.start(i), m.end(i)
    return None


def find_unit(text: str) -> tuple[str, str, int, int] | None:
    """Первая единица во фрагменте (canon, raw, start, end)."""
    m = UNIT_RE.search(text)
    return _unit_from_match(m) if m else None


def match_unit_at_start(text: str) -> tuple[str, str, int, int] | None:
    """Единица строго в начале фрагмента (для одиночных чисел)."""
    m = UNIT_RE.match(text)
    return _unit_from_match(m) if m else None


# ---------- Числа ----------

# Без тысячных пробелов: в таблицах пробел разделяет колонки («22 100 %» — не 22100).
NUM = r"[+-]?\d+(?:[.,]\d+)?"
NUM_RE = re.compile(NUM)
DASH = r"[–—-]"
_UNIT_TAIL = r"(?:" + _UNIT_CORE + r")"
RANGE_RE = re.compile(
    rf"(?:от\s+)?({NUM})\s*(?:{DASH}\s*({NUM})|\s+до\s+({NUM}))\s*{_UNIT_TAIL}"
)
DIMS_RE = re.compile(
    rf"({NUM})\s*{_UNIT_TAIL}?\s*[×xхX*]\s*"
    rf"({NUM})\s*{_UNIT_TAIL}?"
)
RATIO_RE = re.compile(rf"({NUM})\s*:\s*({NUM})")
SINGLE_RE = re.compile(rf"({NUM})")


def parse_num(s: str) -> float | None:
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return None


def is_year(v: float, unit: str) -> bool:
    """«с 1950 года» — не требование, а дата."""
    return unit == "лет" and float(v).is_integer() and 1800 <= v <= 2100


def bad_unit_tail(text: str, end: int, unit: str) -> bool:
    """Составная единица («80 м3/ч», «м2·°C») или аббревиатура («М.1», «ч. 2»):
    это не измерение, а расход / ссылка / модель."""
    tail = text[end:]
    if tail[:1] in ("/", "·"):
        return True
    if unit == "°C" and re.match(r"^\s*сут", tail):
        return True
    # «М.1-кестесі», «табл. 2»: точка СРАЗУ за единицей + буква/цифра.
    # Конец предложения («…не менее 2 м.») — пробел после точки, не трогаем.
    if re.match(r"^\.[A-ZА-ЯA-Z0-9]", tail):
        return True
    return False


def range_fragment_before(s: str, start: int) -> bool:
    """Диапазон начинается сразу за цифрой/точкой («4.02-108-2012») —
    это фрагмент номера документа/формулы, а не требование."""
    return re.search(r"[\d.]\s*$", s[:start]) is not None


def model_number_before(s: str, start: int) -> bool:
    """Буква вплотную перед знаком («СВ-300», «м-1»): модель/единица, не значение."""
    return re.search(r"[а-яa-z]$", s[:start]) is not None


# Совместимость единиц и параметров: ближайшее слово-предшественник иногда врёт
# («объем 8 м²» — на деле площадь). Для перечисленных единиц ищем ближайший
# СОВМЕСТИМЫЙ параметр, иначе — дефолт; без него факт отбрасываем.
PARAM_COMPAT: dict[str, set[str] | None] = {
    "м²": {"площадь", "размер"},
    "м³": {"объем", "размер"},
    "%": {"уклон", "влажность", "освещенность", "шум", "количество", "размер"},
    "°C": {"температура", "размер"},
    "дБ": {"шум"},
    "лк": {"освещенность"},
    "ч": {"срок", "размер"},
    "мин": {"срок", "размер"},
    "сек": {"срок", "размер"},
    "сут": {"срок", "размер"},
    "лет": {"срок"},
    "эт": {"количество", "этажность"},
    "чел": {"количество"},
    "шт": {"количество"},
    "кг": {"нагрузка", "размер"},
    "т": {"нагрузка", "размер"},
    "кН": {"нагрузка", "размер"},
    "МПа": {"нагрузка", "размер"},
    "Вт": {"мощность"},
    "л/с": {"скорость", "расход"},
    "м/с": {"скорость", "расход"},
    "м": None, "мм": None, "см": None, "км": None, "": None,
}

DEFAULT_PARAM: dict[str, str] = {
    "м²": "площадь", "м³": "объем", "°C": "температура", "дБ": "шум",
    "лк": "освещенность", "лет": "срок", "эт": "количество", "чел": "количество",
    "шт": "количество", "Вт": "мощность", "л/с": "скорость", "м/с": "скорость",
}

# Нулевые физические величины («толщина 0 мм») — мусор OCR/таблиц.
ZEROABLE_OK = {"", "шт"}


# ---------- Числительные словами (для «…не менее двух выходов») ----------

WORD_NUMS = {
    "один": 1, "одна": 1, "одно": 1, "одного": 1, "одной": 1, "одному": 1, "одним": 1,
    "два": 2, "две": 2, "двух": 2, "двум": 2, "двумя": 2,
    "три": 3, "трех": 3, "трем": 3, "тремя": 3,
    "четыре": 4, "четырех": 4,
    "пять": 5, "пяти": 5, "пятью": 5,
    "шесть": 6, "шести": 6, "шестью": 6,
    "семь": 7, "семи": 7, "семью": 7,
    "восемь": 8, "восьми": 8, "восемью": 8,
    "девять": 9, "девяти": 9, "девятью": 9,
    "десять": 10, "десяти": 10, "десятью": 10,
}
WORD_NUM_RE = re.compile(_BND + "(" + "|".join(sorted(WORD_NUMS, key=len, reverse=True)) + ")" + _BND_R)


# ---------- Операторы и контекстные слова ----------

def detect_op(window: str) -> str:
    """Окно ДО числа. Порядок важен: «не менее» раньше «менее»."""
    w = norm(window)
    if any(k in w for k in ("не менее", "не меньше", "минимум", "минимальн",
                            "как минимум", "и более", "или более", "не ниже")):
        return ">="
    if any(k in w for k in ("не более", "не больше", "максимум", "максимальн",
                            "как максимум", "и менее", "или менее", "не выше",
                            "не превыша")):
        return "<="
    # «не должна превышать» — отрицание с глаголом между: тоже «не более».
    # Формы должны перечисляться явно: «должен» (муж.) — д-о-л-ж-Е-н,
    # шаблон «должн…» его никогда не ловит (ловил только должна/должно/должны).
    if re.search(r"не\s+(?:должен|должна|должно|должны)?\s*превыша", w):
        return "<="
    if any(k in w for k in ("более", "больше", "свыше", "превыша", "выше")):
        return ">"
    if any(k in w for k in ("менее", "меньше", "ниже")):
        return "<"
    if any(k in w for k in ("размером", "равен", "равна", "равны", "равно",
                            "составля", "равняе")):
        return "="
    return ""


# Оператор ПОСЛЕ числа: «высотой 10 м и более», «температура не ниже −5 °C».
POST_OP_RE = re.compile(
    r"^\s*(и\s+более|или\s+более|и\s+выше|минимум)\b|"
    r"^\s*(и\s+менее|или\s+менее|и\s+ниже|максимум)\b"
)

# Барьеры: слова, после которых окно оператора обрезается.
# «до/при/на» прямо перед числом превращают его в условие/квалификатор («=»),
# а не в требование («при длине коридора до 10 м», «на 200 м2 площади»).
def _bw(word: str) -> "re.Pattern[str]":
    # левая граница (начало строки или не-буква): «на » не должно ловиться в «ширина»
    return re.compile(r"(?:^|(?<![а-яa-z0-9]))" + re.escape(word))


BARRIERS: list[tuple[str, "re.Pattern[str]"]] = [
    ("при ", _bw("при ")), ("если ", _bw("если ")), ("когда ", _bw("когда ")),
    ("до ", _bw("до ")), ("на ", _bw("на ")), ("по ", _bw("по ")),
    (";", re.compile(r";")),
    (" в ", _bw("в ")), (" с ", _bw("с ")), (" к ", _bw("к ")),
]
# Барьеры-квалификаторы: число после них — условие («до 10 м», «на 200 м2»), не требование.
QUALIFIERS = ("на ", "до ", "при ", "по ")


def op_window(s: str, start: int, length: int = 70) -> tuple[str, str]:
    """(окно для detect_op — после последнего барьера/числа, барьер-квалификатор)."""
    w0 = max(0, start - length)
    seg = s[w0:start]
    cut, last_q = 0, ""
    for b, rx in BARRIERS:
        for mm in rx.finditer(seg):
            if mm.end() > cut:
                cut = mm.end()
                last_q = b if b in QUALIFIERS else ""
    for m in NUM_RE.finditer(seg):
        if m.end() > cut:
            cut, last_q = m.end(), ""
    # числительные словами тоже режут окно («не менее одного окна на 200…»)
    for m in WORD_NUM_RE.finditer(seg):
        if m.end() > cut:
            cut, last_q = m.end(), ""
    return seg[cut:], last_q


# Явный порог сильнее барьера-квалификатора: «площадью не менее 6 м2» —
# барьеры «на/до/при» не должны прятать «не менее» (иначе сотни фактов
# разъезжаются в «=» по всем параметрам сразу). Проверяется окно после
# последнего ЧИСЛА (защита от чужого порога: «не менее 1 м, высота 2 м»).
_EXPLICIT_GE = ("не менее", "не меньше", "не ниже", "минимум", "как минимум")
_EXPLICIT_LE = ("не более", "не больше", "не выше", "максимум", "как максимум")


def resolve_op(s: str, start: int, end: int) -> str:
    """Оператор для числа [start:end]: постфикс > явный порог > барьеры > окно."""
    post = s[end: end + 16]
    m = POST_OP_RE.match(post)
    if m:
        return ">=" if m.group(1) else "<="
    win, last_q = op_window(s, start)
    if last_q:
        seg = s[max(0, start - 70):start]
        cut = 0
        for mm in NUM_RE.finditer(seg):
            cut = max(cut, mm.end())
        for mm in WORD_NUM_RE.finditer(seg):
            cut = max(cut, mm.end())
        explicit = norm(seg[cut:])
        if any(k in explicit for k in _EXPLICIT_GE):
            return ">="
        if any(k in explicit for k in _EXPLICIT_LE):
            return "<="
        return "="
    return detect_op(win)


REQ_CUES = ("должен", "должна", "должно", "должны", "следует", "необходимо",
            "требуется", "допускается", "запрещ", "разреш", "обязан",
            "принимать", "предусматрива", "имеют", "имеет", "иметь")

# Слова-исключения рядом с числом: это НЕ значение, а ссылка/класс/номер.
# Проверка — regex с границей (начало строки/пробел/скобка), чтобы «сп рк» в
# начале предложения тоже ловилось.
SKIP_BEFORE_RE = re.compile(
    r"(?:^|[\s(«\"])(п\.|пункт|раздел|глава|табл|рис\.|стр|rei|класс|гост|снип|сн рк|сп рк|ст рк|№)\s*$"
)


# ---------- Параметры и объекты ----------

PARAMS: dict[str, list[str]] = {
    "ширина": ["ширина", "ширины", "ширину", "шириной", "ширине"],
    "высота": ["высота", "высоты", "высоту", "высотой", "высоте", "высотах"],
    "длина": ["длина", "длины", "длину", "длиной", "длине"],
    "глубина": ["глубина", "глубины", "глубину", "глубиной", "глубине"],
    "толщина": ["толщина", "толщины", "толщину", "толщиной", "толщине"],
    "площадь": ["площадь", "площади", "площадью", "площадей"],
    "объем": ["объем", "объема", "объему", "объемом", "объеме"],
    "диаметр": ["диаметр", "диаметра", "диаметру", "диаметром", "диаметре"],
    "расстояние": ["расстояние", "расстояния", "расстоянию", "расстоянием",
                   "расстоянии", "расстояниях", "дистанция", "дистанции",
                   "дистанцию", "разрыв", "разрыва", "разрывом"],
    "уклон": ["уклон", "уклона", "уклону", "уклоном", "уклоне", "уклоны", "уклонов"],
    "размер": ["размер", "размера", "размеру", "размером", "размере",
               "размеры", "размеров", "габарит", "габарита", "габариты", "габаритов"],
    "температура": ["температура", "температуры", "температуру", "температурой", "температуре"],
    "влажность": ["влажность", "влажности", "влажностью"],
    "освещенность": ["освещенность", "освещенности", "освещенностью"],
    "шум": ["шум", "шума", "шуму", "шумом", "шуме"],
    "давление": ["давление", "давления", "давлением", "давлении"],
    "скорость": ["скорость", "скорости", "скоростью"],
    "количество": ["количество", "количества", "количеством", "численность",
                   "численности", "численностью", "число", "числа", "числу", "числом"],
    "срок": ["срок", "срока", "сроку", "сроком", "сроке"],
    "этажность": ["этажность", "этажности", "этажностью"],
    "мощность": ["мощность", "мощности", "мощностью"],
    "расход": ["расход", "расхода", "расходом"],
    "нагрузка": ["нагрузка", "нагрузки", "нагрузку", "нагрузкой", "нагрузке", "нагрузок"],
    "прогиб": ["прогиб", "прогиба", "прогибом"],
    "осадка": ["осадка", "осадки", "осадку", "осадкой"],
}

SUBJECTS: dict[str, list[str]] = {
    "коридор": ["коридор", "коридора", "коридору", "коридором", "коридоре",
                "коридоры", "коридоров", "коридорам", "коридорах"],
    "проход": ["проход", "прохода", "проходу", "проходом", "проходе", "проходы", "проходов"],
    "холл": ["холл", "холла", "холлом", "холле", "холлы", "холлов"],
    "вестибюль": ["вестибюль", "вестибюля", "вестибюлю", "вестибюлем", "вестибюле"],
    "лестница": ["лестница", "лестницы", "лестницу", "лестницей", "лестнице",
                 "лестниц", "лестницам", "лестницах", "лестничная", "лестничного",
                 "лестничной", "лестничном", "лестничные"],
    "лестничный марш": ["марш", "марша", "маршу", "маршем", "марше", "марши", "маршей"],
    "лестничная клетка": ["клетка", "клетки", "клетку", "клеткой", "клетке", "клеток"],
    "лестничная площадка": ["площадка", "площадки", "площадку", "площадкой", "площадке", "площадок"],
    "дверной проем": ["дверь", "двери", "дверью", "дверях", "дверей",
                      "проем", "проема", "проему", "проемом", "проеме", "проемы", "проемов"],
    "окно": ["окно", "окна", "окну", "окном", "окне", "окон", "окнам", "окнах"],
    "подоконник": ["подоконник", "подоконника", "подоконником"],
    "помещение": ["помещение", "помещения", "помещению", "помещением", "помещении",
                  "помещений", "помещениям", "помещениях"],
    "комната": ["комната", "комнаты", "комнату", "комнатой", "комнате", "комнат"],
    "зал": ["зал", "зала", "залом", "зале", "залы", "залов"],
    "палата": ["палата", "палаты", "палату", "палатой", "палате", "палат"],
    "класс": ["класс", "класса", "классом", "классе", "классы", "классов"],
    "кабинет": ["кабинет", "кабинета", "кабинетом", "кабинете", "кабинеты", "кабинетов"],
    "цех": ["цех", "цеха", "цехом", "цехе", "цехи", "цехов"],
    "санузел": ["санузел", "санузла", "санузлом", "санузле", "санузлы"],
    "кухня": ["кухня", "кухни", "кухню", "кухней"],
    "квартира": ["квартира", "квартиры", "квартиру", "квартирой"],
    "здание": ["здание", "здания", "зданию", "зданием", "здании",
               "зданий", "зданиям", "зданиях", "дом", "дома", "дому",
               "домом", "доме", "домов"],
    "сооружение": ["сооружение", "сооружения", "сооружению", "сооружением",
                   "сооружении", "сооружений"],
    "этаж": ["этаж", "этажа", "этажу", "этажом", "этаже", "этажи", "этажей"],
    "крыша": ["крыша", "крыши", "крышу", "крышей", "крыше", "крыш",
              "кровля", "кровли", "кровлю", "кровлей", "кровле"],
    "стена": ["стена", "стены", "стену", "стеной", "стене", "стен", "стенам", "стенах"],
    "перекрытие": ["перекрытие", "перекрытия", "перекрытию", "перекрытием",
                   "перекрытии", "перекрытий"],
    "пол": ["пол", "пола", "полу", "полом", "поле", "полы", "полов"],
    "потолок": ["потолок", "потолка", "потолку", "потолком", "потолке", "потолков"],
    "фундамент": ["фундамент", "фундамента", "фундаментом", "фундаменте",
                  "фундаменты", "фундаментов"],
    "перегородка": ["перегородка", "перегородки", "перегородку",
                    "перегородкой", "перегородке", "перегородок"],
    "пандус": ["пандус", "пандуса", "пандусом", "пандусе", "пандусы", "пандусов"],
    "лифт": ["лифт", "лифта", "лифтом", "лифте", "лифты", "лифтов"],
    "тамбур": ["тамбур", "тамбура", "тамбуром", "тамбуре"],
    "балкон": ["балкон", "балкона", "балконом", "балконе", "балконы", "балконов",
               "лоджия", "лоджии", "лоджию", "лоджией"],
    "ограждение": ["ограждение", "ограждения", "ограждению", "ограждением",
                   "ограждении", "ограждений", "перила", "перил", "перилами",
                   "поручень", "поручни", "поручня", "поручнем"],
    "выход": ["выход", "выхода", "выходу", "выходом", "выходе", "выходы", "выходов"],
    "сторона": ["сторона", "стороны", "сторону", "стороной", "стороне", "сторон", "сторонам"],
    "подвал": ["подвал", "подвала", "подвалом", "подвале", "подвалы", "подвалов"],
    "чердак": ["чердак", "чердака", "чердаком", "чердаке"],
    "парковка": ["стоянка", "стоянки", "стоянку", "стоянкой", "стоянке", "стоянок",
                 "парковка", "парковки", "парковку", "парковок",
                 "автостоянка", "автостоянки"],
    "дорога": ["дорога", "дороги", "дорогу", "дорогой", "дороге", "дорог",
               "проезд", "проезда", "проезду", "проездом", "проезде",
               "проезды", "проездов", "тротуар", "тротуара", "тротуаром"],
    "территория": ["территория", "территории", "территорию", "территорией",
                   "двор", "двора", "двором", "дворе",
                   "участок", "участка", "участком", "участке"],
    "зона": ["зона", "зоны", "зону", "зоной", "зоне", "зон"],
    "фасад": ["фасад", "фасада", "фасадом", "фасаде", "фасады", "фасадов"],
    "цоколь": ["цоколь", "цоколя", "цоколем"],
    "бассейн": ["бассейн", "бассейна", "бассейном", "бассейне"],
    "люди": ["человек", "человека", "человеку", "человеком", "люди", "людей", "людям", "людьми"],
}

# Префиксные стемы (прилагательные/аббревиатуры без полных форм)
SUBJECT_STEMS: dict[str, str] = {
    "маломобильн": "МГН",
    "инвалид": "МГН",
    "коляс": "МГН",
    "мгн": "МГН",
    "эвакуацион": "эвакуация",
}

PHRASE_SUBJECTS: dict[str, str] = {
    "пути эвакуации": "путь эвакуации",
    "путей эвакуации": "путь эвакуации",
    "путь эвакуации": "путь эвакуации",
    "путях эвакуации": "путь эвакуации",
    "путям эвакуации": "путь эвакуации",
    "путем эвакуации": "путь эвакуации",
}


def _compile_forms(forms: list[str]) -> re.Pattern:
    return re.compile(_BND + "(?:" + "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True)) + ")" + _BND_R)


_PARAM_RE: dict[str, re.Pattern] = {k: _compile_forms(v) for k, v in PARAMS.items()}
_SUBJ_RE: dict[str, re.Pattern] = {k: _compile_forms(v) for k, v in SUBJECTS.items()}
_STEM_RE: dict[str, re.Pattern] = {
    k: re.compile(_BND + re.escape(k) + r"[а-я]*" + _BND_R) for k in SUBJECT_STEMS
}
_PHRASE_RE: list[tuple[re.Pattern, str]] = [
    (re.compile(re.escape(p)), canon) for p, canon in PHRASE_SUBJECTS.items()
]

MAX_FACTS_PER_CHUNK = 12
CLAUSE_PREFIX_RE = re.compile(r"^\d[\d.\s]*\*?\s+")


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.;:!?…])\s+|\n+|(?:^|\s)[;•]\s*", text)
    return [p.strip(" \t") for p in parts if p and len(p.strip()) > 3]


def nearest_key(sent: str, pos: int, patterns: dict[str, re.Pattern]) -> tuple[str, int]:
    """Ближайший к позиции ключ словаря (расстояние в символах; при ничьей — длиннее)."""
    best, best_d, best_l = "", 10 ** 9, 0
    for key, rx in patterns.items():
        for m in rx.finditer(sent):
            mid = (m.start() + m.end()) // 2
            d = abs(mid - pos)
            if d < best_d or (d == best_d and (m.end() - m.start()) > best_l):
                best, best_d, best_l = key, d, m.end() - m.start()
    return best, best_d


def detect_subject(sent: str, pos: int) -> str:
    subj, d = nearest_key(sent, pos, _SUBJ_RE)
    # фразы («пути эвакуации») точнее одиночных слов
    for rx, canon in _PHRASE_RE:
        for m in rx.finditer(sent):
            mid = (m.start() + m.end()) // 2
            if abs(mid - pos) < d:
                subj, d = canon, abs(mid - pos)
    for stem, canon in SUBJECT_STEMS.items():
        for m in _STEM_RE[stem].finditer(sent):
            mid = (m.start() + m.end()) // 2
            if abs(mid - pos) < d:
                subj, d = canon, abs(mid - pos)
    if subj == "выход" and "эвакуацион" in sent:
        subj = "эвакуационный выход"
    if subj == "лестница" and any(w in sent for w in ("клетка", "клетки", "клетку", "клеток")):
        subj = "лестничная клетка"
    return subj


def snippet_for(sent: str, start: int, end: int, width: int = 150) -> str:
    s = CLAUSE_PREFIX_RE.sub("", sent).strip()
    if len(s) <= width + 20:
        return s
    # окно вокруг числа
    lo = max(0, start - 60)
    hi = min(len(s), end + 90)
    out = s[lo:hi].strip()
    if lo > 0:
        out = "…" + out
    if hi < len(s):
        out = out + "…"
    return out


# Таблицы «значения-до-фразы»: сериализация даёт «3 м и более 3,0 м 2,7 1) м …
# Высота жилых помещений от пола до низа потолков» — числа ДО фразы, обычный
# choose_param слева их не связывает и норма теряется. Паттерны — ДАННЫЕ
# (якорные фразы + plausibility-диапазон), механика ниже — одна на все таблицы:
# числа в порядке текста + заголовки колонок в порядке текста → cls позиционно,
# минимум → ">=", остальные → "=". Никаких литералов цифр/классов/документов в коде.
TABLE_VALUE_PATTERNS: list[dict] = [
    {"need": ["высота", "потол", "от пола до"],
     "want_any": ["жил", "квартир", "социальн"],
     "anchor": "высота",
     "param": "высота", "subjects": ["помещение", "потолок"],
     "unit": "м", "lo": 2.0, "hi": 4.5, "p_fallback": "Таблица 1"},
]

# Заголовки колонок классификации (текст уже в нижнем регистре: i класс …).
TABLE_HEADER_RE = re.compile(
    r"\b[ivx]{1,4}\s+класс\w*|малогабаритн\w*(?:\s+жил\w*)?")
TABLE_TITLE_RE = re.compile(r"Таблица\s+[А-ЯA-Zа-яa-z]?\s*\.?\s*\d+(\.\d+)*")


def extract_table_ceiling_facts(text: str, raw_text: str, c: dict) -> list[dict]:
    """См. TABLE_VALUE_PATTERNS: generic-извлечение «значения-до-фразы»."""
    s = norm(text)
    out: list[dict] = []
    for pat in TABLE_VALUE_PATTERNS:
        if any(k not in s for k in pat["need"]):
            continue
        if not any(k in s for k in pat["want_any"]):
            continue
        # числа с единицей в чанке (сноски вида «2,7 1) м») — в ПОРЯДКЕ текста
        unit_re = re.compile(
            r"(\d+(?:[.,]\d+)?)\s*(?:\d+\)\s*)?" + re.escape(pat["unit"]) + r"(?![а-яa-z0-9])")
        nums: list[tuple[float, str]] = []
        for m in unit_re.finditer(s):
            v = parse_num(m.group(1))
            if v is None or not (pat["lo"] <= v <= pat["hi"]):
                continue
            nums.append((v, f"{m.group(1)} {pat['unit']}".strip()))
        if not nums:
            continue
        # заголовки колонок в порядке текста → cls позиционно
        headers = [m.group(0).strip() for m in TABLE_HEADER_RE.finditer(s)]
        if len(headers) != len(nums):
            headers = []
        # субъекты, упомянутые во фразе («помещений» и «потолков» → оба)
        subj_hits = [su for su in pat["subjects"] if su[:5] in s] or pat["subjects"][:1]
        p = c.get("p") or ""
        if not p:
            mt = TABLE_TITLE_RE.search(raw_text or "")
            p = mt.group(0).replace("  ", " ") if mt else pat.get("p_fallback", "")
        idx = s.find(pat["anchor"])
        snippet = snippet_for(raw_text, max(0, idx - 100), min(len(raw_text or ""), idx + 60))
        if pat["need"][1] not in norm(snippet):
            snippet = (raw_text[:150] + "…") if raw_text and len(raw_text) > 150 else (raw_text or "")
        minv = min(v for v, _ in nums)
        for pos_n, (v, draw) in enumerate(nums):
            raw_cls = headers[pos_n] if headers else ""
            # заголовки из нормализованного текста — в нижнем регистре:
            # римские номера обратно в верхние («ii класс» → «II класс»)
            cls = re.sub(r"^[ivx]+", lambda mm: mm.group(0).upper(), raw_cls)
            cls = cls[0].upper() + cls[1:] if cls else cls
            op = ">=" if abs(v - minv) < 1e-9 else "="
            subjs = subj_hits if op == ">=" else subj_hits[:1]
            for su in subjs:
                f: dict = {"k": f"{pat['param']}:{su}", "op": op, "v": v,
                           "u": pat["unit"], "raw": draw,
                           "i": c.get("i"), "d": c.get("d"), "p": p, "pg": c.get("pg"),
                           "s": snippet}
                if cls:
                    f["cls"] = cls
                out.append(f)
    return out


# Порядковые числительные этажей: «не выше пятого этажа» → этажность <=5.
# Кардинальные WORD_NUMS (пять) здесь не ловят, нужны ординальные формы.
ORDINAL_FLOOR: dict[str, int] = {
    "перв": 1, "втор": 2, "трет": 3, "четверт": 4, "пят": 5,
    "шест": 6, "седьм": 7, "восьм": 8, "девят": 9, "десят": 10,
    "одиннадцат": 11, "двенадцат": 12,
}
ORDINAL_FLOOR_RE = re.compile(
    r"(не выше|не более|до|выше|более|свыше|ниже|менее)\s+"
    r"(перв\w*|втор\w*|трет\w*|четверт\w*|пят\w*|шест\w*|седьм\w*|восьм\w*|девят\w*|десят\w*|одиннадцат\w*|двенадцат\w*)\s+"
    r"этаж\w*"
)


def extract_ordinal_floor_facts(text: str, raw_text: str, c: dict) -> list[dict]:
    """«расположенной не выше пятого этажа» (СП 110 п.4.4.1.37) → этажность:этаж <=5 эт.

    Общее правило, не хардкод пункта: ограничитель + порядковое + «этаж».
    Сниппет — окно вокруг совпадения, чтобы заземление и ранкинг сошлись
    (содержит и «пятого», и «этажа», и «не выше»).
    """
    s = norm(text)
    if "этаж" not in s:
        return []
    out: list[dict] = []
    seen_n: set[tuple] = set()
    for m in ORDINAL_FLOOR_RE.finditer(s):
        limiter, ordinal = m.group(1), m.group(2)
        n = None
        for stem, val in ORDINAL_FLOOR.items():
            if ordinal.startswith(stem):
                n = val
                break
        if n is None:
            continue
        if limiter in ("не выше", "не более", "до", "ниже", "менее"):
            op = "<="
        else:
            op = ">"
        key = (op, n)
        if key in seen_n:
            continue
        seen_n.add(key)
        snippet = snippet_for(raw_text, m.start(), m.end(), width=150)
        out.append({"k": "этажность:этаж", "op": op, "v": float(n), "u": "эт",
                    "raw": f"{ordinal} этаж", "i": c.get("i"), "d": c.get("d"),
                    "p": c.get("p") or "", "pg": c.get("pg"),
                    "s": snippet})
    return out


def skipped_context(before: str) -> bool:
    return SKIP_BEFORE_RE.search(norm(before[-16:])) is not None


def extract_values(chunks: list[dict]) -> list[dict]:
    """chunks: [{i,d,p,pg,t,ty}] -> facts (см. docstring модуля)."""
    facts: list[dict] = []
    seen: set[tuple] = set()
    for ci, c in enumerate(chunks):
        # позиция чанка в полном списке = индекс вектора/чанка в индексе;
        # шарды грузятся по порядку, поэтому enumerate совпадает с полем "i".
        c["i"] = ci
        text = c.get("t") or ""
        if not text:
            continue
        # табличные «значения-до-фразы» + порядковые этажи — приоритетно,
        # вне лимита чанка (иначе 12 фактов про площади съедают лимит
        # и главная норма теряется); дедуп — с учётом cls/scope/nolimit,
        # иначе строки одной таблицы схлопываются друг в друга
        def _table_key(f: dict) -> tuple:
            return (f["i"], f["k"], f["op"], f["v"], f["u"],
                    f.get("cls", ""), f.get("scope", ""))

        for _fn in (extract_table_ceiling_facts, extract_ordinal_floor_facts):
            try:
                for f in _fn(text, text, c):
                    key = _table_key(f)
                    if key in seen:
                        continue
                    seen.add(key)
                    facts.append(f)
            except Exception:
                pass
        # Приоритетные факты — ВНЕ лимита чанка (свой маленький кап): иначе
        # 7 строк таблицы съедают бюджет обычных предложений (кухни терялись).
        # Обычные факты — свой счётчик, как раньше (до 12 на чанк).
        n_chunk = 0
        for sent in split_sentences(text):
            if n_chunk >= MAX_FACTS_PER_CHUNK:
                break
            s = norm(sent)
            # быстрые ворота: есть ли вообще число
            if not NUM_RE.search(s):
                continue
            chunk_facts = extract_from_sentence(s, sent, c)
            for f in chunk_facts:
                key = (f["i"], f["k"], f["op"], f["v"], f["u"])
                if key in seen:
                    continue
                seen.add(key)
                facts.append(f)
                n_chunk += 1
                if n_chunk >= MAX_FACTS_PER_CHUNK:
                    break
    return facts


OPWORD_RE = re.compile(
    r"(не менее|не меньше|не более|не больше|минимум|максимум|размером|"
    r"равен|равна|равны|равно|составляет|составляют)\s*$")


def choose_param(sent: str, pos: int, unit: str, state: dict, start: int | None = None) -> str:
    """Параметр числа: эллипсис («не менее X … и не менее Y» → тот же параметр),
    иначе ближайший СЛЕВА (до 120 символов), сначала несъеденный;
    фолбэк — ближайший вообще / дефолт по единице."""
    compat = PARAM_COMPAT.get(unit)
    pool = _PARAM_RE if compat is None else {k: rx for k, rx in _PARAM_RE.items() if k in compat}
    # окно оператора — от НАЧАЛА числа (pos — середина, для многозначных режет цифру)
    anchor = start if start is not None else pos
    m = OPWORD_RE.search(sent[max(0, anchor - 25):anchor])
    opw = m.group(1) if m else ""
    if opw and opw in state["opword"]:
        # эллипсис — но проверяем, что между прошлым и этим числом нет
        # свободного параметра (иначе «ширина А не менее 1,2, высота Б не менее 2,0»
        # неверно склеилось бы в ширину)
        lo, hi = state["last_pos"], pos
        free_between = False
        if lo >= 0:
            for key, rx in pool.items():
                if key in state["consumed"]:
                    continue
                for mm in rx.finditer(sent):
                    mid = (mm.start() + mm.end()) // 2
                    if lo < mid < hi:
                        free_between = True
                        break
                if free_between:
                    break
        if not free_between:
            return state["opword"][opw]
    left: list[tuple[int, str]] = []
    for key, rx in pool.items():
        for mm in rx.finditer(sent):
            mid = (mm.start() + mm.end()) // 2
            if mid <= pos and pos - mid <= 120:
                left.append((pos - mid, key))
    param = ""
    if left:
        left.sort()
        for _, key in left:
            if key not in state["consumed"]:
                param = key
                break
        else:
            param = left[0][1]
    else:
        param, pd = nearest_key(sent, pos, pool)
        if (not param or pd > 150) and unit in DEFAULT_PARAM:
            param = DEFAULT_PARAM[unit]
    if param:
        state["consumed"].append(param)
        if opw:
            state["opword"][opw] = param
    return param


# Область применения числа: ближайшее «для|при + NP» слева («для входа в ложи»,
# «для артистического плавания»). Общее правило для всех параметров: пули и
# квалификатор hero показывают, к какому случаю относится значение.
SCOPE_HEAD_RE = re.compile(r"\b(?:для|при)\b")
SCOPE_SKIP_FIRST = {"этом", "таком", "условии", "наличии", "отсутствии",
                    "соблюдении", "выполнении", "настоящем"}
SCOPE_TAIL_DROP = {"допускается", "допускают", "допускаться", "следует",
                   "необходимо", "требуется", "требуются", "должна", "должно",
                   "должны", "должен", "может", "могут", "разрешается",
                   "запрещается", "принимается", "принимать", "рекомендуется",
                   "рекомендуют", "устраивать", "устраивают", "устраивается",
                   "более", "менее", "свыше", "выше", "ниже", "не"}


def detect_scope(sent: str, pos: int) -> str:
    """Область применения («для входа в ложи») или ''."""
    window = sent[max(0, pos - 110):pos]
    for m in reversed(list(SCOPE_HEAD_RE.finditer(window))):
        tail = window[m.end():].strip()
        words = tail.split()
        if not words or words[0].strip(" ,;:.—-") in SCOPE_SKIP_FIRST:
            continue
        # режем по первому глаголу-требованию внутри («для отдыха рекомендуется
        # устраивать» → «для отдыха»), хвост чистим так же
        cut = next((k for k, w in enumerate(words) if w in SCOPE_TAIL_DROP), len(words))
        words = words[:cut]
        while words and words[-1] in SCOPE_TAIL_DROP:
            words.pop()
        scope = " ".join([m.group(0)] + words[:4]).strip(" ,;:.—-")
        if 6 <= len(scope) <= 60:
            return scope
        # else try earlier match
    return ""


# Процедура замера, а не требование («глубина измеряется на расстоянии 1 м»):
# факт остаётся для поиска, но из hero-кандидатов исключается (флаг nolimit).
MEASURE_RE = re.compile(
    r"измеряется|замеряется|производят замер|измерени[яе]\s+(?:провод|выполн|осуществл)")


def _build_fact(sent: str, raw_sent: str, param: str, subj: str, pos: int, op: str,
                unit: str, v, raw: str, c: dict, start: int, end: int, hi=None) -> dict | None:
    if not param:
        return None
    if v == 0 and unit not in ZEROABLE_OK:
        return None
    if is_year(v, unit) or (hi is not None and is_year(hi, unit)):
        return None
    # «60 градусов» угла наклона — не температура: без слова «температур»
    # рядом с угол/наклон/уклон/откос градусы считаем углом, факт не извлекаем.
    if unit == "°C" and "температур" not in sent and any(
            k in sent for k in ("угол", "наклон", "уклон", "откос")):
        return None
    if not param:
        return None
    if v == 0 and unit not in ZEROABLE_OK:
        return None
    if is_year(v, unit) or (hi is not None and is_year(hi, unit)):
        return None
    if not op:
        # голое «=» — только при явном требовании в предложении
        if not any(k in sent for k in REQ_CUES):
            return None
        op = "="
    elif op in (">=", "<=", ">", "<", "=", "range"):
        pass
    else:
        return None
    if not subj and op == "=" and not any(k in sent for k in REQ_CUES):
        return None
    k = f"{param}:{subj}" if subj else param
    fact = {"k": k, "op": op, "v": v, "u": unit, "raw": raw,
            "i": c.get("i"), "d": c.get("d"), "p": c.get("p") or "", "pg": c.get("pg"),
            "s": snippet_for(raw_sent, start, end)}
    if hi is not None:
        fact["hi"] = hi
    sc = detect_scope(sent, pos)
    if sc:
        fact["scope"] = sc
    if MEASURE_RE.search(sent):
        fact["nolimit"] = True
    return fact


def extract_from_sentence(s: str, raw_sent: str, c: dict) -> list[dict]:
    out: list[dict] = []
    used: list[tuple[int, int]] = []
    # Кандидаты без привязки параметра; привязка — позже, строго по позиции.
    cands: list[dict] = []

    def overlaps(a: int, b: int) -> bool:
        return any(a < e and b > st for st, e in used)

    # 1. Диапазоны «1,5–1,8 м» / «от 6 до 8 м»
    for m in RANGE_RE.finditer(s):
        if range_fragment_before(s, m.start()):
            continue
        lo = parse_num(m.group(1))
        hi = parse_num(m.group(2) or m.group(3) or "")
        u = find_unit(m.group(0))
        if lo is None or hi is None or not u:
            continue
        unit, uraw, _us, ue = u
        if bad_unit_tail(s, m.start() + ue, unit):
            continue
        if skipped_context(s[: m.start()]):
            continue
        pos = (m.start() + m.end()) // 2
        op = resolve_op(s, m.start(), m.end())
        if op not in (">=", "<=", ">", "<"):
            op = "range"
        cands.append({"t": "n", "pos": pos, "op": op, "unit": unit, "v": lo, "hi": hi,
                      "raw": f"{m.group(1)}–{m.group(3) or m.group(2)} {uraw}".strip(),
                      "start": m.start(), "end": m.end()})
        used.append((m.start(), m.end()))

    # 2. Габариты «1,2 м × 0,9 м» / «1,8×1,8 м»
    for m in DIMS_RE.finditer(s):
        if overlaps(m.start(), m.end()):
            continue
        a = parse_num(m.group(1))
        u = find_unit(m.group(0))
        if a is None or not u:
            continue
        unit, _, _us, ue = u
        if bad_unit_tail(s, m.start() + ue, unit):
            continue
        b = parse_num(m.group(4))
        if b is None:
            continue
        if skipped_context(s[: m.start()]):
            continue
        pos = (m.start() + m.end()) // 2
        op = resolve_op(s, m.start(), m.end())
        if not op:
            op = "="
        cands.append({"t": "dims", "pos": pos, "op": op, "unit": unit,
                      "pairs": [(a, m.group(1)), (b, m.group(4))],
                      "start": m.start(), "end": m.end()})
        used.append((m.start(), m.end()))

    # 3. Пропорции «уклон 1:1,5»
    for m in RATIO_RE.finditer(s):
        if overlaps(m.start(), m.end()):
            continue
        if not any(k in s for k in ("уклон", "пандус", "марш", "скат")):
            continue
        if skipped_context(s[: m.start()]):
            continue
        a, b = parse_num(m.group(1)), parse_num(m.group(2))
        if a is None or b is None:
            continue
        pos = (m.start() + m.end()) // 2
        op = resolve_op(s, m.start(), m.end()) or "="
        cands.append({"t": "ratio", "pos": pos, "op": op,
                      "raw": f"{m.group(1)}:{m.group(2)}",
                      "start": m.start(), "end": m.end()})
        used.append((m.start(), m.end()))

    # 4. Одиночные «не менее 1,4 м»
    for m in SINGLE_RE.finditer(s):
        if overlaps(m.start(), m.end()):
            continue
        num_s = m.group(1)
        # остаток диапазона («1,2-2,4» при несработавшем RANGE): знак после цифры — пропуск
        if num_s[0] in "+-" and re.search(r"\d\s*[–—-]\s*$", s[: m.start()]):
            used.append((m.start(), m.end()))
            continue
        # модель оборудования («СВ-300»): буква вплотную перед знаком
        if num_s[0] in "+-" and model_number_before(s, m.start()):
            used.append((m.start(), m.end()))
            continue
        rest = s[m.end():]
        u = match_unit_at_start(rest)
        if not u:
            continue
        unit, uraw, _us, ue = u
        if bad_unit_tail(rest, ue, unit):
            continue
        v = parse_num(num_s)
        if v is None:
            continue
        if skipped_context(s[: m.start()]):
            continue
        op = resolve_op(s, m.start(), m.end())
        # число со знаком — только с явным оператором («не ниже −5 °C»).
        # Голое «= −10 м» — разделитель списка/модель, а не требование.
        if num_s[0] in "+-" and op not in (">=", "<=", ">", "<"):
            used.append((m.start(), m.end()))
            continue
        cands.append({"t": "n", "pos": (m.start() + m.end()) // 2, "op": op,
                      "unit": unit, "v": v, "hi": None,
                      "raw": f"{num_s} {uraw}".strip(),
                      "start": m.start(), "end": m.end()})
        used.append((m.start(), m.end()))

    # 5. Числительные словами «не менее двух выходов»
    for m in WORD_NUM_RE.finditer(s):
        if overlaps(m.start(), m.end()):
            continue
        seg, _q = op_window(s, m.start(), 80)
        op = detect_op(seg)
        if not op and not any(k in seg for k in REQ_CUES):
            continue
        subj = detect_subject(s, m.start())
        if not subj:
            continue
        cands.append({"t": "word", "pos": m.start(), "op": op or "=",
                      "subj": subj, "v": WORD_NUMS[m.group(1)], "raw": m.group(1),
                      "start": m.start(), "end": m.end()})
        used.append((m.start(), m.end()))

    # ---- Привязка параметров строго по позиции (слева направо) ----
    cands.sort(key=lambda cd: cd["start"])
    state: dict = {"consumed": [], "opword": {}, "last_pos": -1}
    for cd in cands:
        pos = cd["pos"]
        subj = cd.get("subj") or detect_subject(s, pos)
        if cd["t"] == "n":
            param = choose_param(s, pos, cd["unit"], state, cd["start"])
            f = _build_fact(s, raw_sent, param, subj, pos, cd["op"], cd["unit"],
                            cd["v"], cd["raw"], c, cd["start"], cd["end"], hi=cd.get("hi"))
            if f:
                out.append(f)
        elif cd["t"] == "dims":
            param = choose_param(s, pos, cd["unit"], state, cd["start"]) or DEFAULT_PARAM.get(cd["unit"], "размер")
            op = cd["op"]
            if op == "=" and not any(k in s for k in REQ_CUES):
                # «размером» считается требованием само по себе
                if "размер" not in s:
                    state["last_pos"] = pos
                    continue
            kk = f"{param}:{subj}" if subj else param
            sc = detect_scope(s, pos)
            nlm = bool(MEASURE_RE.search(s))
            for val, raw_n in cd["pairs"]:
                if val == 0 and cd["unit"] not in ZEROABLE_OK:
                    continue
                f = {"k": kk, "op": "=" if op == "=" else op, "v": val, "u": cd["unit"],
                     "raw": f"{raw_n} {cd['unit']}".strip(), "i": c.get("i"), "d": c.get("d"),
                     "p": c.get("p") or "", "pg": c.get("pg"),
                     "s": snippet_for(raw_sent, cd["start"], cd["end"])}
                if sc:
                    f["scope"] = sc
                if nlm:
                    f["nolimit"] = True
                out.append(f)
        elif cd["t"] == "ratio":
            rsubj = subj if subj and subj != "уклон" else ""
            out.append({"k": f"уклон:{rsubj}" if rsubj else "уклон", "op": cd["op"], "v": None, "u": "",
                        "raw": cd["raw"],
                        "i": c.get("i"), "d": c.get("d"), "p": c.get("p") or "", "pg": c.get("pg"),
                        "s": snippet_for(raw_sent, cd["start"], cd["end"])})
        elif cd["t"] == "word":
            wf = {"k": f"количество:{subj}", "op": cd["op"], "v": cd["v"], "u": "шт",
                  "raw": cd["raw"], "i": c.get("i"), "d": c.get("d"), "p": c.get("p") or "",
                  "pg": c.get("pg"), "s": snippet_for(raw_sent, cd["start"], cd["end"])}
            sc = detect_scope(s, pos)
            if sc:
                wf["scope"] = sc
            if MEASURE_RE.search(s):
                wf["nolimit"] = True
            out.append(wf)
        state["last_pos"] = pos

    return out

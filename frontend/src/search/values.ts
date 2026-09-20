/**
 * values.ts — карточки числовых нормативных требований.
 *
 * values.json собирается офлайн (scripts/values_extract.py): факты вида
 * {k:"ширина:коридор", op:">=", v:1.4, u:"м", d,p,pg, s:snippet}.
 * Здесь: ленивая загрузка + сопоставление фактоид-запросов («какая минимальная
 * ширина коридора», «ширина коридора») с фактами. Всё локально: 0 кредитов, 0 LLM.
 */
import { tokenize, loadIndex, type IndexBundle, type DocInfo } from "./engine";

export interface ValueFact {
  i: number;
  d: number;
  p: string;
  pg: number | null;
  k: string;
  op: ">=" | "<=" | ">" | "<" | "=" | "range";
  v: number | null;
  hi?: number;
  u: string;
  raw: string;
  s: string;
  /** Подпись класса/случая табличного значения («III класс») — из values_extract. */
  cls?: string;
  /** Область применения («для входа в ложи») — generic detect_scope. */
  scope?: string;
  /** Процедура замера, не требование — исключается из hero-вердиктов. */
  nolimit?: boolean;
}

export interface ValueCard {
  fact: ValueFact;
  docNumber: string;
  docTitle: string;
  docStatus: string;
}

/** Субкарточка ответа: один источник (документ + пункт + страница) с набором значений. */
export interface ValueGroup {
  docNumber: string;
  docTitle: string;
  docStatus: string;
  p: string;
  pg: number | null;
  docId: number;
  cards: ValueCard[];
}

/** Группировка карточек значений по источнику — ключ как в воркере (docNumber|p|pg). */
export function groupValueCards(cards: ValueCard[]): ValueGroup[] {
  const groups = new Map<string, ValueGroup>();
  for (const c of cards) {
    const key = `${c.docNumber}|${c.fact.p}|${c.fact.pg}`;
    const g = groups.get(key);
    if (g) g.cards.push(c);
    else
      groups.set(key, {
        docNumber: c.docNumber,
        docTitle: c.docTitle,
        docStatus: c.docStatus,
        p: c.fact.p,
        pg: c.fact.pg,
        docId: c.fact.d,
        cards: [c],
      });
  }
  return [...groups.values()];
}

/** Слова-триггеры фактоид-вопроса (полные формы, до стемминга). */
const INTERROGATIVE = new Set(
  "какая какой какое какие каков какова каково каковы какому какую каких сколько " +
  "минимальная минимальный минимальное минимальных минимально минимум " +
  "максимальная максимальный максимальное максимальных максимально максимум " +
  "наименьшая наименьший наименьшее наибольшая наибольший наибольшее " +
  "допустимая допустимый допустимое допустимо допускается " +
  "норма нормы норматив требования требование должен должна должно должны положено " +
  "равен равна равно".split(" ")
);

/** Алиасы объектов, которые стеммер не свяжет (аббревиатуры, склонения, синонимы). */
const SUBJECT_ALIASES: Record<string, string[]> = {
  "мгн": ["маломобильн", "инвалид", "коляс", "кресл"],
  "путь эвакуации": ["эвакуацион"],
  "эвакуационный выход": ["эвакуацион"],
  "потолок": ["потолк", "потолоч", "перекрыт"],
  "квартира": ["квартир", "внутриквартирн"],
  "помещение": ["помещен", "комнат", "квартир"],
  "этаж": ["этаж", "этажн"],
  "коридор": ["коридор", "холл"],
};

function normalizeWords(q: string): string[] {
  return q.toLowerCase().replace(/ё/g, "е").replace(/[^а-яёәғқңөұүһі0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

let valuesPromise: Promise<ValueFact[] | null> | null = null;

/** Ленивая загрузка values.json (2–3 МБ). null — индекса без карточек (manifest v1). */
export function loadValues(base = "/index"): Promise<ValueFact[] | null> {
  if (!valuesPromise) {
    valuesPromise = (async () => {
      try {
        const r = await fetch(`${base}/values.json`);
        if (!r.ok) return null;
        const j = await r.json();
        return Array.isArray(j?.facts) ? (j.facts as ValueFact[]) : null;
      } catch {
        return null;
      }
    })();
  }
  return valuesPromise;
}

interface FactEntry {
  fact: ValueFact;
  paramToks: Set<string>;
  subjToks: Set<string>;
}

let entryCache: FactEntry[] | null = null;
let entryCacheFor: ValueFact[] | null = null;

function entries(facts: ValueFact[]): FactEntry[] {
  if (!entryCache || entryCacheFor !== facts) {
    entryCacheFor = facts;
    entryCache = facts.map((fact) => {
      const [param = "", subj = ""] = fact.k.split(":");
      return { fact, paramToks: new Set(tokenize(param)), subjToks: new Set(tokenize(subj)) };
    });
  }
  return entryCache;
}

/** Расширение токенов запроса синонимами (зеркало expandVariants из engine.ts).
 * Возвращает и исходные, и расширенные токены: совпадение по исходному слову
 * весит больше, чем по синониму (иначе «высота» тянет «этаж» вместо «потолок»). */
export function expandTokens(words: string[], synonyms: Record<string, string[]>): Set<string> {
  return expandTokensSplit(words, synonyms).all;
}

function expandTokensSplit(words: string[], synonyms: Record<string, string[]>): { orig: Set<string>; all: Set<string> } {
  const orig = new Set<string>();
  for (const w of words) for (const t of tokenize(w)) orig.add(t);
  const all = new Set<string>(orig);
  for (const [rawKey, syns] of Object.entries(synonyms)) {
    const key = rawKey.toLowerCase().replace(/ё/g, "е");
    if (!words.some((w) => w.includes(key))) continue;
    for (const s of syns.slice(0, 2)) for (const t of tokenize(s)) all.add(t);
  }
  return { orig, all };
}

const OP_ORDER: Record<string, number> = { ">=": 0, "<=": 1, range: 2, ">": 3, "<": 4, "=": 5 };

/** Алиасы типов зданий: стем слова вопроса → стемы в названиях документов (зеркало воркера). */
const DOCTYPE_ALIASES: Record<string, string[]> = {
  жил: ["жил", "многоквартирн", "социальн"],
  квартир: ["квартир", "жил", "многоквартирн"],
  многоквартирн: ["многоквартирн", "жил"],
  социальн: ["социальн", "жил"],
  школ: ["общеобразовательн", "школьн"],
  больниц: ["лечебн", "медицинск", "больничн", "поликлиник", "стационар"],
  детск: ["дошкольн"],
  дошкольн: ["дошкольн"],
  сад: ["дошкольн", "детск"],
  детсад: ["дошкольн"],
  ясли: ["дошкольн"],
  дошкольных: ["дошкольн"],
  детских: ["дошкольн", "детск"],
  торгов: ["торгов", "розничн", "магазин"],
  магазин: ["торгов", "розничн"],
  офис: ["административн", "офис"],
  гостиниц: ["гостиниц"],
  бан: ["банн"],
  бассейн: ["бассейн", "плавательн"],
  спортивн: ["спортивн", "физкультурн"],
  театр: ["зрелищн", "культурн"],
  кино: ["зрелищн", "культурн"],
  кафе: ["питан", "обществен"],
  ресторан: ["питан"],
  стоян: ["стоян", "парков"],
  паркин: ["стоян", "парков"],
};

/** Числа запроса отдельным regex: tokenize() режет len<2, а «на 6 этаже» без 6 — слепой.
 * Плюс числительные словами («на седьмом этаже» → 7). Зеркало воркера. */
const QUERY_CARDINAL: Record<string, number> = {
  "один": 1, "одна": 1, "одно": 1, "два": 2, "две": 2, "двух": 2,
  "три": 3, "трех": 3, "четыре": 4, "четырех": 4, "пять": 5, "пяти": 5,
  "шесть": 6, "шести": 6, "семь": 7, "семи": 7, "восемь": 8, "восьми": 8,
  "девять": 9, "девяти": 9, "десять": 10, "десяти": 10,
  "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
  "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18,
  "девятнадцать": 19, "двадцать": 20,
};

const QUERY_ORDINAL: Record<string, number> = {
  "перв": 1, "втор": 2, "трет": 3, "четверт": 4, "пят": 5,
  "шест": 6, "седьм": 7, "восьм": 8, "девят": 9, "десят": 10,
  "одиннадцат": 11, "двенадцат": 12, "тринадцат": 13,
  "четырнадцат": 14, "пятнадцат": 15, "шестнадцат": 16,
  "семнадцат": 17, "восемнадцат": 18, "девятнадцат": 19,
  "двадцат": 20,
};

function stemSimple(w: string): string {
  // лёгкий стем specifically для ординалов (полный tokenize здесь ни к чему)
  const suf = ["ого", "его", "ому", "ему", "ыми", "ими", "ых", "их", "ая", "ое", "ые",
    "ий", "ый", "ой", "ей", "ом", "ем", "ах", "ях", "ую", "юю",
    "ее", "ии", "ия", "ие", "ов", "ев", "ь", "а", "я", "о", "е", "у", "ю", "ы", "и", "й"];
  for (const s of suf) {
    if (w.endsWith(s) && w.length - s.length >= 3) return w.slice(0, -s.length);
  }
  return w;
}

function extractQueryNums(query: string): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  const push = (v: number) => {
    const k = `n${v}`;
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  };
  const s = query.toLowerCase().replace(/ё/g, "е");
  const re = /[+-]?\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const v = Number(m[0].replace(",", "."));
    if (Number.isFinite(v)) push(v);
  }
  for (const w of s.match(/[а-яa-z0-9]+/g) ?? []) {
    const c = QUERY_CARDINAL[w];
    if (c !== undefined) { push(c); continue; }
    const o = QUERY_ORDINAL[stemSimple(w)];
    if (o !== undefined) push(o);
  }
  return out;
}

/** Единицы, о которых спрашивает запрос: «этаж» → эт, «площадь» → м² и т.д. */
function inferQueryUnits(qNorm: string): Set<string> {
  const u = new Set<string>();
  if (/(этаж|этажност)/.test(qNorm)) u.add("эт");
  if (/(площад|м2|м²|кв\.?\s*м)/.test(qNorm)) u.add("м²");
  if (/(высот|ширин|длин|глубин|толщин|расстоян|высот)/.test(qNorm)) u.add("м");
  if (/(детей|дети|человек|людей|чел)/.test(qNorm)) u.add("чел");
  if (/(мм)/.test(qNorm)) u.add("мм");
  return u;
}

/** Числовой скоринг факта против чисел запроса (общий, не хардкод 6/9).
 * range 6-12 для q=6: +4 + теснота; <=9 для q=6: +2; 1-2 для q=6: -2. */
function numScore(f: ValueFact, qNums: number[], qUnits: Set<string>): number {
  if (!qNums.length || f.v === null || f.v === undefined) return 0;
  if (qUnits.size > 0 && !qUnits.has(f.u)) return 0;
  const q = qNums[0];
  const v = f.v;
  const hi = f.hi ?? v;
  switch (f.op) {
    case "range": {
      if (q >= v && q <= hi) return 4 + 2 / (1 + (hi - v));
      const d = Math.min(Math.abs(q - v), Math.abs(q - hi));
      return Math.max(-3, -d / 2);
    }
    case "<=": {
      if (q <= v) return 2 + 1 / (1 + (v - q));
      return -2;
    }
    case ">=": {
      if (q >= v) return 2 + 1 / (1 + (q - v));
      return -2;
    }
    case "=": {
      if (Math.abs(q - v) < 1e-9) return 4;
      return Math.max(-3, -Math.abs(q - v) / 2);
    }
    case ">": {
      if (q > v) return 2 + 1 / (1 + (q - v));
      return -2;
    }
    case "<": {
      if (q < v) return 2 + 1 / (1 + (v - q));
      return -2;
    }
    default:
      return 0;
  }
}

/** Нечеткое равенство стемов: точное, префиксное в обе стороны или общий корень ≥5.
 * Чинит «потолка→потолк vs потолок→потолок» (общий «потол»), «зданиями→здани
 * vs здание→здан» и т.п. без привязки к конкретному слову — умнее в целом. */
function stemsFuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) return true;
  return false;
}

function toksFuzzyHit(queryToks: Set<string>, factToks: Set<string>): boolean {
  if (!factToks.size || !queryToks.size) return false;
  for (const ft of factToks) {
    for (const qt of queryToks) {
      if (stemsFuzzyEqual(qt, ft)) return true;
    }
  }
  return false;
}

/** Слова-маркеры чужого контекста: если их нет в запросе, а сниппет/док про них —
 * штрафуем. Добыто из titles docs.json: архивы/гостиницы/кухни не должны бить сад. */
const IRRELEVANT_STEMS = [
  "лифт", "подъем", "подьем", "проезд", "арк", "эвакуац",
  "огражд", "лестнич", "марш", "клетк", "балкон", "лоджи",
  "архив", "гостиниц", "кухн", "сейсм", "торгов", "магазин",
  "школ", "больниц", "спортивн", "бассейн", "театр", "офис",
  "стоян", "парков", "банн", "питан", "ресторан", "кафе",
];

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Стем в тексте по левой границе слова: «школ» ловит «школы», но не «дошкольные»
 * (иначе садовый документ штрафуется за «школ» внутри «дошкольные»). */
function stemInText(st: string, text: string): boolean {
  try {
    return new RegExp(`(^|[^а-яa-z0-9])${escRe(st)}`).test(text);
  } catch {
    return text.includes(st);
  }
}

function irrelevantPenalty(qstr: string, sNorm: string, docText = ""): number {
  let p = 0;
  const hay = `${sNorm} ${docText}`;
  for (const st of IRRELEVANT_STEMS) {
    if (stemInText(st, hay) && !stemInText(st, qstr)) p += 2;
    if (p >= 4) break;
  }
  // Явный тип объекта в запросе (сад/школа/жилое), а док чужой → сильный штраф.
  // Иначе «архивы ≤9» бьёт «сад ≤5» за счёт числа, хотя тип не тот.
  const intent: Array<[string, string[]]> = [];
  for (const [qs, kws] of Object.entries(DOCTYPE_ALIASES)) {
    if (qs.length >= 3 && qstr.includes(qs)) intent.push([qs, kws]);
  }
  if (intent.length > 0) {
    const match = intent.some(([, kws]) => kws.some((kw) => docText.includes(kw)));
    if (!match) p += 3;
  }
  return Math.min(p, 7);
}

/** Буст за точное попадание в суть: «от пола до потолка/низа потолков»,
 * «жилых помещений», «внутриквартирн» — то, что отличает норму потолка
 * от лифта/проезда/лестницы. Плюс садовая тема: детск/сад/дошкольн. */
function contextBoost(qstr: string, sNorm: string): number {
  let b = 0;
  const asksCeiling = qstr.includes("потол") || qstr.includes("высот") || qstr.includes("этаж");
  if (asksCeiling && sNorm.includes("от пола до")) b += 2;
  if (asksCeiling && (sNorm.includes("низа потол") || sNorm.includes("низ потол"))) b += 1;
  if ((qstr.includes("жил") || qstr.includes("квартир")) && (sNorm.includes("жил") || sNorm.includes("квартир") || sNorm.includes("внутриквартирн"))) b += 1;
  const asksKindergarten = qstr.includes("детск") || qstr.includes("сад") || qstr.includes("дошкольн") || qstr.includes("одво") || qstr.includes("ясли");
  if (asksKindergarten && (sNorm.includes("детск") || sNorm.includes("дошкольн") || sNorm.includes("одво") || sNorm.includes("семейн") || sNorm.includes("группов"))) b += 2;
  const asksMgn = qstr.includes("маломобильн") || qstr.includes("мгн") || qstr.includes("инвалид") || qstr.includes("коляс") || qstr.includes("кресл");
  if (asksMgn && (sNorm.includes("маломобильн") || sNorm.includes("кресл") || sNorm.includes("коляс") || sNorm.includes("инвалид"))) b += 4;
  return b;
}

/** Штраф generic-факту, когда вопрос явно про МГН, а сниппет — общий проход без МГН-маркера. */
function mgnPenalty(qstr: string, sNorm: string, factKey: string): number {
  const asksMgn = qstr.includes("маломобильн") || qstr.includes("мгн") || qstr.includes("инвалид") || qstr.includes("коляс") || qstr.includes("кресл");
  if (!asksMgn) return 0;
  const k = String(factKey ?? "").toLowerCase();
  if (k.includes("мгн")) return 0;
  if (sNorm.includes("маломобильн") || sNorm.includes("кресл") || sNorm.includes("коляс") || sNorm.includes("инвалид")) return 0;
  return 3;
}

const DEIXIS_RE = /(перед ними|для них|в них|в этих|в указанных|этих помещен)/;

/**
 * Частный случай (scope/cls) или дейксис в сниппете, не упомянутый в запросе, —
 * мягкий штраф (зеркало воркера): общая норма выше «для семей с инвалидами»,
 * «при освещении…», «коридоров перед ними».
 */
function scopePenalty(qNorm: string, f: ValueFact): number {
  let p = 0;
  const scope = String(f.scope || f.cls || "").toLowerCase().replace(/ё/g, "е").trim();
  if (scope) {
    const key = String(f.k || "").toLowerCase();
    const extra = scope.split(/[^а-яёәғқңөұүһі0-9]+/).filter((w) => w.length >= 4 && !key.includes(w.slice(0, Math.max(4, w.length - 2))));
    if (extra.length && !extra.some((w) => qNorm.includes(w.slice(0, Math.max(4, w.length - 2))))) p += 1;
  }
  const s = String(f.s || "").toLowerCase().replace(/ё/g, "е");
  if (DEIXIS_RE.test(s) && !DEIXIS_RE.test(qNorm)) p += 1;
  return p;
}

/** Док-уровень: садовый запрос + садовый документ → +2 даже если сниппет обрезан
 * («не выше пятого этажа» без слова «детский» в окне 150 символов). */
export function docKindergartenBoost(qstr: string, docText: string): number {
  const asks = qstr.includes("детск") || qstr.includes("сад") || qstr.includes("дошкольн") || qstr.includes("одво") || qstr.includes("ясли");
  if (asks && (docText.includes("дошкольн") || docText.includes("детск") || docText.includes("одво"))) return 2;
  return 0;
}

/**
 * Префиксный фолбэк: односуффиксный стеммер даёт «зданиями»→«здани» против
 * «здание»→«здан», «потолка»→«потолк» против «потолок»→«потолок».
 * Двусторонний + общий корень ≥5 (см. stemsFuzzyEqual).
 */
function prefixHit(words: string[], stems: Set<string>): boolean {
  for (const w of words) {
    if (w.length < 4) continue;
    for (const st of stems) {
      if (st.length >= 3 && stemsFuzzyEqual(w, st)) return true;
      // сырое слово против стема факта: «потолка» vs «потолок»
      if (st.length >= 3 && w.length >= 4) {
        const sw = w.slice(0, Math.min(w.length, 7));
        if (st.startsWith(sw) || sw.startsWith(st)) return true;
      }
    }
  }
  return false;
}

/**
 * Подбор карточек под запрос. Условие показа: параметр найден И
 * (объект найден ИЛИ вопрос фактоидный). Сортировка: точные совпадения
 * параметр+объект (по исходным словам, не синонимам) → тип здания →
 * контекст сниппета → требования-неравенства → остальное.
 * Всё локально, 0⚡.
 */
export async function findValueCards(query: string, limit = 6): Promise<ValueCard[]> {
  const [bundle, facts] = await Promise.all([loadIndex().catch(() => null), loadValues()]);
  if (!bundle || !facts?.length) return [];
  const b = bundle as IndexBundle;
  const words = normalizeWords(query);
  if (!words.length) return [];
  const interrogative = words.some((w) => INTERROGATIVE.has(w));
  const { orig: qOrig, all: qtoks } = expandTokensSplit(words, b.synonyms ?? {});
  const qstr = words.join(" ");
  const qNorm = qstr.toLowerCase().replace(/ё/g, "е");
  // «минимальная» → ищем ≥, «максимальная» → ищем ≤ (иначе лифт «≤3м» бьёт норму «≥2,5м»).
  const minHint = /(миним|наименьш|наименьш|не менее|минимум)/.test(qNorm);
  const maxHint = /(максим|наибольш|наименьш|не более|максимум)/.test(qNorm) && !minHint;
  const ordFor = (op: string): number => {
    if (maxHint) return ({ "<=": 0, ">=": 1, range: 2, "<": 3, ">": 4, "=": 5 } as Record<string, number>)[op] ?? 9;
    return OP_ORDER[op] ?? 9;
  };

  const docsByIdx = new Map<number, DocInfo>();
  (b.docs ?? []).forEach((d, idx) => docsByIdx.set(idx, d));
  // Кэш токенов названий документов для fuzzy-docHit (чинит «дошкольных» vs «дошкольн»).
  const docToksByIdx = new Map<number, Set<string>>();
  const docToks = (idx: number, docText: string): Set<string> => {
    let s = docToksByIdx.get(idx);
    if (!s) {
      s = new Set(tokenize(docText));
      docToksByIdx.set(idx, s);
    }
    return s;
  };

  const scored: Array<{ card: ValueCard; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }> = [];
  const qNums = extractQueryNums(query);
  const qUnits = inferQueryUnits(qNorm);
  for (const e of entries(facts)) {
    let paramHitOrig = false;
    for (const t of e.paramToks) if (qOrig.has(t)) { paramHitOrig = true; break; }
    if (!paramHitOrig && toksFuzzyHit(qOrig, e.paramToks)) paramHitOrig = true;
    if (!paramHitOrig && prefixHit(words, e.paramToks)) paramHitOrig = true;
    let paramHitSyn = false;
    if (!paramHitOrig) {
      for (const t of e.paramToks) if (qtoks.has(t)) { paramHitSyn = true; break; }
    }
    if (!paramHitOrig && !paramHitSyn) continue;
    let subjOrig = false;
    let subjSyn = false;
    if (e.subjToks.size > 0) {
      for (const t of e.subjToks) if (qOrig.has(t)) { subjOrig = true; break; }
      if (!subjOrig && toksFuzzyHit(qOrig, e.subjToks)) subjOrig = true;
      if (!subjOrig && prefixHit(words, e.subjToks)) subjOrig = true;
      if (!subjOrig) {
        // алиасы подстрокой («маломобильных» содержит «маломобильн», «потолка» содержит «потолк»).
        // Ключ case-insensitive: факт «ширина:МГН» vs ключ «мгн».
        const subj = e.fact.k.split(":")[1] ?? "";
        const aliases = SUBJECT_ALIASES[subj.toLowerCase()] ?? SUBJECT_ALIASES[subj] ?? [];
        if (aliases.some((a) => qstr.includes(a))) subjOrig = true;
      }
      // обратное направление: запрос «МГН», а субъект факта — «проход» с МГН-сниппетом
      if (!subjOrig) {
        const asksMgn = qNorm.includes("мгн") || qNorm.includes("маломобильн") || qNorm.includes("инвалид") || qNorm.includes("коляс") || qNorm.includes("кресл");
        if (asksMgn) {
          const sLow = String(e.fact.s || "").toLowerCase();
          if (sLow.includes("маломобильн") || sLow.includes("кресл") || sLow.includes("коляс") || sLow.includes("инвалид")) subjOrig = true;
        }
      }
      if (!subjOrig) {
        for (const t of e.subjToks) if (qtoks.has(t) && !qOrig.has(t)) { subjSyn = true; break; }
      }
    }
    const subjHit = subjOrig || subjSyn;
    if (!subjHit && !interrogative) continue;
    // объект без параметра в запросе не показываем, если факт безадресный
    if (e.subjToks.size === 0 && !interrogative) continue;
    const doc = docsByIdx.get(e.fact.d);
    // Буст по типу здания: стемы слов вопроса в названии документа + алиасы (зеркало воркера).
    // includes + fuzzy: «дошкольных» в запросе должен ловить «дошкольные» в title.
    const docText = `${doc?.number ?? ""} ${doc?.title ?? ""}`.toLowerCase().replace(/ё/g, "е");
    const docT = docToks(e.fact.d, docText);
    let docHit = false;
    for (const st of qtoks) {
      if (st.length < 3) continue;
      if (docText.includes(st)) { docHit = true; break; }
      const al = DOCTYPE_ALIASES[st];
      if (al && al.some((a) => docText.includes(a))) { docHit = true; break; }
      if (toksFuzzyHit(new Set([st]), docT)) { docHit = true; break; }
    }
    // Релевантность «по смыслу»: исходные слова в сниппете важнее синонимов.
    const sNorm = e.fact.s.toLowerCase().replace(/ё/g, "е");
    let overlap = 0;
    for (const t of qOrig) {
      if (t.length >= 3 && sNorm.includes(t)) {
        overlap++;
        if (overlap >= 5) break;
      }
    }
    const boost = contextBoost(qNorm, sNorm) + docKindergartenBoost(qNorm, docText);
    const penalty = irrelevantPenalty(qNorm, sNorm, docText) + mgnPenalty(qNorm, sNorm, e.fact.k) + scopePenalty(qNorm, e.fact);
    const num = numScore(e.fact, qNums, qUnits);
    const subjScore = subjOrig ? 3 : subjSyn ? 1 : 0;
    const paramScore = paramHitOrig ? 1 : 0;
    const rel = subjScore + paramScore + (docHit ? 2 : 0) + overlap + boost + num - penalty;
    scored.push({
      card: {
        fact: e.fact,
        docNumber: doc?.number ?? "",
        docTitle: doc?.title ?? "",
        docStatus: doc?.status ?? "active",
      },
      rel,
      ord: ordFor(e.fact.op),
      docHit,
      paramOrig: paramHitOrig,
      num,
    });
  }
  scored.sort((a, b2) => b2.rel - a.rel || a.ord - b2.ord || a.card.fact.i - b2.card.fact.i);
  // один ключ — одна карточка (лучшая), чтобы не дублировать одно требование
  const seen = new Set<string>();
  const cards: ValueCard[] = [];
  for (const s of scored) {
    const key = `${s.card.fact.k}|${s.card.fact.op}|${s.card.fact.v}|${s.card.fact.u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(s.card);
    if (cards.length >= limit) break;
  }
  return cards;
}

/** «≥ 1,4 м», «1,2–2,4 м», «1:1,5», «= 2 шт». "=" — явно ровно («= 2,7 м» ≠ «≥ 2,5 м»). */
export function formatValue(f: ValueFact): string {
  const num = (v: number | null) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
  const u = f.u === "шт" ? "шт" : f.u;
  if (f.op === "range") return `${num(f.v)}–${num(f.hi ?? null)} ${u}`.trim();
  if (f.v === null) return f.raw; // ratio «1:1,5»
  const sym = f.op === ">=" ? "≥ " : f.op === "<=" ? "≤ " : f.op === ">" ? "> " : f.op === "<" ? "< " : f.op === "=" ? "= " : "";
  return `${sym}${num(f.v)} ${u}`.trim();
}

/** «Ширина · коридор». */
export function formatLabel(k: string): string {
  const [param = "", subj = ""] = k.split(":");
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  return subj ? `${cap(param)} · ${subj}` : cap(param);
}

/** Формат числа по-русски: 1.8 → «1,8», 1.80 → «1,8». */
function fmtNum(x: number): string {
  const s = String(Math.round(x * 1000) / 1000).replace(".", ",");
  return s.includes(",") ? s.replace(/0+$/, "").replace(/,$/, "") : s;
}

const LEN_UNITS = new Set(["мм", "см", "км", "м"]);

/**
 * Краткая суммаризация набора карточек (локально, без LLM):
 * «1–1,8 м • 6 требований из 3 документов • чаще всего ≥1,2 м».
 * null — когда суммировать нечего (0–1 карточка).
 */
export function summarizeCards(cards: ValueCard[]): string | null {
  if (cards.length < 2) return null;
  const docs = new Set(cards.map((c) => c.fact.d)).size;
  const scope = `${cards.length} треб. из ${docs} док.`;
  const ratios = cards.filter((c) => c.fact.v === null || c.fact.v === undefined);
  const nums = cards.filter((c) => typeof c.fact.v === "number");
  if (!nums.length) {
    if (!ratios.length) return scope;
    const raws = [...new Set(ratios.map((c) => c.fact.raw))].slice(0, 4).join(", ");
    return `пропорции ${raws} • ${scope}`;
  }
  // Крупнейшая группа по единице; остальные — «+N др.»
  const byUnit = new Map<string, number[]>();
  for (const c of nums) {
    const b = valueBase(c.fact);
    if (!Number.isFinite(b)) continue;
    const arr = byUnit.get(c.fact.u) ?? [];
    arr.push(b);
    byUnit.set(c.fact.u, arr);
  }
  if (!byUnit.size) return scope;
  const [u0, arr] = [...byUnit.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const others = nums.length - arr.length;
  const dispU = LEN_UNITS.has(u0) ? "м" : u0;
  const lo = Math.min(...arr);
  const hi = Math.max(...arr);
  // Мода (чаще всего) — по округлённым значениям
  const freq = new Map<number, number>();
  for (const b of arr) freq.set(Math.round(b * 1000) / 1000, (freq.get(Math.round(b * 1000) / 1000) ?? 0) + 1);
  const [modal, modalN] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  let head: string;
  if (lo === hi) head = `${fmtNum(lo)} ${dispU}`;
  else head = `${fmtNum(lo)}–${fmtNum(hi)} ${dispU}`;
  let out = `${head} • ${scope}`;
  if (modalN >= 2 && lo !== hi) out += ` • чаще: ${fmtNum(modal)} ${dispU}`;
  if (others > 0) out += ` • +${others} др.`;
  return out;
}

/**
 * Значение в базовых единицах для сортировки (иначе 400 мм > 1,4 м).
 * Длина→м, площадь→м², объём→м³, время→часы, масса→кг, мощность→Вт,
 * counts (шт/чел/эт)→как есть. ratio/null — Infinity (в конец).
 */
export function valueBase(f: ValueFact): number {
  if (f.op === "range") return valueBase({ ...f, op: "=", v: f.v });
  if (f.v === null || f.v === undefined) return Infinity;
  const v = f.v;
  switch (f.u) {
    case "мм": return v * 0.001;
    case "см": return v * 0.01;
    case "км": return v * 1000;
    case "м": return v;
    case "м²": return v;
    case "м³": return v;
    case "°C": case "%": case "дБ": case "лк": return v;
    case "мин": return v / 60;
    case "сек": return v / 3600;
    case "сут": return v * 24;
    case "лет": return v * 8760;
    case "ч": return v;
    case "т": return v * 1000;
    case "кг": case "кН": case "МПа": case "Вт": return v;
    case "шт": case "чел": case "эт": return v;
    case "л/с": case "м/с": return v;
    default: return v;
  }
}

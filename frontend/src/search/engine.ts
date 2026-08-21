/**
 * engine.ts — гибридный поиск целиком в браузере.
 * Порт логики backend/app/search/hybrid.py (RRF k=60, синонимы, relevance_percent)
 * и токенизатора scripts/build_index.py — правила ДОЛЖНЫ совпадать 1:1.
 *
 * Артефакты: /index/{manifest,docs,chunks,bm25,synonyms}.json + /index/vectors.bin
 * Формат vectors.bin: "SNV1" | u32 dim | u32 count | f32[count] scales | i8[count*dim]
 */

export type SearchMode = "fast" | "deep";

export interface ChunkMeta {
  i: number;
  d: number;
  p: string;
  pg: number;
  t: string;
  ty: string;
}

export interface DocInfo {
  id: string;
  number: string;
  title: string;
  status: string;
  pages: number;
  file: string;
}

export interface Hit {
  chunk: ChunkMeta;
  doc: DocInfo | null;
  relevancePercent: number;
  vecScore: number;
  bm25Score: number;
}

export interface SearchResult {
  hits: Hit[];
  tookMs: number;
  weak: boolean;
  variants: string[];
}

interface Manifest {
  version: number;
  builtAt: string;
  dim: number;
  count: number;
  quantization: string;
  model: string;
  rrfK: number;
}

interface Bm25Index {
  k1: number;
  b: number;
  avgdl: number;
  len: number[];
  postings: Record<string, [number, number][]>;
}

interface IndexBundle {
  manifest: Manifest;
  docs: DocInfo[];
  chunks: ChunkMeta[];
  bm25: Bm25Index;
  synonyms: Record<string, string[]>;
  dim: number;
  count: number;
  scales: Float32Array;
  int8: Int8Array;
}

// ---------- Токенизатор (зеркало build_index.py) ----------

const STOPWORDS = new Set(
  `и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по
только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть
был него до вас нибудь опять уж вам сказал ведь там потом себя ничего ей может они тут где есть надо
ней для мы тебя их чем была сам чтоб без будто человек чего раз тоже себе под жизнь будет ж тогда кто
этот говорил того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее кажется сейчас
были куда зачем сказать всех никогда сегодня можно при наконец два об другой хоть после над больше тот
через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше
чуть том нельзя такой им более всегда конечно всю между это который которые которых также очень своих
таких является`
    .split(/\s+/)
    .filter(Boolean)
);

const SUFFIXES = [
  "ования", "ование", "ениями", "ение", "ениям", "ениях", "ироваться",
  "ирован", "ировать", "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими",
  "ая", "ое", "ые", "ий", "ый", "ой", "ей", "ом", "ем", "ах", "ях", "ую", "юю",
  "ее", "ии", "ия", "ие", "ов", "ев", "ь", "а", "я", "о", "е", "у", "ю", "ы",
  "и", "й",
].sort((a, b) => b.length - a.length);

const TOKEN_RE = /[а-яa-z0-9]+/g;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/ё/g, "е").match(TOKEN_RE) ?? []) {
    if (STOPWORDS.has(raw) || raw.length < 2) continue;
    let w = raw;
    if (!/^\d+$/.test(w)) {
      for (const suf of SUFFIXES) {
        if (w.endsWith(suf) && w.length - suf.length >= 3) {
          w = w.slice(0, -suf.length);
          break;
        }
      }
    }
    if (w.length >= 2 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/ё/g, "е")
    // \w в JS не включает кириллицу — перечисляем явно (в Python \w юникодный)
    .replace(/[^a-zа-я0-9_\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandVariants(query: string, synonyms: Record<string, string[]>, maxVariants: number): string[] {
  const nq = normalizeQuery(query);
  const variants = [nq];
  for (const [key, syns] of Object.entries(synonyms)) {
    if (nq.includes(key)) {
      for (const s of syns.slice(0, 2)) {
        const v = nq.replace(key, s);
        if (!variants.includes(v)) variants.push(v);
        if (variants.length >= maxVariants) break;
      }
    }
    if (variants.length >= maxVariants) break;
  }
  return variants;
}

// ---------- Загрузка индекса ----------

let bundlePromise: Promise<IndexBundle> | null = null;

export function loadIndex(base = "/index"): Promise<IndexBundle> {
  if (bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const j = async <T>(p: string): Promise<T> => (await fetch(`${base}/${p}`)).json();
    const [manifest, docs, chunks, bm25, synonyms] = await Promise.all([
      j<Manifest>("manifest.json"),
      j<DocInfo[]>("docs.json"),
      j<ChunkMeta[]>("chunks.json"),
      j<Bm25Index>("bm25.json"),
      j<Record<string, string[]>>("synonyms.json"),
    ]);
    const res = await fetch(`${base}/vectors.bin`);
    const buf = await res.arrayBuffer();
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== "SNV1") throw new Error("vectors.bin: неверный формат");
    const dim = view.getUint32(4, true);
    const count = view.getUint32(8, true);
    const scalesOff = 12;
    const scales = new Float32Array(buf.slice(scalesOff, scalesOff + 4 * count));
    const dataOff = scalesOff + 4 * count;
    const int8 = new Int8Array(buf, dataOff, count * dim);
    if (count !== chunks.length) throw new Error("vectors.bin не совпадает с chunks.json");
    return { manifest, docs, chunks, bm25, synonyms, dim, count, scales, int8 };
  })();
  return bundlePromise;
}

// ---------- Поиск ----------

type EmbedFn = (query: string) => Promise<number[]>;

let embedProvider: EmbedFn | null = null;

/** api.ts вызывает это, чтобы подсунуть /api/embed воркера (+кэш). */
export function setEmbedProvider(fn: EmbedFn): void {
  embedProvider = fn;
}

function dotQueryInt8(q: number[] | Float32Array, b: IndexBundle, vi: number): number {
  // doc-вектор нормирован до квантования → score ≈ cosine(q, doc); scale — скаляр на вектор
  const off = vi * b.dim;
  let acc = 0;
  for (let j = 0; j < b.dim; j++) acc += q[j] * b.int8[off + j];
  return acc * b.scales[vi];
}

function bm25Scores(variantTokens: string[], b: IndexBundle): Map<number, number> {
  const { k1, b: bb, avgdl, len, postings } = b.bm25;
  const N = b.count;
  const scores = new Map<number, number>();
  const seen = new Set<string>();
  for (const term of variantTokens) {
    if (seen.has(term)) continue;
    seen.add(term);
    const plist = postings[term];
    if (!plist) continue;
    const df = plist.length;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    for (const [chunkIdx, tf] of plist) {
      const dl = len[chunkIdx] || avgdl;
      const s = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - bb + (bb * dl) / avgdl)));
      scores.set(chunkIdx, (scores.get(chunkIdx) ?? 0) + s);
    }
  }
  return scores;
}

function ranksFrom(scores: Map<number, number>): Array<[number, number]> {
  return [...scores.entries()].sort((a, c) => c[1] - a[1]);
}

export async function search(query: string, opts?: { mode?: SearchMode; topK?: number; embed?: EmbedFn }): Promise<SearchResult> {
  const t0 = performance.now();
  const mode = opts?.mode ?? "fast";
  const topK = opts?.topK ?? (mode === "deep" ? 20 : 10);
  const embed = opts?.embed ?? embedProvider;
  if (!embed) throw new Error("embed provider не задан: вызови setEmbedProvider() или передай opts.embed");

  const b = await loadIndex();
  if (!query.trim()) return { hits: [], tookMs: 0, weak: true, variants: [] };

  const variants = expandVariants(query, b.synonyms, mode === "deep" ? 3 : 1);
  const qVec = await embed(query);

  const K = b.manifest.rrfK ?? 60;
  const rrf = new Map<number, number>();
  const bestVec = new Map<number, number>();
  const bestBm = new Map<number, number>();

  // vector ranking — один раз: эмбеддинг считается от исходного запроса
  const vecRanked = ranksFrom(
    new Map<number, number>(Array.from({ length: b.count }, (_, i) => [i, dotQueryInt8(qVec, b, i)]))
  );
  vecRanked.forEach(([idx], rank) => {
    rrf.set(idx, (rrf.get(idx) ?? 0) + 1 / (K + rank + 1));
    bestVec.set(idx, Math.max(bestVec.get(idx) ?? -Infinity, vecRanked[rank][1]));
  });

  for (const variant of variants) {
    // bm25 ranking по вариантам запроса
    const bm = bm25Scores(tokenize(variant), b);
    ranksFrom(bm).forEach(([idx], rank) => {
      rrf.set(idx, (rrf.get(idx) ?? 0) + 1 / (K + rank + 1));
    });
    for (const [idx, s] of bm) {
      bestBm.set(idx, Math.max(bestBm.get(idx) ?? -Infinity, s));
    }
  }

  // финальный скор: 0.6*norm_rrf + 0.4*vector_score → percent 10..98 (как в hybrid.py)
  const ranked = ranksFrom(rrf);
  const maxRrf = ranked[0]?.[1] ?? 1;
  const hits: Hit[] = ranked.slice(0, topK).map(([idx, rrfScore]) => {
    const combined = 0.6 * (rrfScore / maxRrf) + 0.4 * (bestVec.get(idx) ?? 0);
    const percent = Math.max(10, Math.min(98, Math.round(10 + 88 * combined)));
    return {
      chunk: b.chunks[idx],
      doc: b.docs[b.chunks[idx].d] ?? null,
      relevancePercent: percent,
      vecScore: bestVec.get(idx) ?? 0,
      bm25Score: bestBm.get(idx) ?? 0,
    };
  });

  // anti-hallucination guard (адаптивный порог из search.py)
  const corpusSmall = b.count < 2000;
  const VEC_MIN = corpusSmall ? 0.25 : 0.32;
  const topVec = Math.max(...hits.map((h) => h.vecScore), 0);
  const topBm = Math.max(...hits.map((h) => h.bm25Score), 0);
  const weak = hits.length === 0 || (topVec < VEC_MIN && topBm < 0.005);

  return { hits, tookMs: Math.round(performance.now() - t0), weak, variants };
}

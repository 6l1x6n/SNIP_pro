/**
 * engine.ts — гибридный поиск целиком в браузере.
 * Порт логики backend/app/search/hybrid.py (RRF k=60, синонимы, relevance_percent)
 * и токенизатора scripts/build_index.py — правила ДОЛЖНЫ совпадать 1:1.
 *
 * Артефакты: /index/{manifest,docs,chunks,bm25,synonyms}.json + /index/vectors.bin
 * Формат vectors.bin: "SNV1" | u32 dim | u32 count | f32[count] scales | i8[count*dim]
 */
import { tokenize } from "../utils/stem";
export { tokenize };
import { SEMANTIC_SYNONYMS } from "../utils/semanticSynonyms";

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
  /** true если вектор недоступен (429/502 провайдера) и поиск шёл только по BM25 */
  degraded?: boolean;
  degradedReason?: string;
}

interface Manifest {
  version: number;
  builtAt: string;
  dim: number;
  count: number;
  quantization: string;
  model: string;
  rrfK: number;
  shards?: { vectors?: number; chunks?: number };
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

// ---------- Токенизатор (зеркало build_index.py; реализация в utils/stem.ts) ----------
// (импорт tokenize — в шапке файла)

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
  // Словами, а не \b-regex: в JS \b не видит границы кириллических слов
  // (\w — только ASCII), поэтому «перилами» через \b не матчилось бы.
  const words = nq.split(" ").filter(Boolean);
  for (const [rawKey, syns] of Object.entries(synonyms)) {
    // Ключи приводим к той же нормализации, что и запрос (lower + ё→е):
    // иначе ключ «проём» никогда не совпадёт с «проем» в запросе.
    const key = rawKey.toLowerCase().replace(/ё/g, "е");
    if (!words.some((w) => w.includes(key))) continue;
    for (const s of syns.slice(0, 2)) {
      // Заменяется ЦЕЛОЕ слово («перилами» → «ограждение»), стемминг — позже в tokenize()
      const v = words.map((w) => (w.includes(key) ? s : w)).join(" ");
      if (!variants.includes(v)) variants.push(v);
      if (variants.length >= maxVariants) break;
    }
    if (variants.length >= maxVariants) break;
  }
  return variants;
}

// ---------- Смысловой режим (тумблер в Настройках; квоты не затрагивает) ----------

const SEMANTIC_KEY = "snip_semantic";

let semanticMode = true;
try {
  // По умолчанию ВКЛ (квоту не затрагивает — чисто клиентское ранжирование);
  // явный "0" в localStorage — выкл (тумблер в Настройках).
  semanticMode = localStorage.getItem(SEMANTIC_KEY) !== "0";
} catch { /* SSR/приватный режим — вкл */ }

/** Вкл/выкл смыслового ранжирования (оверлей синонимов + векторный приоритет). */
export function setSemanticMode(v: boolean): void {
  semanticMode = v;
  try {
    localStorage.setItem(SEMANTIC_KEY, v ? "1" : "0");
  } catch {}
}

export function isSemanticMode(): boolean {
  return semanticMode;
}

// ---------- Загрузка индекса ----------

let bundlePromise: Promise<IndexBundle> | null = null;

export function loadIndex(base = "/index"): Promise<IndexBundle> {
  if (bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const j = async <T>(p: string): Promise<T> => (await fetch(`${base}/${p}`)).json();
    const manifest = await j<Manifest>("manifest.json");
    const [docs, bm25, synonyms] = await Promise.all([
      j<DocInfo[]>("docs.json"),
      j<Bm25Index>("bm25.json"),
      j<Record<string, string[]>>("synonyms.json"),
    ]);
    // Шарды (manifest.shards) или классические одиночные файлы
    const nChunkShards = manifest.shards?.chunks ?? 1;
    const nVecShards = manifest.shards?.vectors ?? 1;
    const chunkParts: Promise<ChunkMeta[]>[] = [];
    for (let k = 0; k < nChunkShards; k++) chunkParts.push(j<ChunkMeta[]>(`chunks_${k}.json`));
    const chunks: ChunkMeta[] = ([] as ChunkMeta[]).concat(...(await Promise.all(chunkParts)));

    // Векторы: читаем все шарды и склеиваем scales + int8 в единые буферы
    const shardBufs = await Promise.all(
      Array.from({ length: nVecShards }, (_, k) =>
        fetch(k === 0 && nVecShards === 1 ? `${base}/vectors.bin` : `${base}/vectors_${k}.bin`).then((r) => r.arrayBuffer())
      )
    );
    let dim = 0;
    let totalCount = 0;
    const slices: Array<{ scales: ArrayBuffer; data: ArrayBuffer }> = [];
    for (const b of shardBufs) {
      const v = new DataView(b);
      const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
      if (magic !== "SNV1") throw new Error("vectors.bin: неверный формат");
      dim = v.getUint32(4, true);
      const n = v.getUint32(8, true);
      totalCount += n;
      slices.push({ scales: b.slice(12, 12 + 4 * n), data: b.slice(12 + 4 * n, 12 + 4 * n + n * dim) });
    }
    const scales = new Float32Array(totalCount);
    const int8 = new Int8Array(totalCount * dim);
    let sOff = 0;
    let dOff = 0;
    for (const s of slices) {
      scales.set(new Float32Array(s.scales), sOff);
      int8.set(new Int8Array(s.data), dOff);
      sOff += s.scales.byteLength / 4;
      dOff += s.data.byteLength;
    }
    if (totalCount !== chunks.length) throw new Error("vectors.bin не совпадает с chunks.json");
    return { manifest, docs, chunks, bm25, synonyms, dim, count: totalCount, scales, int8 };
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

  const sem = semanticMode;
  // Оверлей первым: при исчерпании лимита вариантов приоритет у смысловых синонимов.
  const synonyms = sem ? { ...SEMANTIC_SYNONYMS, ...b.synonyms } : b.synonyms;
  const maxVariants = mode === "deep" ? (sem ? 5 : 3) : sem ? 3 : 1;
  const variants = expandVariants(query, synonyms, maxVariants);
  // Safety: вектор может лечь (Cohere 429 → worker 429 → searchClient ретраи исчерпаны).
  // Вместо жёсткой ошибки деградируем до BM25-only как backend/app/search/hybrid.py (q_emb=None).
  let qVec: number[] | null = null;
  let embedError: any = null;
  try {
    qVec = await embed(query);
  } catch (e: any) {
    embedError = e;
    console.warn("embed недоступен — поиск только по BM25", e?.status ?? "", e?.provider ?? "", e?.message ?? e);
  }

  const K = b.manifest.rrfK ?? 60;
  const rrf = new Map<number, number>();
  const bestVec = new Map<number, number>();
  const bestBm = new Map<number, number>();

  // vector ranking — один раз: эмбеддинг считается от исходного запроса (скип при деградации)
  if (qVec) {
    const vecRanked = ranksFrom(
      new Map<number, number>(Array.from({ length: b.count }, (_, i) => [i, dotQueryInt8(qVec as number[], b, i)]))
    );
    vecRanked.forEach(([idx], rank) => {
      rrf.set(idx, (rrf.get(idx) ?? 0) + 1 / (K + rank + 1));
      bestVec.set(idx, Math.max(bestVec.get(idx) ?? -Infinity, vecRanked[rank][1]));
    });
  }

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

  // финальный скор: обычно 0.6*norm_rrf + 0.4*vector_score (как в hybrid.py);
  // в смысловом режиме векторный приоритет 0.45/0.55 → percent 10..98.
  // При BM25-only деградации (нет qVec) скор = только norm_rrf.
  const ranked = ranksFrom(rrf);
  const maxRrf = ranked[0]?.[1] ?? 1;
  const wRrf = sem ? 0.45 : 0.6;
  const wVec = sem ? 0.55 : 0.4;
  const hits: Hit[] = ranked.slice(0, topK).map(([idx, rrfScore]) => {
    const combined = qVec ? wRrf * (rrfScore / maxRrf) + wVec * (bestVec.get(idx) ?? 0) : rrfScore / maxRrf;
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
  // При деградации векторный порог не применяем — только BM25.
  const weak = qVec
    ? hits.length === 0 || (topVec < VEC_MIN && topBm < 0.005)
    : hits.length === 0 || topBm < 0.005;

  if (!qVec) {
    const reason =
      embedError?.rateLimited || embedError?.status === 429
        ? "Лимит эмбеддингов (429) — показан текстовый поиск без векторного ранжирования"
        : "Векторный поиск временно недоступен — показан текстовый поиск";
    return { hits, tookMs: Math.round(performance.now() - t0), weak, variants, degraded: true, degradedReason: reason };
  }

  return { hits, tookMs: Math.round(performance.now() - t0), weak, variants };
}

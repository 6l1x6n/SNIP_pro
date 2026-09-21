import { describe, it, expect, vi, afterEach } from "vitest";
import { fallbackLinks } from "../index";
import type { Env } from "../index";

/** Мини-стаб D1: settings — с заданными ключами (getSettings кэшируется на 5 мин — в тестах сдвигаем время). */
function makeEnv(keys: Record<string, string | undefined>, settings: Record<string, string> = {}): Env {
  return {
    DB: {
      prepare: (sql: string) => {
        const isSettings = sql.toUpperCase().includes("FROM SETTINGS");
        const stmt: any = {
          bind: () => stmt,
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
          all: async () => ({
            results: isSettings
              ? Object.entries(settings).map(([key, value]) => ({ key, value, updated_at: null }))
              : [],
          }),
        };
        void sql;
        return stmt;
      },
      batch: async () => [],
    } as unknown as Env["DB"],
    ...keys,
  } as unknown as Env;
}

const KEYS = {
  GEMINI_API_KEY: "k1",
  GEMINI_API_KEY_2: "k2",
  GEMINI_API_KEY_3: "k3",
  GEMINI_API_KEY_4: "k4",
  GEMINI_ALT_MODEL: "gemini-2.5-flash-lite",
  CEREBRAS_API_KEY: "c1",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("fallbackLinks: gemini alt-ключи", () => {
  it("4 ключа → primary + 3 alt-звена, порядок: после groq-alt, до cerebras", async () => {
    const links = await fallbackLinks(makeEnv(KEYS));
    const gemini = links.filter((l) => l.id === "gemini").map((l) => l.variant);
    expect(gemini).toEqual(["", "alt-2", "alt-3", "alt-4"]);
    const ids = links.map((l) => l.id);
    expect(ids.indexOf("gemini")).toBeGreaterThan(ids.indexOf("groq-alt"));
    expect(ids.indexOf("cerebras")).toBeGreaterThan(ids.indexOf("gemini"));
  });

  it("без alt-ключей → только primary gemini", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60_000); // сброс кэша настроек (TTL 5 мин)
    const links = await fallbackLinks(makeEnv({ GEMINI_API_KEY: "k1", CEREBRAS_API_KEY: "c1" }));
    const gemini = links.filter((l) => l.id === "gemini");
    expect(gemini.length).toBe(1);
    expect(gemini[0].variant).toBe("");
  });

  it("kill-switch llm_gemini=0 убирает все gemini-звенья разом", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 12 * 60_000); // и ещё раз — настройки перечитываются
    const links = await fallbackLinks(makeEnv(KEYS, { llm_gemini: "0" }));
    expect(links.filter((l) => l.id === "gemini").length).toBe(0);
  });
});

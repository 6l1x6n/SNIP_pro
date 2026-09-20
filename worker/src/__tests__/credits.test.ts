import { describe, it, expect } from "vitest";
import type { Env } from "../index";
import { chargeHybrid, refundCharge, getCreditsState } from "../index";

/**
 * Мини-стаб D1: поддерживает ровно те Statements, что нужны кредитному контуру
 * (usage / balances / ledger / settings / subscriptions). Любое изменение SQL в
 * chargeHybrid уронит тест — это осознанно: смена контракта должна быть заметна.
 */
function makeD1() {
  const usage = new Map<string, number>(); // key: day|subject
  const balances = new Map<string, number>(); // subject → credits
  const ledger: Array<Record<string, unknown>> = [];

  const exec = (sql: string, params: unknown[] = []): any => {
    const s = sql.toUpperCase();
    if (s.startsWith("CREATE TABLE")) return { results: [] };
    if (s.includes("FROM SETTINGS")) return { results: [] };
    if (s.includes("FROM SUBSCRIPTIONS")) return { results: [] };
    if (s.includes("SELECT COUNT FROM USAGE")) {
      const [day, subject] = params as [string, string];
      const count = usage.get(`${day}|${subject}`) ?? 0;
      return { count: count ? { count } : null, results: [] };
    }
    if (s.includes("SELECT CREDITS FROM BALANCES")) {
      const [subject] = params as [string];
      const credits = balances.get(subject);
      return { count: credits !== undefined ? { credits } : null, results: [] };
    }
    if (s.startsWith("UPDATE BALANCES")) {
      // UPDATE balances SET credits = credits - ?, updated_at = ? WHERE subject = ? AND credits >= ?
      const [delta, , subject, minCredits] = params as [number, string, string, number];
      const cur = balances.get(subject) ?? 0;
      if (cur >= minCredits) {
        balances.set(subject, cur - delta);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (s.startsWith("INSERT INTO USAGE")) {
      const [day, subject, n] = params as [string, string, number];
      const key = `${day}|${subject}`;
      usage.set(key, (usage.get(key) ?? 0) + n);
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE USAGE")) {
      // UPDATE usage SET count = MAX(0, count - ?) WHERE day = ? AND subject = ?
      const [dec, day, subject] = params as [number, string, string];
      const key = `${day}|${subject}`;
      usage.set(key, Math.max(0, (usage.get(key) ?? 0) - dec));
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO BALANCES")) {
      const [subject, credits] = params as [string, number];
      balances.set(subject, (balances.get(subject) ?? 0) + credits);
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO LEDGER")) {
      const [subject, delta, kind, meta] = params as [string, number, string, string];
      ledger.push({ subject, delta, kind, meta });
      return { meta: { changes: 1 } };
    }
    throw new Error(`D1 stub: неизвестный SQL: ${sql}`);
  };

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt;
      },
      first: async () => exec(sql, bound)?.count ?? null,
      run: async () => exec(sql, bound),
      all: async () => ({ results: exec(sql, bound)?.results ?? [] }),
    };
    return stmt;
  };
  return {
    prepare,
    batch: async (stmts: ReturnType<typeof prepare>[]) => {
      for (const st of stmts) await st.run();
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
    _state: { usage, balances, ledger },
  };
}

function makeEnv(): { env: Env; d1: ReturnType<typeof makeD1> } {
  const d1 = makeD1();
  return { env: { DB: d1 } as unknown as Env, d1 };
}

describe("chargeHybrid (гость)", () => {
  it("списание в пределах дневного лимита — только daily-доля", async () => {
    const { env } = makeEnv();
    const r = await chargeHybrid(env, "anon:dev1", false, 5, "ask");
    expect(r.ok).toBe(true);
    expect(r.split).toEqual({ daily: 5, balance: 0 });
    expect(r.state.daily.used).toBe(5);
    expect(r.state.daily.remaining).toBe(25); // дефолт quota_anon=30
  });

  it("лимит исчерпан → остаток уходит с баланса", async () => {
    const { env, d1 } = makeEnv();
    d1._state.balances.set("anon:dev2", 100);
    // 3 × 10 = 30 daily (лимит 30), четвёртое списание — с баланса
    for (let i = 0; i < 3; i++) {
      const r = await chargeHybrid(env, "anon:dev2", false, 10, "ask");
      expect(r.ok).toBe(true);
    }
    const r4 = await chargeHybrid(env, "anon:dev2", false, 10, "ask");
    expect(r4.ok).toBe(true);
    expect(r4.split).toEqual({ daily: 0, balance: 10 });
    expect(d1._state.balances.get("anon:dev2")).toBe(90);
  });

  it("нет лимита и нет баланса → 402-аналог ok:false с need", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 3; i++) await chargeHybrid(env, "anon:dev3", false, 10, "ask");
    const r = await chargeHybrid(env, "anon:dev3", false, 10, "ask");
    expect(r.ok).toBe(false);
    expect(r.need).toBeGreaterThan(0);
  });

  it("guard-UPDATE не уходит в минус при гонке (changes=0 → ok:false)", async () => {
    const { env, d1 } = makeEnv();
    d1._state.balances.set("anon:race", 4);
    // дневной лимит 30 покрывает cost=10 целиком — guard не участвует;
    // поэтому имитируем гонку: balance=4, cost=10, daily remaining=0
    for (let i = 0; i < 3; i++) await chargeHybrid(env, "anon:race", false, 10, "ask");
    d1._state.balances.set("anon:race", 4); // баланс меньше нужного
    const r = await chargeHybrid(env, "anon:race", false, 10, "ask");
    expect(r.ok).toBe(false);
    expect(d1._state.balances.get("anon:race")).toBe(4);
  });
});

describe("refundCharge", () => {
  it("восстанавливает точный split: daily в usage, balance на счёт", async () => {
    const { env, d1 } = makeEnv();
    d1._state.balances.set("anon:ref", 10);
    // 3 × 10 = 30 — дневной лимит исчерпан целиком (split = daily)
    for (let i = 0; i < 3; i++) {
      const r = await chargeHybrid(env, "anon:ref", false, 10, "ask");
      expect(r.ok).toBe(true);
      expect(r.split).toEqual({ daily: 10, balance: 0 });
    }
    // 4-е списание — с баланса (split = balance)
    const r4 = await chargeHybrid(env, "anon:ref", false, 10, "ask");
    expect(r4.ok).toBe(true);
    expect(r4.split).toEqual({ daily: 0, balance: 10 });
    expect(d1._state.balances.get("anon:ref")).toBe(0);

    await refundCharge(env, "anon:ref", false, 10, r4.split!, "ask");
    const st = await getCreditsState(env, "anon:ref", false);
    expect(st.balance).toBe(10);
    expect(st.daily.used).toBe(30); // balance-доля не трогает usage
  });
});

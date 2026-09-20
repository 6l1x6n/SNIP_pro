import { describe, it, expect } from "vitest";
import {
  classifyAsk,
  stripLeadingYesNo,
  isPermissionQuestion,
  sanitizeContextText,
  isTableLike,
  extractTableTitle,
  vFindLimits,
  vViolates,
  vFormatLimit,
  vVerdictPolarity,
  llmBudgetCap,
  parseRewriteJson,
} from "../index";

describe("classifyAsk (роутер сложности)", () => {
  it("короткий фактологический → simple", () => {
    expect(classifyAsk("какая высота ограждения лестницы?")).toBe("simple");
  });
  it("развернутый/сравнивающий вопрос → complex", () => {
    const r = classifyAsk("сравните требования к эвакуационным выходам для школы и театра, объясните разницу подробно");
    expect(["complex", "standard"]).toContain(r);
  });
  it("пустышка → standard", () => {
    expect(classifyAsk("требования к лестницам")).toBe("standard");
  });
});

describe("values-эвристики", () => {
  it("vFindLimits ловит «не менее 1,2 м»", () => {
    const limits = vFindLimits("ширина коридора должна быть не менее 1,2 м");
    expect(limits.length).toBeGreaterThanOrEqual(1);
    expect(limits[0].v).toBeCloseTo(1.2);
  });

  it("vViolates: ops — это >=/<=/range, не слова", () => {
    expect(vViolates(1.0, ">=", 1.2)).toBe(true);
    expect(vViolates(1.5, ">=", 1.2)).toBe(false);
    expect(vViolates(3.0, "<=", 2.5)).toBe(true);
    expect(vViolates(3.0, "range", 2.0, 2.8)).toBe(true);
    expect(vViolates(2.5, "range", 2.0, 2.8)).toBe(false);
  });

  it("vFormatLimit: русская запятая и словесная граница", () => {
    expect(vFormatLimit(">=", 1.6, "м")).toBe("не менее 1,6 м");
    expect(vFormatLimit("<=", 30, "мм")).toBe("не более 30 мм");
    expect(vFormatLimit(">=", 5, "эт")).toBe("не ниже 5-го этажа");
  });

  it("vVerdictPolarity: да/нет в ответе", () => {
    expect(vVerdictPolarity("Да, допускается")).toBe("yes");
    expect(vVerdictPolarity("Нет, не допускается")).toBe("no");
    expect(vVerdictPolarity("требование составляет 3 м")).toBe("unknown");
  });
});

describe("санитизация и ответы", () => {
  it("stripLeadingYesNo убирает «Да,» в начале", () => {
    expect(stripLeadingYesNo("Да, ширина должна быть 1,2 м")).toBe("ширина должна быть 1,2 м");
  });

  it("isPermissionQuestion: «можно ли» → true", () => {
    expect(isPermissionQuestion("можно ли объединять санузлы?")).toBe(true);
    expect(isPermissionQuestion("какая высота потолков?")).toBe(false);
  });

  it("sanitizeContextText вырезает точки-оглавления («заголовок ..... 95»)", () => {
    const out = sanitizeContextText("Минимальные расстояния между зданиями ..... 95");
    expect(out).not.toMatch(/\d\s*$/);
    expect(out).toContain("расстояния между зданиями");
  });
});

describe("таблицы (worker-side)", () => {
  it("isTableLike: ty=table — всегда таблица", () => {
    expect(isTableLike("любой текст", "table")).toBe(true);
  });

  it("isTableLike: плотность «Число + Слово с заглавной» — признак таблицы", () => {
    expect(isTableLike("100 Мест в зале, 2 Входа с улицы, 25 Процентов площади")).toBe(true);
    expect(isTableLike("Обычный абзац с требованиями к лестницам и проходам зданий.")).toBe(false);
  });

  it("extractTableTitle достаёт номер таблицы", () => {
    expect(extractTableTitle("Таблица 6.5 — Ширина проходов")).toMatch(/6\.5/);
  });
});

describe("llmBudgetCap", () => {
  it("настройка бюджет-ключа перекрывает дефолт", () => {
    expect(llmBudgetCap({ budget_groq: "123" }, "groq")).toBe(123);
  });

  it("неизвестный провайдер → дефолт 100; ноль → звено мягко отключено", () => {
    expect(llmBudgetCap({}, "нет-такого")).toBe(100);
    expect(llmBudgetCap({ budget_cohere_rerank: "0" }, "cohere-rerank")).toBe(0);
  });
});

describe("parseRewriteJson (устойчивый разбор)", () => {
  it("валидный JSON", () => {
    const r = parseRewriteJson('{"standalone":"вопрос","queries":["поиск один","поиск два"],"terms":["термин"]}', "вопрос");
    expect(r.queries).toEqual(["поиск один", "поиск два"]);
    expect(r.terms).toContain("термин");
  });

  it("модель вернула мусор вокруг JSON — вытаскиваем queries регуляркой", () => {
    const r = parseRewriteJson('Вот переформулировки: {"queries":["ширина коридора в школе","эвакуационный выход"], "standalone":"s"} ок', "x");
    expect(r.queries.length).toBeGreaterThanOrEqual(2);
  });

  it("выдуманные номера документов вырезаются", () => {
    const r = parseRewriteJson('{"queries":["ширина по СНиП 2.04.02-85 для школ"]}', "ширина для школ");
    expect(r.queries[0]).not.toMatch(/СНиП/i);
  });

  it("короткие (<3 симв.) формулировки отбрасываются", () => {
    const r = parseRewriteJson('{"queries":["ab","нормальная формулировка"]}', "x");
    expect(r.queries).toEqual(["нормальная формулировка"]);
  });
});

/**
 * stem.test.ts — паритет-тест токенизатора: TS-реализация (stem.ts) должна
 * выдавать ТО ЖЕ, что эталонный tokenize() из scripts/build_index.py.
 * Фикстуру генерирует scripts/gen_tokenize_fixture.py (реальные чанки корпуса
 * + краевые случаи); если изменил токенизатор — перегенерируй её и поправь
 * вторую реализацию синхронно.
 */
import { describe, expect, it } from "vitest";
import { tokenize } from "./stem";
import fixture from "./__fixtures__/tokenize_fixture.json";

describe("tokenize — паритет с build_index.py", () => {
  it.each(fixture.map(([text, expected]) => [text as string, expected as string[]]))(
    "%#. %s",
    (text, expected) => {
      expect(tokenize(text)).toEqual(expected);
    }
  );

  it("фикстура не пустая", () => {
    expect(fixture.length).toBeGreaterThanOrEqual(50);
  });
});

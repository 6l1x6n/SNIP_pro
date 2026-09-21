import { describe, it, expect } from "vitest";
import { makeResetCode, hashPassword, verifyPassword } from "../index";

describe("восстановление пароля", () => {
  it("код — 6 цифр, при повторе меняется", () => {
    for (let i = 0; i < 20; i++) expect(makeResetCode()).toMatch(/^\d{6}$/);
    const codes = new Set(Array.from({ length: 30 }, () => makeResetCode()));
    expect(codes.size).toBeGreaterThan(20); // не константа
  });

  it("хеш кода проверяется тем же PBKDF2, что и пароли", async () => {
    const code = makeResetCode();
    const h = await hashPassword(code);
    expect(await verifyPassword(code, h)).toBe(true);
    expect(await verifyPassword("000000", h)).toBe(code === "000000");
  });
});

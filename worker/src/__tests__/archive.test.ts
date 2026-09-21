import { describe, it, expect } from "vitest";
import { buildDeletionText, DELETION_REASONS, fmtRuDate, ARCHIVE_DAYS } from "../index";

describe("удаление аккаунтов (архив)", () => {
  it("причины: 4 шт., у каждой id/заголовок/шаблон с {имя}", () => {
    expect(DELETION_REASONS.length).toBe(4);
    for (const r of DELETION_REASONS) {
      expect(r.id).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(typeof r.template).toBe("string");
    }
    // в on_request {имя} обязателен — письмо персональное
    expect(DELETION_REASONS.find((r) => r.id === "on_request")?.template).toContain("{имя}");
  });

  it("buildDeletionText подставляет имя и обращение", () => {
    const t = buildDeletionText("Айдос", "Ваш аккаунт удалён. {имя}, сверьте почту.");
    expect(t).toContain("Уважаемый Айдос!");
    expect(t).not.toContain("{имя}");
  });

  it("buildDeletionText без имени — «пользователь»", () => {
    expect(buildDeletionText(null, "Текст.")).toBe("Уважаемый пользователь! Текст.");
    expect(buildDeletionText("  ", "Текст.")).toBe("Уважаемый пользователь! Текст.");
  });

  it("fmtRuDate: ISO → дд.мм.гггг", () => {
    expect(fmtRuDate("2026-10-21T12:00:00Z")).toBe("21.10.2026");
    expect(fmtRuDate("мусор")).toBe("мусор");
  });

  it("срок архива — 30 дней", () => {
    expect(ARCHIVE_DAYS).toBe(30);
  });
});

import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt, verifyJwtWithReason } from "../index";

const SECRET = "test-secret-абсолютно-любой";

describe("signJwt/verifyJwt", () => {
  it("roundtrip: payload возвращается, exp проставлен", async () => {
    const token = await signJwt({ uid: "u1", email: "a@b.kz" }, SECRET, 3600);
    const payload = await verifyJwt(token, SECRET);
    expect(payload?.uid).toBe("u1");
    expect(payload?.email).toBe("a@b.kz");
    expect(typeof payload?.exp).toBe("number");
  });

  it("токен не проходит с чужим секретом", async () => {
    const token = await signJwt({ uid: "u1" }, SECRET);
    expect(await verifyJwt(token, "другой-секрет")).toBeNull();
  });

  it("подделка payload ловится", async () => {
    const token = await signJwt({ uid: "u1" }, SECRET);
    const [h, , sig] = token.split(".");
    const forgedBody = btoa(JSON.stringify({ uid: "admin" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyJwt(`${h}.${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("мусор — invalid, просроченный — expired", async () => {
    expect((await verifyJwtWithReason("не-токен", SECRET)).reason).toBe("invalid");
    const expired = await signJwt({ uid: "u1" }, SECRET, -10);
    const r = await verifyJwtWithReason(expired, SECRET);
    expect(r.payload).toBeNull();
    expect(r.reason).toBe("expired");
    const fresh = await verifyJwtWithReason(await signJwt({ uid: "u1" }, SECRET), SECRET);
    expect(fresh.reason).toBeNull();
  });
});

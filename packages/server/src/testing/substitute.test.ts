import { describe, test, expect } from "bun:test";
import { substitute } from "./substitute.ts";

// PRD_TESTING T1.3/T1.7/T4.1 — server-side template substitution.

const noSecrets = new Set<string>();

describe("substitute — env / prev / cases", () => {
  test("{{env.KEY}} resolves + reports no secrets when not marked", () => {
    const r = substitute("hello {{env.NAME}}", { env: { NAME: "world" }, boardSecrets: noSecrets });
    expect(r.value).toBe("hello world");
    expect(r.secretsUsed).toEqual([]);
  });

  test("{{env.KEY}} on a board-secret marks the value for redaction", () => {
    const r = substitute("Bearer {{env.API_KEY}}", { env: { API_KEY: "sk_live_1234567890" }, boardSecrets: new Set(["API_KEY"]) });
    expect(r.value).toBe("Bearer sk_live_1234567890");
    expect(r.secretsUsed).toEqual(["sk_live_1234567890"]);
  });

  test("{{secret.KEY}} tracks even when the key isn't in boardSecrets", () => {
    const r = substitute("{{secret.OVERRIDE}}", { env: { OVERRIDE: "hunter2" }, boardSecrets: noSecrets });
    expect(r.value).toBe("hunter2");
    expect(r.secretsUsed).toEqual(["hunter2"]);
  });

  test("unresolved placeholder passes through unchanged and is reported", () => {
    const r = substitute("prefix {{env.NOPE}} suffix", { env: {}, boardSecrets: noSecrets });
    expect(r.value).toBe("prefix {{env.NOPE}} suffix");
    expect(r.unresolved).toEqual(["{{env.NOPE}}"]);
  });

  test("{{prev.field}} resolves from the parent chain response", () => {
    const r = substitute("id={{prev.id}}", { env: {}, boardSecrets: noSecrets, prev: { id: 42, name: "note" } });
    expect(r.value).toBe("id=42");
    expect(r.unresolved).toEqual([]);
  });

  test("{{prev.nested.field}} walks dotted paths", () => {
    const r = substitute("owner={{prev.owner.name}}", { env: {}, boardSecrets: noSecrets, prev: { owner: { name: "Nish" } } });
    expect(r.value).toBe("owner=Nish");
  });

  test("{{prev.items[0].id}} walks array indices", () => {
    const r = substitute("first={{prev.items[0].id}}", { env: {}, boardSecrets: noSecrets, prev: { items: [{ id: 7 }, { id: 8 }] } });
    expect(r.value).toBe("first=7");
  });

  test("{{cases.ALIAS.path}} resolves from a named prior case", () => {
    const r = substitute("mixed {{cases.createUser.id}}", {
      env: {}, boardSecrets: noSecrets,
      cases: { createUser: { id: "user-123", name: "n" } },
    });
    expect(r.value).toBe("mixed user-123");
  });

  test("multiple placeholders + multiple secrets accumulate", () => {
    const r = substitute("A={{env.A}}, B={{env.B}}, C={{env.C}}", {
      env: { A: "aa", B: "top-secret-b", C: "cc" },
      boardSecrets: new Set(["B"]),
    });
    expect(r.value).toBe("A=aa, B=top-secret-b, C=cc");
    expect(r.secretsUsed).toEqual(["top-secret-b"]);
  });
});

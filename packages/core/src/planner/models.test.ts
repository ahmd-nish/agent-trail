import { describe, test, expect } from "bun:test";
import { MODEL_FOR_TIER, resolveModel, suggestTier } from "./models.ts";

describe("MODEL_FOR_TIER", () => {
  test("has an entry for every tier", () => {
    expect(MODEL_FOR_TIER.haiku).toBeTruthy();
    expect(MODEL_FOR_TIER.sonnet).toBeTruthy();
    expect(MODEL_FOR_TIER.opus).toBeTruthy();
  });

  test("model IDs match the Claude 4.X family", () => {
    for (const model of Object.values(MODEL_FOR_TIER)) {
      expect(model).toMatch(/^claude-(haiku|sonnet|opus)-4-/);
    }
  });
});

describe("resolveModel", () => {
  test("explicit model wins over tier", () => {
    expect(resolveModel("claude-sonnet-4-7", "haiku")).toBe("claude-sonnet-4-7");
  });

  test("falls back to tier when explicit model is null", () => {
    expect(resolveModel(null, "opus")).toBe(MODEL_FOR_TIER.opus);
  });

  test("falls back to tier when explicit model is empty string", () => {
    expect(resolveModel("", "sonnet")).toBe(MODEL_FOR_TIER.sonnet);
  });

  test("returns null when both are absent", () => {
    expect(resolveModel(null, null)).toBeNull();
    expect(resolveModel(undefined, undefined)).toBeNull();
  });

  test("blank-space-only explicit model still triggers tier fallback", () => {
    expect(resolveModel("   ", "haiku")).toBe(MODEL_FOR_TIER.haiku);
  });
});

describe("suggestTier", () => {
  test("code + tests → sonnet (default)", () => {
    expect(suggestTier({
      title: "Build POST /shorten endpoint",
      description: "Implement URL shortening logic with SQLite backing",
      tddEnabled: true,
      reviewKind: "automated",
    })).toBe("sonnet");
  });

  test("docs task with tdd disabled → haiku", () => {
    expect(suggestTier({
      title: "Write API documentation",
      description: "Docs for the /shorten endpoint",
      tddEnabled: false,
      reviewKind: "none",
    })).toBe("haiku");
  });

  test("README task with human review → haiku", () => {
    expect(suggestTier({
      title: "Update README.md",
      description: "documentation refresh",
      tddEnabled: false,
      reviewKind: "human",
    })).toBe("haiku");
  });

  test("config task without tests → haiku", () => {
    expect(suggestTier({
      title: "Configuration file for CI",
      description: "GH actions config",
      tddEnabled: false,
      reviewKind: "none",
    })).toBe("haiku");
  });

  test("code task even with docs mention stays sonnet if tdd enabled", () => {
    expect(suggestTier({
      title: "Serve docs from the API",
      description: "Route /docs to serve static documentation HTML",
      tddEnabled: true,
      reviewKind: "browser",
    })).toBe("sonnet");
  });

  test("component with UI review defaults to sonnet", () => {
    expect(suggestTier({
      title: "Login page",
      description: "email+password form",
      tddEnabled: true,
      reviewKind: "browser",
      component: "LoginPage.tsx",
    })).toBe("sonnet");
  });

  test("empty task hints → sonnet (safe default)", () => {
    expect(suggestTier({})).toBe("sonnet");
  });
});

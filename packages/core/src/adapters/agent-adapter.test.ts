import { describe, test, expect, beforeAll } from "bun:test";
import { getAdapter, listAdapters, registerAdapter } from "./agent-adapter.ts";
import { spawnClaudeCode } from "./claude-code.ts";

// PRD_OPEN_SOURCE 2.4 — adapter registry contract.
// Other test files (execution-manager.test.ts) mock the claude-code module
// which can wipe its registerAdapter side-effect from the shared cache.
// We register explicitly here so this test isn't order-sensitive.

describe("AgentAdapter registry", () => {
  beforeAll(() => {
    if (!getAdapter("claude-code")) {
      registerAdapter("claude-code", spawnClaudeCode);
    }
  });

  test("claude-code is registered", () => {
    expect(getAdapter("claude-code")).toBeTypeOf("function");
    expect(listAdapters()).toContain("claude-code");
  });

  test("a third-party adapter can register at runtime", () => {
    const fake = () => null;
    registerAdapter("custom", fake);
    expect(getAdapter("custom")).toBe(fake);
    expect(listAdapters()).toContain("custom");
  });

  test("getAdapter returns undefined for an unregistered kind", () => {
    // The mocked claude-code module in execution-manager.test.ts might have
    // wiped registrations; that test manually re-registers via the fake path
    // below. "gemini" isn't in any bundle so this stays undefined.
    expect(getAdapter("gemini")).toBeUndefined();
  });
});

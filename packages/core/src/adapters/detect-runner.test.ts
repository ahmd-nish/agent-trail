import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRunner, parseCounts, escapeFilterForRunner } from "./test-runner.ts";

// PRD_TESTING T2.3 (honest detection) + T2.2 (structured runner output),
// plus the T0.4 filter-escape surface extended to the new runners.

function fresh(): string { return mkdtempSync(join(tmpdir(), "at-detect-")); }
function cleanup(dir: string): void { rmSync(dir, { recursive: true, force: true }); }

describe("detectRunner (T2.3)", () => {
  test("jest.config.js → jest even without a package.json", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "jest.config.js"), "module.exports = {}");
      expect(detectRunner(dir)).toBe("jest");
    } finally { cleanup(dir); }
  });

  test("vitest.config.ts → vitest", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "vitest.config.ts"), "export default {}");
      expect(detectRunner(dir)).toBe("vitest");
    } finally { cleanup(dir); }
  });

  test("playwright.config.ts → playwright", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "playwright.config.ts"), "export default {}");
      expect(detectRunner(dir)).toBe("playwright");
    } finally { cleanup(dir); }
  });

  test(".mocharc.json → mocha", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, ".mocharc.json"), "{}");
      expect(detectRunner(dir)).toBe("mocha");
    } finally { cleanup(dir); }
  });

  test("bare pyproject.toml (no pytest string) does NOT default to pytest — fixes B3", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "pyproject.toml"), `
        [project]
        name = "some-python-lib"
        version = "0.1.0"
      `);
      // No pytest anywhere → shouldn't be pytest. Nothing else strong either,
      // so it falls back to bun (no lockfile, no package.json).
      expect(detectRunner(dir)).toBe("bun");
    } finally { cleanup(dir); }
  });

  test("pyproject.toml with [tool.pytest] block → pytest", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "pyproject.toml"), `
        [project]
        name = "x"

        [tool.pytest.ini_options]
        testpaths = ["tests"]
      `);
      expect(detectRunner(dir)).toBe("pytest");
    } finally { cleanup(dir); }
  });

  test("go.mod → go", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com\n\ngo 1.22\n");
      expect(detectRunner(dir)).toBe("go");
    } finally { cleanup(dir); }
  });

  test("Cargo.toml → cargo", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
      expect(detectRunner(dir)).toBe("cargo");
    } finally { cleanup(dir); }
  });

  test(".csproj → dotnet", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "MyApp.csproj"), "<Project />");
      expect(detectRunner(dir)).toBe("dotnet");
    } finally { cleanup(dir); }
  });

  test("node-only repo (package.json, no bun lockfile) → npm — fixes B3", () => {
    // Old code returned "npm" but ran `bun run test`, breaking node-only setups.
    // New code returns "npm" which we then invoke via `npm test`.
    const dir = fresh();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "node-only", scripts: { test: "node --test" },
      }));
      expect(detectRunner(dir)).toBe("npm");
    } finally { cleanup(dir); }
  });

  test("bun lockfile → bun even when scripts.test is empty", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b" }));
      writeFileSync(join(dir, "bun.lock"), "");
      expect(detectRunner(dir)).toBe("bun");
    } finally { cleanup(dir); }
  });

  test(".agent-trail/runner override wins over all heuristics", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "would-be-npm", scripts: { test: "vitest" },
      }));
      mkdirSync(join(dir, ".agent-trail"), { recursive: true });
      writeFileSync(join(dir, ".agent-trail", "runner"), "jest\n");
      expect(detectRunner(dir)).toBe("jest");
    } finally { cleanup(dir); }
  });

  test(".agent-trail/runner with an unknown value is ignored", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "x", scripts: { test: "vitest" },
      }));
      mkdirSync(join(dir, ".agent-trail"), { recursive: true });
      writeFileSync(join(dir, ".agent-trail", "runner"), "moon-tests\n");
      expect(detectRunner(dir)).toBe("vitest");
    } finally { cleanup(dir); }
  });
});

describe("parseCounts — new runners (T2.2)", () => {
  test("go test -json: counts pass/fail Test events", () => {
    const output = [
      `{"Action":"run","Package":"x","Test":"TestA"}`,
      `{"Action":"pass","Package":"x","Test":"TestA","Elapsed":0.01}`,
      `{"Action":"run","Package":"x","Test":"TestB"}`,
      `{"Action":"fail","Package":"x","Test":"TestB","Elapsed":0.01}`,
      `{"Action":"pass","Package":"x","Elapsed":0.02}`, // package-level — must be ignored
    ].join("\n");
    const c = parseCounts("go", output);
    expect(c.pass).toBe(1);
    expect(c.fail).toBe(1);
    expect(c.total).toBe(2);
  });

  test("cargo test: parses `test result: ok. N passed; M failed; K ignored`", () => {
    const output = `
running 5 tests
test tests::add_positive ... ok
test tests::add_negative ... FAILED

test result: FAILED. 4 passed; 1 failed; 2 ignored; 0 measured
`;
    const c = parseCounts("cargo", output);
    expect(c.pass).toBe(4);
    expect(c.fail).toBe(1);
    expect(c.total).toBe(7);
  });

  test("mocha --reporter json: reads stats.{passes,failures,tests}", () => {
    const j = JSON.stringify({ stats: { tests: 5, passes: 4, failures: 1, pending: 0 } });
    const c = parseCounts("mocha", j);
    expect(c.pass).toBe(4);
    expect(c.fail).toBe(1);
    expect(c.total).toBe(5);
  });

  test("playwright --reporter=json: reads stats.{expected,unexpected,skipped}", () => {
    const j = JSON.stringify({ stats: { expected: 10, unexpected: 2, skipped: 1 } });
    const c = parseCounts("playwright", j);
    expect(c.pass).toBe(10);
    expect(c.fail).toBe(2);
    expect(c.total).toBe(13);
  });

  test("dotnet test summary line", () => {
    const output = `Test Run Successful.
Total tests: 12
     Passed: 12
 Total time: 1.2 s
Failed: 0, Passed: 12, Skipped: 0, Total: 12, Duration: 1.2 s`;
    const c = parseCounts("dotnet", output);
    expect(c.pass).toBe(12);
    expect(c.fail).toBe(0);
    expect(c.total).toBe(12);
  });
});

describe("escapeFilterForRunner — new runners (T0.4 extended)", () => {
  test("mocha uses regex like jest — escapes metachars", () => {
    expect(escapeFilterForRunner("mocha", "GET /r/:code (302)")).toBe("GET /r/:code \\(302\\)");
  });

  test("go uses Go regex — escapes metachars", () => {
    expect(escapeFilterForRunner("go", "TestAdd(negative)")).toBe("TestAdd\\(negative\\)");
  });

  test("cargo passes filter through as literal substring", () => {
    expect(escapeFilterForRunner("cargo", "tests::add")).toBe("tests::add");
  });

  test("dotnet builds Name~substring filter, drops boolean operators", () => {
    // `|` `&` `(` `)` are dotnet-filter operators — must be stripped so a
    // test named "MyTest|Foo(Bar)" doesn't get reinterpreted as a boolean expr.
    expect(escapeFilterForRunner("dotnet", "MyTest|Foo(Bar)")).toBe("Name~MyTestFooBar");
    expect(escapeFilterForRunner("dotnet", "GreetsPerson")).toBe("Name~GreetsPerson");
  });
});

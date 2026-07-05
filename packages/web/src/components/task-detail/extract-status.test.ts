import { describe, test, expect } from "bun:test";
import { extractStatus } from "./generate-test-cases.ts";

// PRD_TESTING T0.3 — extractStatus should only fire when a 1xx–5xx number
// sits next to a status-y word. This fixes the worst symptom of A5:
// "create 500 notes" used to be misread as "expects 500".

describe("extractStatus (T0.3)", () => {
  test("classic phrasings pick up the status", () => {
    expect(extractStatus("returns 200")).toBe(200);
    expect(extractStatus("responds with 404")).toBe(404);
    expect(extractStatus("expects 201 Created")).toBe(201);
    expect(extractStatus("expect status 409")).toBe(409);
    expect(extractStatus("status code: 500")).toBe(500);
  });

  test("arrow notation from PRDs works", () => {
    expect(extractStatus("POST /notes → 201")).toBe(201);
    expect(extractStatus("GET /r/:code -> 302")).toBe(302);
    expect(extractStatus("bad payload => 400")).toBe(400);
  });

  test("bare 3-digit numbers are NOT treated as status codes", () => {
    // These are the real-world false positives from the audit.
    expect(extractStatus("create 500 notes")).toBeUndefined();
    expect(extractStatus("import 404 records from the legacy DB")).toBeUndefined();
    expect(extractStatus("page contains 200 entries")).toBeUndefined();
    expect(extractStatus("wait 300 milliseconds between retries")).toBeUndefined();
  });

  test("suffix descriptors count as status context", () => {
    expect(extractStatus("A 404 response is returned")).toBe(404);
    expect(extractStatus("Server returns 201 Created")).toBe(201);
  });

  test("numbers outside 100–599 are rejected even with a status word", () => {
    expect(extractStatus("returns 000")).toBeUndefined();
    expect(extractStatus("returns 999")).toBeUndefined();
  });
});

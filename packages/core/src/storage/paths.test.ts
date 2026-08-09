import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolveDbPath, DB_FILENAME } from "./paths.ts";

describe("resolveDbPath", () => {
  const originalNew = process.env["INVENTARIUM_DB_PATH"];
  const originalOld = process.env["AGENT_TRAIL_DB_PATH"];

  beforeEach(() => {
    delete process.env["INVENTARIUM_DB_PATH"];
    delete process.env["AGENT_TRAIL_DB_PATH"];
  });

  afterEach(() => {
    if (originalNew === undefined) delete process.env["INVENTARIUM_DB_PATH"];
    else process.env["INVENTARIUM_DB_PATH"] = originalNew;
    if (originalOld === undefined) delete process.env["AGENT_TRAIL_DB_PATH"];
    else process.env["AGENT_TRAIL_DB_PATH"] = originalOld;
  });

  it("joins the repo root with DB_FILENAME by default", () => {
    // /tmp/repo doesn't exist, so the legacy-rename branch is a no-op.
    expect(resolveDbPath("/tmp/repo")).toBe(`/tmp/repo/${DB_FILENAME}`);
  });

  it("returns the new env override verbatim when set", () => {
    process.env["INVENTARIUM_DB_PATH"] = "/some/other/place.db";
    expect(resolveDbPath("/tmp/repo")).toBe("/some/other/place.db");
  });

  it("falls back to legacy AGENT_TRAIL_DB_PATH when the new var is unset", () => {
    process.env["AGENT_TRAIL_DB_PATH"] = "/legacy/path.db";
    expect(resolveDbPath("/tmp/repo")).toBe("/legacy/path.db");
  });

  it("ignores blank env overrides", () => {
    process.env["INVENTARIUM_DB_PATH"] = "   ";
    expect(resolveDbPath("/tmp/repo")).toBe(`/tmp/repo/${DB_FILENAME}`);
  });
});

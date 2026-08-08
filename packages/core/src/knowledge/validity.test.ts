import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCodeIndex, type CodeIndex } from "./code-index.ts";
import { extractContract, type CapabilityContract } from "./contracts.ts";
import {
  checkContractValidity, formatValidityWarning, hashEntries,
  rederiveContract, resolveSignatureSet,
} from "./validity.ts";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "at-validity-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content, "utf-8");
  }
  return root;
}

const V1 = `export function createSession(userId: string): string { return userId; }
export function verifySession(token: string): boolean { return true; }
`;

/** Emit a contract the way execution-manager does: extract, then stamp the
 *  signature set resolved through the adapter. */
async function emit(root: string, paths: string[], index: CodeIndex): Promise<CapabilityContract> {
  const files = paths.map((p) => ({
    path: p,
    content: require("node:fs").readFileSync(join(root, p), "utf8") as string,
  }));
  const contract = extractContract({ taskId: "t-1", baseSha: "abc1234", files })!;
  const set = await resolveSignatureSet(index, contract.provides.modules);
  contract.signatureHash = set.hash;
  contract.signatureEntries = set.entries;
  return contract;
}

describe("§4.2e validity oracle", () => {
  test("an untouched contract is valid", async () => {
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);

    const report = await checkContractValidity(contract, index);
    expect(report.status).toBe("valid");
    expect(report.recordedHash).toBe(report.currentHash!);
    expect(formatValidityWarning(report)).toBe("");   // silence when fine
    rmSync(root, { recursive: true, force: true });
  });

  test("a signature edited OUTSIDE agent-trail is detected, and named", async () => {
    // The §4.2e scenario: a rebase, a hotfix, a teammate on another tool.
    // agent-trail did not author this change and gets no event about it.
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "src/session.ts"),
      `export function createSession(userId: string, ttlMs: number): string { return userId; }
export function verifySession(token: string): boolean { return true; }
`, "utf-8");

    const report = await checkContractValidity(contract, index);
    expect(report.status).toBe("drifted");
    expect(report.changed).toEqual(["sym:src/session.ts#createSession"]);
    expect(report.removed).toEqual([]);
    expect(report.baseSha).toBe("abc1234");
    const warning = formatValidityWarning(report);
    expect(warning).toContain("CONTRACT DRIFTED");
    expect(warning).toContain("createSession");
    rmSync(root, { recursive: true, force: true });
  });

  test("a deleted export is reported as removed, not silently dropped", async () => {
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "src/session.ts"),
      "export function createSession(userId: string): string { return userId; }\n", "utf-8");

    const report = await checkContractValidity(contract, index);
    expect(report.status).toBe("drifted");
    expect(report.removed).toEqual(["sym:src/session.ts#verifySession"]);
    expect(formatValidityWarning(report)).toContain("no longer exists");
    rmSync(root, { recursive: true, force: true });
  });

  test("a newly added export drifts the contract too", async () => {
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "src/session.ts"), V1 + "export function revoke(t: string): void {}\n", "utf-8");

    const report = await checkContractValidity(contract, index);
    expect(report.status).toBe("drifted");
    expect(report.added).toEqual(["sym:src/session.ts#revoke"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a comment-only edit does NOT drift the contract", async () => {
    // Staleness must track the API surface, not the bytes. Otherwise every
    // reformat invalidates every contract and the signal is worthless.
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "src/session.ts"), `// a new comment\n${V1}`, "utf-8");

    expect((await checkContractValidity(contract, index)).status).toBe("valid");
    rmSync(root, { recursive: true, force: true });
  });

  test("a contract with no recorded hash reports unknown, never valid", async () => {
    // Contracts emitted before Phase 3 must degrade to "cannot tell". Reading
    // them as verified-current is the exact false negative that destroys trust.
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const legacy = extractContract({
      taskId: "t-old", baseSha: null,
      files: [{ path: "src/session.ts", content: V1 }],
    })!;
    expect(legacy.signatureHash).toBeUndefined();

    const report = await checkContractValidity(legacy, index);
    expect(report.status).toBe("unknown");
    expect(formatValidityWarning(report)).toContain("unverified");
    rmSync(root, { recursive: true, force: true });
  });

  test("an adapter that resolves nothing reports unknown, not valid", async () => {
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);

    const dead: CodeIndex = {
      name: "dead", available: async () => true,
      symbolsInPaths: async () => [], findSymbol: async () => [],
      getSignature: async () => null, whoCalls: async () => [], indexedAtSha: async () => null,
    };
    // A language server being down must not look like a clean bill of health.
    expect((await checkContractValidity(contract, dead)).status).toBe("unknown");
    rmSync(root, { recursive: true, force: true });
  });

  test("rederiveContract returns today's signatures and keeps human judgement", async () => {
    const root = repo({ "src/session.ts": V1 });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const contract = await emit(root, ["src/session.ts"], index);
    contract.invariants = ["tokens are sha256, never raw"];
    contract.deliberatelyNotDone = ["refresh rotation deferred to t-091"];

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "src/session.ts"),
      "export function createSession(userId: string, ttlMs: number): string { return userId; }\n", "utf-8");

    const fresh = await rederiveContract(contract, index, { baseSha: "def5678" });
    expect(fresh.provides.exports.join(" ")).toContain("ttlMs");
    expect(fresh.baseSha).toBe("def5678");
    // Judgement fields came from reasoning about the ORIGINAL code and are
    // never regenerated — a wrong invariant is worse than a missing one.
    expect(fresh.invariants).toEqual(["tokens are sha256, never raw"]);
    expect(fresh.deliberatelyNotDone).toEqual(["refresh rotation deferred to t-091"]);
    // And the re-derived contract is itself valid.
    expect((await checkContractValidity(fresh, index)).status).toBe("valid");
    rmSync(root, { recursive: true, force: true });
  });

  test("hashEntries is order-independent", () => {
    expect(hashEntries(["b", "a"])).toBe(hashEntries(["a", "b"]));
    expect(hashEntries(["a"])).not.toBe(hashEntries(["a", "b"]));
  });
});

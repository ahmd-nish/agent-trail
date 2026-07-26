import { describe, test, expect } from "bun:test";
import { runDeploy } from "./deploy.ts";

// The MVP deploy adapter is a pure function — we inject a fake runCommand
// and fake fetch to exercise every branch without spawning real shells.

function mockRun(sequence: Array<{ ok?: boolean; output?: string; timedOut?: boolean }>) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    impl: async (cmd: string) => {
      calls.push(cmd);
      const next = sequence[i++] ?? {};
      return { ok: next.ok ?? true, output: next.output ?? "", timedOut: next.timedOut ?? false };
    },
  };
}

describe("runDeploy — PRD §5.6", () => {
  test("happy path with no healthcheck → success", async () => {
    const m = mockRun([{ ok: true, output: "deployed" }]);
    const r = await runDeploy(
      { name: "prod", kind: "shell", command: "./deploy.sh" },
      { runCommandImpl: m.impl },
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("success");
    expect(r.commandOutput).toBe("deployed");
    expect(m.calls).toEqual(["./deploy.sh"]);
  });

  test("healthcheck passes on first try → success", async () => {
    const m = mockRun([{ ok: true, output: "up" }]);
    const fetchMock = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await runDeploy(
      { name: "staging", kind: "shell", command: "./deploy.sh", healthcheckUrl: "https://x/health" },
      { runCommandImpl: m.impl, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("success");
    expect(r.healthcheckStatus).toContain("passed");
  });

  test("command fails → rollback command runs, status=rolled_back", async () => {
    const m = mockRun([
      { ok: false, output: "boom" },   // deploy fails
      { ok: true, output: "reverted" }, // rollback runs
    ]);
    const r = await runDeploy(
      { name: "prod", kind: "shell", command: "./bad.sh", rollbackCommand: "./rollback.sh" },
      { runCommandImpl: m.impl },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe("rolled_back");
    expect(r.commandOutput).toContain("boom");
    expect(r.rollbackOutput).toContain("reverted");
    expect(m.calls).toEqual(["./bad.sh", "./rollback.sh"]);
  });

  test("command fails, no rollback configured → status=command_failed", async () => {
    const m = mockRun([{ ok: false, output: "boom" }]);
    const r = await runDeploy(
      { name: "prod", kind: "shell", command: "./bad.sh" },
      { runCommandImpl: m.impl },
    );
    expect(r.status).toBe("command_failed");
    expect(r.rollbackOutput).toBeUndefined();
  });

  test("healthcheck fails → rollback runs, status=rolled_back", async () => {
    const m = mockRun([
      { ok: true, output: "shipped" },
      { ok: true, output: "reverted" },
    ]);
    // 6 attempts × 3s interval — for the test we set the healthcheck to fail
    // immediately and pass no timers, but the real code will retry 6 times.
    // We short-circuit by making fetch throw.
    const fetchMock = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    const r = await runDeploy(
      {
        name: "prod", kind: "shell",
        command: "./deploy.sh",
        healthcheckUrl: "https://x/health",
        rollbackCommand: "./rollback.sh",
      },
      { runCommandImpl: m.impl, fetchImpl: fetchMock, healthcheckAttempts: 2, healthcheckIntervalMs: 5 },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe("rolled_back");
    expect(r.healthcheckStatus).toContain("failed");
  }, 30000);

  test("deploy command times out → status=timed_out, rollback NOT run", async () => {
    const m = mockRun([{ ok: false, output: "", timedOut: true }]);
    const r = await runDeploy(
      { name: "prod", kind: "shell", command: "./hang.sh", rollbackCommand: "./rb.sh" },
      { runCommandImpl: m.impl },
    );
    expect(r.status).toBe("timed_out");
    expect(m.calls).toEqual(["./hang.sh"]); // no rollback for timeouts — user decides
  });
});

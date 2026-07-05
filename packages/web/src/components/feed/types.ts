import type { UiEvent } from "../../lib/api.ts";

export type FeedItem =
  | { kind: "tool"; id: string; tool: string; state: "pending" | "success" | "error" }
  | { kind: "text"; id: string; text: string }
  | { kind: "complete"; id: string; status: "completed" | "failed"; executionId: string }
  | { kind: "awaiting"; id: string; executionId: string }
  | { kind: "test"; id: string; passed: boolean; exitCode: number; output: string }
  | { kind: "connected"; id: string; executionId: string };

export function processEvents(events: UiEvent[]): FeedItem[] {
  const result: FeedItem[] = [];
  const pendingStack: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;

    if (e.type === "text") {
      const last = result[result.length - 1];
      if (last?.kind === "text") {
        result[result.length - 1] = { ...last, text: last.text + e.text };
      } else {
        result.push({ kind: "text", id: `t${i}`, text: e.text });
      }
    } else if (e.type === "tool_call") {
      result.push({ kind: "tool", id: `tc${i}`, tool: e.tool, state: "pending" });
      pendingStack.push(result.length - 1);
    } else if (e.type === "tool_result") {
      if (pendingStack.length > 0) {
        const idx = pendingStack.pop()!;
        const item = result[idx] as Extract<FeedItem, { kind: "tool" }>;
        result[idx] = { ...item, state: e.isError ? "error" : "success" };
      }
    } else if (e.type === "execution_complete") {
      result.push({ kind: "complete", id: `ec${i}`, status: e.status, executionId: e.executionId });
    } else if (e.type === "awaiting_human") {
      result.push({ kind: "awaiting", id: `ah${i}`, executionId: e.executionId });
    } else if (e.type === "test_result") {
      result.push({ kind: "test", id: `tr${i}`, passed: e.passed, exitCode: e.exitCode, output: e.output });
    } else if (e.type === "connected") {
      result.push({ kind: "connected", id: `cn${i}`, executionId: e.executionId });
    }
    // idle — skip
  }

  return result;
}

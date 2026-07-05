import type { UiEvent } from "./api.ts";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";

// PRD 1.12 — Demo replay mode.
// Client-side player that fetches a fixture JSON and drives the board through
// a scripted execution. No claude CLI, no API key, no server DB writes.
// Reuses the same UiEvent shapes the real SSE endpoint emits, so the Feed
// component + TaskCard glow states light up exactly as they would in real life.

type DemoTimelineEntry =
  | { delayMs: number; action: "sse"; taskId: string; event: UiEvent }
  | { delayMs: number; action: "task_status"; taskId: string; status: TaskStatus }
  | { delayMs: number; action: "ask_human"; taskId: string; question: string; context: string; options: Array<{ label: string; value: string }> };

interface DemoFixture {
  board: { id: string; name: string };
  tasks: Array<Partial<Task> & { id: string; title: string; dependsOn: string[] }>;
  timeline: DemoTimelineEntry[];
}

type Subscriber = (e: UiEvent) => void;

class DemoPlayer {
  private subs = new Map<string, Set<Subscriber>>();
  private lastEventPerTask = new Map<string, UiEvent[]>();
  private taskStatusListeners = new Set<(taskId: string, status: TaskStatus) => void>();
  private decisionListener: ((d: DecisionPause) => void) | null = null;
  private ended = new Set<() => void>();
  private speed = 1;
  private paused = false;
  private cancelled = false;
  private pendingResume: (() => void) | null = null;

  fixture: DemoFixture | null = null;

  async load(): Promise<DemoFixture> {
    if (this.fixture) return this.fixture;
    const res = await fetch("/demo-fixture.json");
    if (!res.ok) throw new Error(`Failed to load demo fixture: ${res.status}`);
    this.fixture = await res.json() as DemoFixture;
    return this.fixture;
  }

  /**
   * PRD_OPEN_SOURCE 2.9 — replay theater. Load a recorded execution replay
   * from the server (see 2.8 recorder) and adapt it to the same fixture
   * shape the demo player already consumes. We synthesise a lightweight
   * board + a single task since the raw replay only contains UiEvents;
   * that's enough to drive the feed + Scout mood transitions.
   */
  async loadExecution(executionId: string): Promise<DemoFixture> {
    const res = await fetch(`/api/executions/${encodeURIComponent(executionId)}/replay`);
    if (!res.ok) throw new Error(`Failed to load replay ${executionId}: ${res.status}`);
    const body = await res.json() as { executionId: string; events: Array<{ ts: number; event: unknown }> };
    if (!body.events.length) throw new Error("empty replay");
    const t0 = body.events[0]!.ts;
    const timeline = body.events.map((e) => ({
      delayMs: Math.max(0, e.ts - t0),
      action: "sse" as const,
      taskId: "replay-task",
      event: e.event as UiEvent,
    }));
    // Turn the sequence of relative timestamps into inter-event deltas.
    for (let i = timeline.length - 1; i > 0; i--) {
      timeline[i]!.delayMs = Math.max(0, timeline[i]!.delayMs - timeline[i-1]!.delayMs);
    }
    this.fixture = {
      board: { id: "replay-board", name: `Replay ${executionId.slice(0, 8)}` },
      tasks: [{ id: "replay-task", title: "Recorded execution", dependsOn: [] }],
      timeline,
    };
    return this.fixture;
  }

  subscribe(taskId: string, cb: Subscriber): () => void {
    let set = this.subs.get(taskId);
    if (!set) { set = new Set(); this.subs.set(taskId, set); }
    set.add(cb);
    // Replay the events already delivered for this task so a late subscriber
    // (opening the task detail after playback started) sees the feed in progress.
    const backfill = this.lastEventPerTask.get(taskId) ?? [];
    for (const e of backfill) cb(e);
    // Signal "connected" so the useTaskExecution hook flips to running state.
    if (backfill.length === 0) cb({ type: "idle" });
    return () => { set!.delete(cb); };
  }

  onTaskStatus(cb: (taskId: string, status: TaskStatus) => void): () => void {
    this.taskStatusListeners.add(cb);
    return () => { this.taskStatusListeners.delete(cb); };
  }

  onDecision(cb: (d: DecisionPause) => void): void {
    this.decisionListener = cb;
  }

  onEnd(cb: () => void): void {
    this.ended.add(cb);
  }

  setSpeed(mult: number): void {
    this.speed = Math.max(0.25, Math.min(mult, 8));
  }

  getSpeed(): number { return this.speed; }

  resume(_answer: string): void {
    void _answer;
    this.paused = false;
    this.pendingResume?.();
    this.pendingResume = null;
  }

  cancel(): void {
    this.cancelled = true;
    this.pendingResume?.();
  }

  async play(): Promise<void> {
    const fixture = await this.load();

    for (const entry of fixture.timeline) {
      if (this.cancelled) return;
      await this.sleep(entry.delayMs / this.speed);
      if (this.cancelled) return;

      if (entry.action === "sse") {
        // Store for backfill so a late subscriber gets context.
        const bag = this.lastEventPerTask.get(entry.taskId) ?? [];
        bag.push(entry.event);
        // Keep only last 30 to avoid unbounded growth on re-runs.
        this.lastEventPerTask.set(entry.taskId, bag.slice(-30));
        const subs = this.subs.get(entry.taskId);
        subs?.forEach((cb) => { try { cb(entry.event); } catch { /* ignore */ } });
      } else if (entry.action === "task_status") {
        for (const cb of this.taskStatusListeners) {
          try { cb(entry.taskId, entry.status); } catch { /* ignore */ }
        }
      } else if (entry.action === "ask_human") {
        this.paused = true;
        // Broadcast a decision-ticket-shaped event so the Feed shows "needs you".
        const feedEvent: UiEvent = { type: "awaiting_human", executionId: "demo-decision" };
        const subs = this.subs.get(entry.taskId);
        subs?.forEach((cb) => { try { cb(feedEvent); } catch { /* ignore */ } });
        this.decisionListener?.({
          taskId: entry.taskId,
          question: entry.question,
          context: entry.context,
          options: entry.options,
        });
        await new Promise<void>((res) => { this.pendingResume = res; });
      }
    }

    for (const cb of this.ended) { try { cb(); } catch { /* ignore */ } }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

export interface DecisionPause {
  taskId: string;
  question: string;
  context: string;
  options: Array<{ label: string; value: string }>;
}

export function makeDemoPlayer(): DemoPlayer {
  return new DemoPlayer();
}

// Install the streamTaskEvents intercept on the global so the api.ts hook picks
// it up without needing a React context.
export function installDemoIntercept(player: DemoPlayer): () => void {
  const w = window as unknown as { __atDemoSubscribe?: (id: string, cb: Subscriber) => (() => void) };
  const prev = w.__atDemoSubscribe;
  w.__atDemoSubscribe = (id, cb) => player.subscribe(id, cb);
  return () => { w.__atDemoSubscribe = prev; };
}

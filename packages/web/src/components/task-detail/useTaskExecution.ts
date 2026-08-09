import { useState, useEffect, useRef } from "react";
import type { Task } from "../../../../core/src/types/index.ts";
import {
  api,
  streamTaskEvents,
  type UiEvent,
  type DecisionTicketRow,
  type ArtifactRow,
  type ExecutionRow,
} from "../../lib/api.ts";
import * as sounds from "../../lib/sounds.ts";
import { requestPermission, notify } from "../../lib/notify.ts";
import { onTaskComplete } from "../../lib/confetti.ts";
import { recordCompletion } from "../../lib/score.ts";
import { pushToast } from "../Toast.tsx";
import { useFeedPrefs } from "../feed/useFeedPrefs.ts";

/**
 * Owns everything needed to display a task's live state:
 *   - `running` flag
 *   - SSE `activity` log
 *   - `tickets` (decision tickets)
 *   - `artifacts` (diff, file list, PR)
 *   - `executions` (review-mode metrics)
 *
 * Imperative actions: `runTask()` to start a fresh execution, and
 * `resumeAfterDecision()` to re-subscribe after a human answer.
 *
 * SSE lifetime: at most one EventSource is open at any moment. `stopRef`
 * tracks whichever close() callback is current, so re-subscribing or
 * unmounting always closes the prior stream — no leaks across resumes.
 */
export function useTaskExecution(task: Task | null, onUpdated: (t: Task) => void) {
  const { prefs } = useFeedPrefs();
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState<UiEvent[]>([]);
  const [tickets, setTickets] = useState<DecisionTicketRow[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(() => void) | null>(null);

  function subscribe(t: Task): void {
    // Close any prior stream before opening a new one.
    stopRef.current?.();
    stopRef.current = streamTaskEvents(t.id, (e) => {
      setActivity((a) => [...a, e]);

      if (e.type === "tool_call") sounds.click();
      if (e.type === "awaiting_human") {
        sounds.ask();
        notify({ title: "inventarium — human decision needed", body: t.title, tag: `ask-${t.id}`, requireInteraction: true });
      }
      if (e.type === "execution_complete") {
        sounds.complete(e.status === "completed");
        notify({ title: e.status === "completed" ? `✓ ${t.title}` : `✗ ${t.title}`, tag: `done-${t.id}` });
        if (e.status === "completed") {
          onTaskComplete(prefs.confetti);
          const result = recordCompletion();
          // Milestone toasts
          if (result.milestone) {
            const flames = result.milestone >= 50 ? "🔥🔥🔥" : result.milestone >= 25 ? "🔥🔥" : "🔥";
            pushToast({ emoji: flames, title: `${result.milestone} tasks done`, sub: `${result.streak}-day streak · keep it up` });
          } else if (result.isFirstToday) {
            pushToast({ emoji: "⚡", title: "first task today!", sub: `${result.streak > 1 ? result.streak + "-day streak · " : ""}let's ship` });
          }
        }
      }

      if (e.type !== "execution_complete" && e.type !== "awaiting_human") return;

      setRunning(false);
      stopRef.current?.();
      stopRef.current = null;

      api.tasks.list(t.boardId).then((tasks) => {
        const updated = tasks.find((x) => x.id === t.id);
        if (updated) onUpdated(updated);
      }).catch(() => undefined);

      if (e.type === "awaiting_human") {
        api.tasks.decisions(t.id).then(setTickets).catch(() => undefined);
      }
      if (e.type === "execution_complete") {
        api.artifacts.list(t.id).then(setArtifacts).catch(() => undefined);
      }
    });
  }

  // ── Effect 1: full reset whenever a different task is selected.
  //   Clears activity, refetches tickets/artifacts/executions for the new task,
  //   and subscribes to SSE if the task is in_progress.
  useEffect(() => {
    if (!task) return;
    setActivity([]);
    setRunning(task.status === "in_progress");

    if (task.status === "blocked") {
      api.tasks.decisions(task.id).then(setTickets).catch(() => undefined);
    } else {
      setTickets([]);
    }
    api.artifacts.list(task.id).then(setArtifacts).catch(() => undefined);
    if (task.status === "in_review" || task.status === "done") {
      api.executions.list(task.id).then(setExecutions).catch(() => undefined);
    } else {
      setExecutions([]);
    }

    if (task.status === "in_progress") {
      subscribe(task);
    }
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
    // Only depend on task.id — status changes are handled by Effect 2 below
    // so we don't blow away the activity log when a run completes.
  }, [task?.id]);

  // ── Effect 2: react to task.status transitions on the SAME task.
  //   When polling (or another source) reports the task left in_progress,
  //   close the stream and drop running-mode without clearing the activity
  //   log the user is reading.
  useEffect(() => {
    if (!task) return;
    if (task.status === "in_progress") {
      // Re-subscribe if we're now in_progress and haven't already.
      if (!stopRef.current) subscribe(task);
      setRunning(true);
      return;
    }
    // Task moved to a terminal-ish state (in_review, done, blocked, ready)
    // — close any open SSE stream and reflect it in the UI.
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
    // Refetch ancillary data appropriate for the new status.
    if (task.status === "blocked") {
      api.tasks.decisions(task.id).then(setTickets).catch(() => undefined);
    }
    if (task.status === "in_review" || task.status === "done") {
      api.executions.list(task.id).then(setExecutions).catch(() => undefined);
      api.artifacts.list(task.id).then(setArtifacts).catch(() => undefined);
    }
  }, [task?.status]);

  // Keep the activity log scrolled to the bottom on every new event.
  useEffect(() => {
    if (activityRef.current) activityRef.current.scrollTop = activityRef.current.scrollHeight;
  }, [activity]);

  async function runTask() {
    if (!task || running) return;
    sounds.prime();
    requestPermission();
    setRunning(true);
    setActivity([]);
    try {
      await api.tasks.execute(task.id);
      subscribe(task);
    } catch {
      setRunning(false);
      setActivity([{ type: "execution_complete", status: "failed", executionId: "" }]);
    }
  }

  async function stopTask() {
    if (!task) return;
    try {
      await api.tasks.stop(task.id);
      // The SSE stream will emit execution_complete shortly; Effect 2 then
      // clears `running` once the task row reflects the new (terminal) status.
      // No optimistic UI flip here so the spinner stays visible until the
      // child actually exits.
    } catch {
      // Surface the failure but don't unstick the spinner — the server is the
      // source of truth and Effect 2 will reconcile when the task row updates.
    }
  }

  function resumeAfterDecision(ticketId: string, answer: string) {
    if (!task) return;
    setTickets((ts) =>
      ts.map((x) => (x.id === ticketId ? { ...x, answer, answered_at: new Date().toISOString() } : x)),
    );
    setRunning(true);
    setActivity([]);
    subscribe(task);
  }

  return {
    running,
    activity,
    tickets,
    artifacts,
    executions,
    activityRef,
    runTask,
    stopTask,
    resumeAfterDecision,
  };
}

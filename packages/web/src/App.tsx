import { useState, useEffect, useCallback } from "react";
import { Wand2, Play, Flame, Zap, Sparkles } from "lucide-react";
import type { Board, Task, TaskStatus } from "../../core/src/types/index.ts";
import { api } from "./lib/api.ts";
import { Board as KanbanBoard } from "./components/Board.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { EpicView } from "./components/EpicView.tsx";
import { DashboardView } from "./components/DashboardView.tsx";
import { PlanModal } from "./components/PlanModal.tsx";
import { EmptyBoardState } from "./components/EmptyBoardState.tsx";
import { IdeaWizard } from "./components/IdeaWizard.tsx";
import { DagView } from "./components/DagView.tsx";
import { BoardSettings } from "./components/BoardSettings.tsx";
import { DevServerPill } from "./components/DevServerPill.tsx";
import { PlanReviewBanner } from "./components/PlanReviewBanner.tsx";
import { SettingsPopover } from "./components/SettingsPopover.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { useTabTitle } from "./lib/useTabTitle.ts";
import { getScore, type Score } from "./lib/score.ts";
import { initKonami } from "./lib/konami.ts";
import { makeDemoPlayer, installDemoIntercept, type DecisionPause } from "./lib/demo.ts";
import { DemoOverlay } from "./components/DemoOverlay.tsx";
import { CostOdometer } from "./components/CostOdometer.tsx";
import { Scout, type ScoutBeat } from "./components/Scout.tsx";
import { useScoutQuips } from "./lib/useScoutQuips.ts";

type View = "board" | "dag" | "epics" | "dashboard";
type LaunchState = "idle" | "launching" | "running";

export function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [view, setView] = useState<View>("board");
  const [newBoardName, setNewBoardName] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showIdeaWizard, setShowIdeaWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [boardRunning, setBoardRunning] = useState(false);
  const [runStats, setRunStats] = useState<{ activeCount: number; queuedCount: number; maxConcurrent: number } | null>(null);
  const [launchState, setLaunchState] = useState<LaunchState>("idle");
  const [score, setScore] = useState<Score>({ today: 0, streak: 0, total: 0 });
  const [scorePop, setScorePop] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [demoDecision, setDemoDecision] = useState<DecisionPause | null>(null);
  const [demoDone, setDemoDone] = useState(false);
  const [demoPlayer] = useState(() => makeDemoPlayer());

  // Init Konami code + load initial score
  useEffect(() => {
    initKonami();
    setScore(getScore());
  }, []);

  // Demo mode: kick off replay when ?demo=1 is in the URL. Installs the SSE
  // intercept, materialises the fixture's board + tasks in local state, and
  // starts the timeline. PRD 1.12.
  useEffect(() => {
    const url = new URL(window.location.href);
    const isDemo = url.searchParams.get("demo") === "1";
    const replayId = url.searchParams.get("replay"); // PRD 2.9
    if (!isDemo && !replayId) return;
    let cleanup = () => {};
    let cancelled = false;

    (async () => {
      const fixture = replayId
        ? await demoPlayer.loadExecution(replayId)
        : await demoPlayer.load();
      if (cancelled) return;
      cleanup = installDemoIntercept(demoPlayer);
      setDemoActive(true);
      const demoBoard: Board = {
        id: fixture.board.id,
        name: fixture.board.name,
        prdSource: null,
        webhookUrl: null,
        defaultModel: null,
        defaultAssignee: "claude-code",
        defaultReviewKind: "none",
        permissionMode: "acceptEdits",
        implementationDir: null,
        devCommand: null,
        devPort: null,
        executionTimeoutMs: 1_200_000,
        executionCostCapUsd: 0,
        executionTokenCap: 0,
        autoCommit: false,
        autoPr: false,
        commitStyle: "conventional",
        // §C — demo board is pre-approved so ?demo=1 doesn't gate on human
        // review. Real planner-created boards land with approvedAt=null (see
        // the other constructor below).
        approvedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setBoards((bs) => bs.some((b) => b.id === demoBoard.id) ? bs : [demoBoard, ...bs]);
      setActiveBoardId(demoBoard.id);
      const initial: Task[] = fixture.tasks.map((t, i) => ({
        id: t.id,
        boardId: fixture.board.id,
        title: t.title,
        description: t.description ?? "",
        status: "backlog",
        priority: t.priority ?? "medium",
        assignee: "claude-code",
        tddEnabled: t.tddEnabled ?? true,
        tddPhase: "write_tests",
        mcps: [], skills: [], subagents: [],
        dependsOn: t.dependsOn ?? [],
        parallelGroup: t.dependsOn && t.dependsOn.length ? `pg-${i}` : "pg-root",
        activeForm: null,
        worktreePath: null,
        lastError: null,
        successCriteria: [],
        guardrails: [],
        epic: t.epic ?? null,
        sprint: null,
        reviewKind: "none",
        reviewer: null,
        additionalPrompt: null,
        model: null,
        modelTier: t.modelTier ?? null,
        component: null,
        externalDependencies: [],
        testCases: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      setTasks(initial);

      demoPlayer.onTaskStatus((taskId, status) => {
        setTasks((ts) => ts.map((t) => t.id === taskId ? { ...t, status, updatedAt: new Date().toISOString() } : t));
      });
      demoPlayer.onDecision((d) => setDemoDecision(d));
      demoPlayer.onEnd(() => setDemoDone(true));

      demoPlayer.play().catch((err) => console.error("[demo]", err));
    })().catch((err) => console.error("[demo]", err));

    return () => { cancelled = true; demoPlayer.cancel(); cleanup(); };
  }, [demoPlayer]);

  // Refresh score when a task completes (poll on interval, cheap)
  useEffect(() => {
    const id = setInterval(() => {
      const s = getScore();
      setScore((prev) => {
        if (s.today !== prev.today) {
          setScorePop(true);
          setTimeout(() => setScorePop(false), 400);
        }
        return s;
      });
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Load boards on mount
  useEffect(() => {
    api.boards.list().then((bs) => {
      setBoards(bs);
      if (bs.length > 0 && !activeBoardId) setActiveBoardId(bs[0]!.id);
    });
  }, []);

  // Load tasks when active board changes
  useEffect(() => {
    if (!activeBoardId) return;
    setLoadingTasks(true);
    api.tasks
      .list(activeBoardId)
      .then(setTasks)
      .finally(() => setLoadingTasks(false));
  }, [activeBoardId]);

  // Poll task list + run stats whenever a board is open. This catches both
  // "Run all" runs AND manually-started tasks that queued up behind active ones.
  useEffect(() => {
    if (!activeBoardId) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const [updated, stats] = await Promise.all([
        api.tasks.list(activeBoardId).catch(() => null),
        api.boards.isRunning(activeBoardId).catch(() => null),
      ]);
      if (cancelled) return;
      if (updated) {
        setTasks(updated);
        // If a task is open in the detail modal, keep its data in sync with
        // the polled list. Without this, the modal shows stale state
        // (e.g. "IN PROGRESS · working…") while the kanban already shows the
        // task as Done — because the modal's local `selectedTask` never
        // refreshed and the SSE may have missed the terminal event.
        setSelectedTask((current) => {
          if (!current) return current;
          const fresh = updated.find((t) => t.id === current.id);
          if (!fresh) return current; // task deleted; let the modal close itself if needed
          // Cheap dirty-check; avoids a re-render storm when nothing changed.
          if (fresh.updatedAt === current.updatedAt && fresh.status === current.status && fresh.lastError === current.lastError) {
            return current;
          }
          return fresh;
        });
      }
      if (stats) {
        setRunStats({
          activeCount: stats.activeCount,
          queuedCount: stats.queuedCount,
          maxConcurrent: stats.maxConcurrent,
        });
        if (boardRunning && !stats.running && stats.queuedCount === 0 && stats.activeCount === 0) {
          setBoardRunning(false);
          setLaunchState("idle");
        }
      }
    };
    // Idle: 5s; busy: 2s. Avoids hammering the server when nothing is happening.
    const intervalMs = boardRunning || (runStats && (runStats.activeCount > 0 || runStats.queuedCount > 0))
      ? 2_000
      : 5_000;
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeBoardId, boardRunning, runStats?.activeCount, runStats?.queuedCount]);

  const runBoard = useCallback(async () => {
    if (!activeBoardId || boardRunning || launchState !== "idle") return;
    setLaunchState("launching");
    setTimeout(async () => {
      setLaunchState("running");
      setBoardRunning(true);
      try {
        await api.boards.run(activeBoardId);
      } catch {
        setBoardRunning(false);
        setLaunchState("idle");
      }
    }, 900);
  }, [activeBoardId, boardRunning, launchState]);

  const createBoard = useCallback(async () => {
    const name = newBoardName.trim();
    if (!name) return;
    setCreatingBoard(true);
    try {
      const board = await api.boards.create(name);
      setBoards((bs) => [board, ...bs]);
      setActiveBoardId(board.id);
      setTasks([]);
      setNewBoardName("");
    } finally {
      setCreatingBoard(false);
    }
  }, [newBoardName]);

  const handleStatusChange = useCallback(async (taskId: string, status: TaskStatus) => {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
    await api.tasks.update(taskId, { status });
  }, []);

  const handleAddTask = useCallback(
    async (status: TaskStatus, title: string) => {
      if (!activeBoardId) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      const task = await api.tasks.create(activeBoardId, { title: trimmed, status });
      setTasks((ts) => [...ts, task]);
    },
    [activeBoardId],
  );

  const handleTaskUpdated = useCallback((updated: Task) => {
    setTasks((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    setSelectedTask(updated);
  }, []);

  const handleTaskDeleted = useCallback((taskId: string) => {
    setTasks((ts) => ts.filter((t) => t.id !== taskId));
    setSelectedTask(null);
  }, []);

  const activeBoard = boards.find((b) => b.id === activeBoardId);

  // Scout narration beat — picked from real board state (or demo state when
  // demo mode is active). Kept purely derived so there's no separate cadence
  // to keep in sync. PRD 1.16.
  const scoutBeat: ScoutBeat = (() => {
    if (demoActive) {
      if (demoDone) return "credits";
      if (demoDecision) return "decision";
      return "running";
    }
    if (!activeBoardId) return "empty_board";
    if (tasks.some((t) => t.status === "blocked" && t.activeForm))                  return "needs_you";
    // Error takes precedence over other states — a red task should be visible.
    if (tasks.some((t) => t.status === "blocked" && t.lastError))                   return "task_error";
    if (tasks.some((t) => t.status === "in_progress"))                              return "working";
    if (tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "in_review")) return "celebrating";
    return "idle";
  })();

  // 2.10 — Scout quip engine (event-driven) + click-to-see state.
  const { quip, tone, setTone } = useScoutQuips(tasks);
  const [scoutStatusOpen, setScoutStatusOpen] = useState(false);

  const handlePlanResult = useCallback((result: { board: { id: string; name: string } | null; tasks: Task[] }) => {
    if (result.board) {
      const newBoard: Board = {
        id: result.board.id,
        name: result.board.name,
        prdSource: null,
        webhookUrl: null,
        defaultModel: null,
        defaultAssignee: "claude-code",
        defaultReviewKind: "none",
        permissionMode: "acceptEdits",
        implementationDir: null,
        devCommand: null,
        devPort: null,
        executionTimeoutMs: 1_200_000,
        executionCostCapUsd: 0,
        executionTokenCap: 0,
        autoCommit: false,
        autoPr: false,
        commitStyle: "conventional",
        // §C — actual value comes from the server on the next boards.list()
        // refresh; the initial guess picks the safer "pending" state so the
        // review banner appears immediately after a plan.
        approvedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setBoards((bs) => [newBoard, ...bs]);
      setActiveBoardId(result.board.id);
      setTasks(result.tasks);
    } else {
      setTasks((ts) => [...ts, ...result.tasks]);
    }
  }, []);

  // Awaiting-human count: tasks where the board has an unanswered decision ticket.
  // We approximate it by looking for tasks in "blocked" status with no resolved
  // decisions. The real count requires a server call; for now use 0 unless the
  // board polling reveals it indirectly through task status.
  const awaitingHumanCount = tasks.filter((t) => t.status === "blocked" && t.activeForm !== null).length;
  useTabTitle({ running: runStats?.activeCount ?? 0, awaitingHuman: awaitingHumanCount });

  return (
    <ToastProvider>
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      {/* CLAW titlebar */}
      <header
        className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-pane)" }}
      >
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="traffic-light red" />
          <div className="traffic-light amber" />
          <div className="traffic-light green" />
        </div>

        <div className="w-px h-3 shrink-0" style={{ background: "var(--line)" }} />

        {/* Brand */}
        <span className="text-[11px] font-medium shrink-0" style={{ color: "var(--fg-dim)", letterSpacing: "0.04em" }}>
          [agent-trail]
        </span>

        {/* Score chip */}
        {(score.today > 0 || score.streak > 1) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {score.today > 0 && (
              <span
                className={`claw-chip green${scorePop ? " score-pop" : ""}`}
                style={{ gap: 4, transition: "all 0.2s" }}
              >
                <Zap size={8} />
                {score.today} today
              </span>
            )}
            {score.streak > 1 && (
              <span className="claw-chip amber" style={{ gap: 4 }}>
                <Flame size={8} />
                {score.streak}d
              </span>
            )}
          </div>
        )}

        <div className="w-px h-3 shrink-0" style={{ background: "var(--line)" }} />

        {/* Board selector + controls */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <select
            className="text-[11px] px-2 py-1 rounded focus:outline-none"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--line)", color: "var(--fg-dim)", fontFamily: "inherit", maxWidth: 180 }}
            value={activeBoardId ?? ""}
            onChange={(e) => setActiveBoardId(e.target.value || null)}
          >
            {boards.length === 0 && <option value="">no boards</option>}
            {boards.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>

          <input
            placeholder="new board…"
            value={newBoardName}
            onChange={(e) => setNewBoardName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createBoard()}
            className="text-[11px] px-2 py-1 rounded focus:outline-none w-32"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--line)", color: "var(--fg)", fontFamily: "inherit" }}
          />
          <button
            onClick={createBoard}
            disabled={creatingBoard || !newBoardName.trim()}
            className="claw-btn"
            style={{ fontSize: 10, padding: "3px 10px" }}
          >
            create
          </button>

          <div className="w-px h-3 shrink-0" style={{ background: "var(--line)" }} />

          <button
            onClick={() => setShowIdeaWizard(true)}
            className="claw-btn primary"
            style={{ fontSize: 10, padding: "3px 10px", display: "flex", alignItems: "center", gap: 4 }}
          >
            <Sparkles size={10} /> idea
          </button>

          <button
            onClick={() => setShowPlanModal(true)}
            className="claw-btn"
            style={{ fontSize: 10, padding: "3px 10px", display: "flex", alignItems: "center", gap: 4 }}
          >
            <Wand2 size={10} /> plan
          </button>

          {activeBoardId && <CostOdometer boardId={activeBoardId} />}

          {activeBoardId && (
            <>
              <button
                onClick={runBoard}
                disabled={launchState !== "idle"}
                className={`claw-btn${launchState === "idle" ? " primary" : ""}${launchState === "launching" ? " launch-pulse" : ""}`}
                style={{ fontSize: 10, padding: "3px 10px", display: "flex", alignItems: "center", gap: 4, minWidth: 80, justifyContent: "center", transition: "all 0.2s" }}
              >
                {launchState === "idle" && <><Play size={10} /> run all</>}
                {launchState === "launching" && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full col-active-dot" style={{ background: "var(--green)", flexShrink: 0 }} />
                    launching…
                  </>
                )}
                {launchState === "running" && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full col-active-dot" style={{ background: "var(--green)", flexShrink: 0 }} />
                    running…
                  </>
                )}
              </button>

              {runStats && (runStats.activeCount > 0 || runStats.queuedCount > 0) && (
                <span className="claw-chip amber" style={{ gap: 5 }}>
                  <span className="w-1 h-1 rounded-full col-active-dot" style={{ background: "var(--amber)", flexShrink: 0 }} />
                  {runStats.activeCount}/{runStats.maxConcurrent} active
                  {runStats.queuedCount > 0 && (
                    <span style={{ opacity: 0.6 }}>· {runStats.queuedCount} queued</span>
                  )}
                </span>
              )}
            </>
          )}

          {activeBoard && (
            <DevServerPill
              board={activeBoard}
              onBoardUpdated={(updated) =>
                setBoards((bs) => bs.map((b) => (b.id === updated.id ? updated : b)))
              }
            />
          )}
          {activeBoard && (
            <BoardSettings
              board={activeBoard}
              onUpdated={(updated) =>
                setBoards((bs) => bs.map((b) => (b.id === updated.id ? updated : b)))
              }
            />
          )}
        </div>

        {/* Right side: settings + view tabs */}
        <div className="flex items-center gap-2 shrink-0">
          <SettingsPopover />

          {/* Tab-bar view switcher */}
          <div className="flex items-center" style={{ borderBottom: "none" }}>
            {([
              ["board", "board"],
              ["dag", "dag"],
              ["epics", "epics"],
              ["dashboard", "dash"],
            ] as [View, string][]).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="text-[10px] px-3 py-1 transition-all"
                style={{
                  fontFamily: "inherit",
                  color: view === v ? "var(--fg)" : "var(--fg-faded)",
                  borderBottom: `1px solid ${view === v ? "var(--green)" : "transparent"}`,
                  letterSpacing: "0.04em",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-hidden p-4">
        {activeBoard && !activeBoard.approvedAt && (
          <PlanReviewBanner
            board={activeBoard}
            tasks={tasks}
            onApproved={(b) =>
              setBoards((bs) => bs.map((x) => (x.id === b.id ? { ...x, approvedAt: b.approvedAt } : x)))
            }
          />
        )}
        {!activeBoardId ? (
          <EmptyBoardState
            onPlanned={handlePlanResult}
            onOpenPlan={() => setShowPlanModal(true)}
          />
        ) : loadingTasks ? (
          <div className="flex items-center justify-center h-full text-[11px]" style={{ color: "var(--fg-faded)" }}>
            loading…
          </div>
        ) : view === "board" ? (
          <KanbanBoard
            tasks={tasks}
            onTaskClick={setSelectedTask}
            onStatusChange={handleStatusChange}
            onAddTask={handleAddTask}
          />
        ) : view === "dag" ? (
          <DagView tasks={tasks} onTaskClick={setSelectedTask} />
        ) : view === "epics" ? (
          <EpicView
            tasks={tasks}
            boardId={activeBoardId}
            onTaskClick={setSelectedTask}
            onRunning={() => setBoardRunning(true)}
          />
        ) : (
          <DashboardView boardId={activeBoardId} />
        )}
      </main>

      {/* Task detail panel */}
      <TaskDetail
        task={selectedTask}
        boardTasks={tasks}
        onClose={() => setSelectedTask(null)}
        onUpdated={handleTaskUpdated}
        onDeleted={handleTaskDeleted}
      />

      {/* Command palette (Cmd+K) */}
      <CommandPalette
        tasks={tasks}
        boards={boards}
        currentView={view}
        onViewChange={setView}
        onRunTask={(taskId) => {
          const t = tasks.find((x) => x.id === taskId);
          if (t) setSelectedTask(t);
        }}
        onOpenTask={setSelectedTask}
        onNewTask={() => {
          if (activeBoardId) handleAddTask("backlog", "New task");
        }}
        onNewBoard={() => setNewBoardName("New board")}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Plan from PRD modal */}
      {showPlanModal && (
        <PlanModal
          boards={boards}
          activeBoardId={activeBoardId}
          onClose={() => setShowPlanModal(false)}
          onDone={(result) => {
            setShowPlanModal(false);
            handlePlanResult(result);
          }}
        />
      )}

      {/* Idea → PRD wizard modal (reachable from header once a board exists) */}
      {showIdeaWizard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.75)" }}
            onClick={() => setShowIdeaWizard(false)}
          />
          <div
            className="relative flex flex-col overflow-hidden"
            style={{
              width: 720,
              maxWidth: "94vw",
              maxHeight: "90vh",
              background: "var(--bg-pane)",
              border: "1px solid var(--line)",
              borderRadius: 4,
            }}
          >
            <div className="overflow-y-auto flex-1 min-h-0">
              <IdeaWizard
                onCancel={() => setShowIdeaWizard(false)}
                onPlanned={(result) => {
                  setShowIdeaWizard(false);
                  handlePlanResult(result);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Scout mascot — always visible (dismissable per-browser via localStorage).
          PRD 1.16 stretch: beat is derived from real board state, or demo state
          when the replay is running. PRD 2.10 stretch: quip overrides the
          default beat line when an event fires; clicking Scout opens a
          state-display card rendered from live task state. */}
      <Scout
        beat={scoutBeat}
        quip={quip}
        tone={tone}
        onToneChange={setTone}
        statusOpen={scoutStatusOpen}
        onToggleStatus={() => setScoutStatusOpen((v) => !v)}
        tasks={tasks}
        runStats={runStats}
      />

      {demoActive && (
        <DemoOverlay
          decision={demoDecision}
          done={demoDone}
          player={demoPlayer}
          onDecisionAnswered={(answer) => {
            setDemoDecision(null);
            demoPlayer.resume(answer);
          }}
        />
      )}
    </div>
    </ToastProvider>
  );
}

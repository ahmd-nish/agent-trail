// knowledgelayer §4.4 — the three-band prompt (four, counting governance).
//
// ┌─ BAND A — org prefix ────────── changes ~weekly ── stable across PROJECTS
// │  agent-trail operating instructions · org-scope rulings
// ├─ BAND B — project prefix ────── changes ~daily ─── stable across TASKS
// │  project constitution · PROJECT_MAP · module brief for the task's dir
// ├─ BAND C — task pack ─────────── per spawn ──────── varies every time
// │  phase discipline · task self · retrieved facts · handoffs · steers
// └─ BAND D — governance ────────── per spawn ──────── varies every time
//    precheck warnings for the files this task will touch
//
// ── What this can and cannot do, honestly ───────────────────────────────────
//
// agent-trail hands its prompt to the `claude` CLI via --append-system-prompt.
// It therefore CANNOT emit `cache_control` breakpoints itself — the CLI owns
// those. What it can control is the thing that makes any prefix cache possible
// in the first place: putting all STABLE content before all VARYING content,
// and keeping the stable part byte-identical across spawns.
//
// That is not a consolation prize, it is the actual bug. The previous assembly
// put per-task phase instructions at position 2, ahead of the project
// constitution — so the common prefix between two spawns ended after one line
// and nothing downstream of it could ever be reused, no matter who set the
// breakpoints.
//
// The property this module exists to guarantee is testable, and it is tested:
// two different tasks in the same project must produce a byte-identical A+B
// prefix. `stablePrefixHash()` is how a test (or a human) checks that.

import { createHash } from "node:crypto";

export interface PromptBands {
  /** A — stable across every project in the org. */
  org: string;
  /** B — stable across every task in this project. */
  project: string;
  /** C — this spawn only. */
  task: string;
  /** D — this spawn only. Kept last so a warning is the final thing read. */
  governance: string;
}

export const EMPTY_BANDS: PromptBands = { org: "", project: "", task: "", governance: "" };

/**
 * The stable prefix — bands A+B, exactly as they appear in the final prompt.
 *
 * Anything that varies per spawn must be absent from this string, or the
 * cacheable prefix collapses to whatever came before the first difference.
 */
export function stablePrefix(bands: PromptBands): string {
  return [bands.org.trim(), bands.project.trim()].filter(Boolean).join("\n\n");
}

/** Fingerprint of the stable prefix. Equal hashes across two spawns is the
 *  property that makes prefix caching possible; unequal means it is not. */
export function stablePrefixHash(bands: PromptBands): string {
  return createHash("sha256").update(stablePrefix(bands)).digest("hex");
}

/**
 * Assemble in band order. The ordering IS the feature — do not interleave.
 *
 * Empty bands vanish entirely rather than leaving a header behind: an empty
 * section still costs tokens and still differs between spawns if one task has
 * governance warnings and another does not.
 */
export function assemblePrompt(bands: PromptBands): string {
  return [
    bands.org.trim(),
    bands.project.trim(),
    bands.task.trim(),
    bands.governance.trim(),
  ].filter(Boolean).join("\n\n");
}

/** Per-band character counts — for the cost dashboard and for spotting a band
 *  that has quietly stopped being stable. */
export function bandSizes(bands: PromptBands): Record<keyof PromptBands | "stable" | "total", number> {
  const org = bands.org.trim().length;
  const project = bands.project.trim().length;
  const task = bands.task.trim().length;
  const governance = bands.governance.trim().length;
  return {
    org, project, task, governance,
    stable: stablePrefix(bands).length,
    total: assemblePrompt(bands).length,
  };
}

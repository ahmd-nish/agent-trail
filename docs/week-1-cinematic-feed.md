# Week 1 — Cinematic activity feed

**Days:** D3–D9
**Goal:** Watching an agent run feels like watching a movie. Not reading logs.
**Wow moment:** A first-time user runs a task, walks away, comes back to a soft ding + favicon badge + a task card with a beautiful animated log they'd post on Twitter.

This week is the **wedge**. Everything else in the 30-day plan compounds off this. If the activity feed isn't delightful, no amount of agent library or project knowledge saves the launch.

---

## Strategic context

The CLI agent user's current alternative is: `tmux` + their terminal + a `TODO.md`. That stack is free and zero-friction. Your board has to feel obviously, immediately more pleasant or it's just overhead.

What makes a tool *fun* (not just useful):
- **Liveness** — things move on their own, the screen breathes
- **Anticipation** — when an agent is "thinking", you can feel it
- **Reward** — completion triggers a small, satisfying moment
- **Surprise** — small details you don't expect but smile at
- **Sharability** — what you see, you want to show others

Implement against those five axes, not against a feature checklist.

---

## Deliverables

| # | Deliverable | Effort | Wow factor |
|---|------------|--------|-----------|
| 1 | Activity feed rewrite (typewriter + animated cards + color) | 2 days | ★★★★★ |
| 2 | Sound system + Settings popover | 1 day | ★★★★ |
| 3 | Browser notifications + favicon badge + tab title pulse | 0.5 day | ★★★★ |
| 4 | Command palette (Cmd+K) | 1 day | ★★★ |
| 5 | Confetti on first-of-day task completion | 0.25 day | ★★★ |
| 6 | Hotkeys + keyboard nav across the board | 0.5 day | ★★★ |
| 7 | Polish pass + accessibility check | 0.75 day | n/a |

Total: ~6 days. Buffer day for unknowns.

---

## D3 — Activity feed scaffolding

### Goal
Rewrite the activity feed to use a typed event stream + animated card components instead of the current `<ActivityLine>` per event.

### Files

**Create `packages/web/src/components/feed/`**:
- `Feed.tsx` — top-level component that takes `events: UiEvent[]` and renders a virtualized list
- `EventCard.tsx` — discriminated-union card renderer (tool_call / text / tool_result / awaiting_human / execution_complete)
- `TypewriterText.tsx` — reusable text that types at configurable cps; pause/resume on hover; finishes instantly if user scrolls past
- `ToolCallCard.tsx` — animated card with three states: pending (shimmer) → success (green tick) → error (red mark)
- `colors.ts` — tool family → color mapping
- `useFeedPrefs.ts` — hook that reads animation/sound prefs from localStorage

### Color palette (per tool family)
- File ops (Read/Write/Edit/Glob/Grep): `bg-sky-900/40 border-sky-700/50`
- Shell (Bash): `bg-amber-900/40 border-amber-700/50`
- MCP tools (mcp__*): `bg-purple-900/40 border-purple-700/50`
- ask_human: `bg-pink-900/40 border-pink-700/50` + extra glow
- Web (WebFetch/WebSearch): `bg-emerald-900/40 border-emerald-700/50`
- Task/Agent delegation: `bg-indigo-900/40 border-indigo-700/50`

### Animation guidelines
- All entry animations: 200ms ease-out, fade + 4px slide-up
- Tool call shimmer: 1.2s linear infinite, opacity sweep
- Typewriter speed: 35 chars/sec default, settable 0–100
- Honor `prefers-reduced-motion` — skip all animations if set

### Acceptance
- Switching between two tasks doesn't lose feed state
- Scrolling stays smooth at 60fps with 500+ events
- Toggling typewriter off in prefs means new events render instantly

---

## D4 — Tool call rendering + typewriter polish

### Goal
The animated tool-call card is the single most visible UI element. Make it perfect.

### Details
- **Pending state:** shimmer + "claude is using `Bash`…" with subtle pulsing dot
- **Success state:** green tick fades in over 300ms, card border transitions from animated to static
- **Error state:** red ✕, card shakes once (60ms × 3 oscillation)
- **Tool input preview:** show first 60 chars of input on the card, expandable to full on click
- **Tool result preview:** show first 200 chars of stdout, expandable
- **Long-running tools** (>3s): show a count-up timer in the corner of the card

### Typewriter behavior
- New `text` events stream char-by-char
- If the user is scrolled to the bottom, auto-follow
- If they've scrolled up, don't yank — show a floating "↓ jump to latest" pill
- Click pill → smooth-scroll + resume auto-follow
- Pressing Cmd+End anywhere → same as clicking the pill

### Acceptance
- A 2000-char text block streams to completion in ~57s at default speed
- User can scroll-up mid-stream without the view fighting them
- "Jump to latest" pill appears when scrolled away, disappears when at bottom

---

## D5 — Sound system + Settings popover

### Goal
Three subtle Web Audio sounds, all toggleable, off-by-default for tool clicks but on for completion and ask_human.

### Files
**Create `packages/web/src/lib/sounds.ts`:**
- Uses raw Web Audio API — no audio file dependencies, no extra bundle weight
- Synthesized tones:
  - `click()` — 0.04s pluck, 1200Hz, very low volume (-30dB)
  - `complete(success: boolean)` — major arpeggio for success (C-E-G, 80ms each), minor for fail (C-Eb-G, descending)
  - `ask()` — warm 2-note chime (G then C, 200ms each, sine wave, lowpass filtered)
- `setVolume(0..1)` master gain
- `setEnabled({ tickOnTool, ding, ask })` granular controls
- Respects `prefers-reduced-motion` (motion-reduced users often also want reduced audio — treat as a heuristic, but still allow override)

**Wire into `useTaskExecution.ts`:**
- On `tool_call` event: `sounds.click()` if enabled
- On `execution_complete`: `sounds.complete(status === "completed")`
- On `awaiting_human`: `sounds.ask()`

**Create `packages/web/src/components/SettingsPopover.tsx`:**
- Triggered by a gear icon in the header
- Toggles for: tool tick (default off), completion ding (on), ask_human chime (on), typewriter animation (on), confetti (on)
- Master volume slider
- Persisted to localStorage under key `agent-trail.prefs`

### Acceptance
- All sounds play on user gesture without console warnings (Web Audio context starts on first click)
- Settings persist across page reload
- Disabling sounds is instant — no audio plays on the very next event

---

## D6 — Browser notifications + favicon badge + tab title

### Goal
The user can leave the tab and still know when something needs them.

### Notifications
**Create `packages/web/src/lib/notify.ts`:**
- `requestPermission()` — called on first task run (not on page load — avoid annoying first-visit prompt)
- `notify({ title, body, tag, requireInteraction })`
- Skip if `document.visibilityState === "visible"` (don't notify if user is already looking)
- Two fire points:
  - `awaiting_human` → notification with `requireInteraction: true` (sticks until clicked)
  - `execution_complete` → auto-dismissing 5s notification

### Favicon badge
**Create `packages/web/src/lib/favicon.ts`:**
- `setBadge(count: number, color?: string)` — renders a number onto the existing favicon via canvas
- `setRunningSpinner()` — animated spinner overlay for "something is running"
- `clear()` — restore original
- Called from `useTaskExecution` based on running task count + awaiting_human count

### Tab title
- When ≥1 task awaiting human: `(N) ⚠ agent-trail`
- When ≥1 task running: `(N) agent-trail`
- Otherwise: `agent-trail`
- Pulse: toggle between two title strings every 1.5s when awaiting_human (subtle visual flicker in the tab bar)

### Acceptance
- Open the tool, switch to another tab, run a task that triggers `ask_human` → notification fires, favicon shows badge, tab title pulses
- Switch back → notification clears (or stays for `awaiting_human`)
- Permission prompt only appears once, on first run

---

## D7 — Command palette (Cmd+K)

### Goal
Linear-style command palette. Keyboard-first users live here.

### Files
**Create `packages/web/src/components/CommandPalette.tsx`:**
- Triggered by `cmd+k` / `ctrl+k` (global handler)
- Fuzzy search over commands + tasks
- Commands:
  - "New task on Backlog" / "...on Ready" / etc.
  - "Run task: <fuzzy task name>"
  - "Stop task: <fuzzy running task>"
  - "Open board: <fuzzy board name>"
  - "New board"
  - "Open settings"
  - "Toggle sound"
  - "Switch view → Kanban / Epics / Dashboard"
- Up/Down navigation, Enter to invoke, Esc to close
- Style: centered modal, dark, monospace results

### Implementation notes
- Use `@react-aria/dialog` for a11y or hand-roll with focus trap
- Fuzzy search: `fzf-for-js` or just a small homegrown scorer (50 LOC)
- Command actions return a Promise so the palette can show a spinner if needed

### Acceptance
- Cmd+K opens in any view
- Typing "run X" surfaces matching tasks across all boards (or current board, configurable)
- Esc closes; focus returns to whatever was focused before

---

## D8 — Confetti + hotkeys + keyboard nav

### Confetti
**Add `canvas-confetti`** (~5KB).
- Trigger on first completed task **per local day** (track last-confetti-date in localStorage)
- Trigger ALSO on completing a 5-task, 10-task, 25-task milestone
- Small burst, ~150 particles, 2s duration
- Respects `prefers-reduced-motion`

### Hotkeys
Wire global hotkeys (use `useEventListener` on `window.keydown`):

| Key | Action |
|-----|--------|
| `?` | Show hotkey cheat-sheet popover |
| `j` / `k` | Navigate tasks within current column |
| `h` / `l` | Move between columns |
| `Enter` | Open selected task |
| `r` | Run selected task |
| `n` | New task in current column |
| `g b` | Switch view → Board |
| `g e` | Switch view → Epics |
| `g d` | Switch view → Dashboard |
| `cmd+k` | Command palette |
| `cmd+/` | Toggle settings popover |
| `Esc` | Close any modal |

### Cheat-sheet popover
Press `?` → small dark popover lists every hotkey. Stays until Esc.

### Acceptance
- Every action above works from keyboard only, no mouse
- Hotkeys disabled when typing in an input or textarea
- `?` cheat-sheet always reachable, always current

---

## D9 — Polish pass + accessibility check + week-1 review

### Polish checklist (timeboxed half day)
- All animations honor `prefers-reduced-motion`
- All interactive elements have focus styles
- All colors meet WCAG AA contrast (use a contrast checker)
- All buttons have title attributes (tooltips for icon-only)
- All sounds default to a sensible volume (~50% master, individual tones at -10 to -30dB)
- Empty states: empty board, no running tasks, no activity yet — each is delightful, not blank
- Loading states: skeleton screens, not spinners
- Error states: real errors get real messages, not "Something went wrong"

### Accessibility check
- Run axe DevTools on every major view
- Tab order is sensible
- Screen reader: SSE events should announce politely (use `role="status"` for new text)

### Record the wow demo
- 30-second screen recording: open board → run a sample task → watch the feed → see it complete with a ding
- Save to `docs/demos/week-1.mov`
- Watch it back: does it make you smile? If no, find the missing detail and add it. If still no, the wedge isn't ready and Week 2 should slip a day.

### Week 1 review
Create `docs/week-1-review.md`:
- What landed
- What was cut
- What surprised you
- Is the wedge working? Yes/no/needs-more

---

## Stretch items (if you finish early)

- **Ambient mode** — synthwave background loop the user can toggle for "agent vibes coding sessions". Use a Creative Commons track.
- **Live wallpaper** — board background subtly shifts color based on number of active tasks
- **Activity feed export** — "Save this run as MP4" using `MediaRecorder` over a canvas mirror
- **Emoji reactions on completed runs** — solo today, social later

---

## What to cut if you slip

In order of cut priority (cut from bottom):

1. Polish pass items beyond accessibility (move to Week 4)
2. Hotkey cheat-sheet popover (ship with hotkeys, doc them in README only)
3. Command palette (move to Week 2)
4. Confetti (it's 4 hours, not a high cut)
5. **Never cut: typewriter, animated tool cards, ding + ask chime, browser notifications**

If only those 4 ship, the wedge still works.

---

## Files touched (summary)

```
packages/web/src/components/feed/             ← new
packages/web/src/components/feed/Feed.tsx
packages/web/src/components/feed/EventCard.tsx
packages/web/src/components/feed/TypewriterText.tsx
packages/web/src/components/feed/ToolCallCard.tsx
packages/web/src/components/feed/colors.ts
packages/web/src/components/feed/useFeedPrefs.ts
packages/web/src/components/SettingsPopover.tsx ← new
packages/web/src/components/CommandPalette.tsx  ← new
packages/web/src/lib/sounds.ts                  ← new
packages/web/src/lib/notify.ts                  ← new
packages/web/src/lib/favicon.ts                 ← new
packages/web/src/lib/hotkeys.ts                 ← new
packages/web/src/lib/fuzzy.ts                   ← new
packages/web/src/App.tsx                        ← wire new components
packages/web/src/components/task-detail/RunningMode.tsx ← swap to Feed
packages/web/src/components/task-detail/useTaskExecution.ts ← call sounds/notify
packages/web/src/index.css                      ← animation utilities
package.json                                    ← canvas-confetti dep
```

---

## Definition of done

- [ ] 7 deliverables shipped (or items cut documented in week-1-review.md)
- [ ] 30-sec recording exists at `docs/demos/week-1.mov`
- [ ] Demo recording makes you smile on second watch
- [ ] `bun test` passes
- [ ] No TS errors introduced beyond pre-existing baseline
- [ ] Tagged `git tag v0.2.0-week-1`

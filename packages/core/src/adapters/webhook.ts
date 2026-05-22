export interface WebhookEvent {
  event: "task_completed" | "task_failed" | "awaiting_human";
  board: { id: string; name: string };
  task: { id: string; title: string };
  executionId: string;
  timestamp: string;
}

function formatMessage(e: WebhookEvent): string {
  const label =
    e.event === "task_completed" ? "✅ completed"
    : e.event === "task_failed" ? "❌ failed"
    : "⏸ awaiting decision";
  return `*${e.task.title}* ${label} — board: _${e.board.name}_`;
}

function buildPayload(url: string, event: WebhookEvent): unknown {
  const msg = formatMessage(event);
  if (url.includes("hooks.slack.com")) return { text: msg };
  if (url.includes("discord.com/api/webhooks")) return { content: msg };
  return event; // standard JSON envelope for custom endpoints
}

export async function sendWebhook(url: string, event: WebhookEvent): Promise<void> {
  const payload = buildPayload(url, event);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    } catch { /* network error — retry */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
  }
  console.warn(`[webhook] delivery failed after 3 attempts: ${url}`);
}

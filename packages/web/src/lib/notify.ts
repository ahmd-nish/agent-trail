/** Browser notification helpers. */

let permissionRequested = false;

export function requestPermission() {
  if (permissionRequested) return;
  permissionRequested = true;
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => undefined);
  }
}

export function notify(opts: {
  title: string;
  body?: string;
  tag?: string;
  requireInteraction?: boolean;
}) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  // Don't notify if the user is already on the page.
  if (document.visibilityState === "visible") return;

  try {
    new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      requireInteraction: opts.requireInteraction ?? false,
      icon: "/favicon.ico",
    });
  } catch { /* Safari / fallback */ }
}

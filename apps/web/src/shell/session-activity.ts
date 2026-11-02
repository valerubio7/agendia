type ActivityTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export function startSessionActivity(target: ActivityTarget, send: () => Promise<unknown>, now = Date.now) {
  let lastSent = -Infinity;
  let pending = false;
  const onActivity: EventListener = event => {
    if (!event.isTrusted || pending || now() - lastSent < 60_000) return;
    const sentAt = now();
    pending = true;
    void send().then(() => { lastSent = sentAt; }).catch(() => {}).finally(() => { pending = false; });
  };
  const events = ["pointerdown", "pointermove", "click", "keydown", "input", "wheel", "touchstart"];
  for (const event of events) target.addEventListener(event, onActivity);
  return () => { for (const event of events) target.removeEventListener(event, onActivity); };
}

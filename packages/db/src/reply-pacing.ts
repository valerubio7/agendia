const INITIAL_MS = 600_000;
const ACTIVE_MS = 90_000;
const RESET_MS = 3_600_000;

/** Accepted activity, not provider timestamps, determines pacing. A burst never slides. */
export function replyDeadline(
  now: Date,
  lastReply: Date | null,
  lastExchange: Date | null,
  pendingDeadline: Date | null,
): Date {
  if (pendingDeadline) return pendingDeadline;
  const initial = !lastReply || !lastExchange || now.getTime() - lastExchange.getTime() > RESET_MS;
  return new Date(now.getTime() + (initial ? INITIAL_MS : ACTIVE_MS));
}

import { DEFAULT_REPLY_PACING, type ReplyPacing } from "@agendia/domain";

/** Accepted activity, not provider timestamps, determines pacing. A burst never slides. */
export function replyDeadline(
  now: Date,
  lastReply: Date | null,
  lastExchange: Date | null,
  pendingDeadline: Date | null,
  policy: ReplyPacing = DEFAULT_REPLY_PACING,
): Date {
  if (pendingDeadline) return pendingDeadline;
  const initial = !lastReply || !lastExchange || now.getTime() - lastExchange.getTime() > policy.inactivityResetSeconds * 1000;
  return new Date(now.getTime() + (initial ? policy.initialDelaySeconds : policy.activeDelaySeconds) * 1000);
}

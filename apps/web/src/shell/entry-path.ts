import type { Session } from "../api/api-client";

// Both the login submission and the entrance check share one destination per role.
export const entryPathFor = (session: Pick<Session, "role">): string =>
  session.role === "platform_admin" ? "/businesses" : "/profile";

// The administration entrance only bounces an existing administrator session.
// A business session stays on the form so it can authenticate as administrator.
export const entryRedirectFor = (
  session: Pick<Session, "role">,
  adminEntrance: boolean,
): string | null =>
  adminEntrance && session.role !== "platform_admin"
    ? null
    : entryPathFor(session);

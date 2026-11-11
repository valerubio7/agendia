import type { Session } from "../api/api-client";

// Both the login submission and the entrance check share one destination per role.
export const entryPathFor = (session: Pick<Session, "role">): string =>
  session.role === "platform_admin" ? "/businesses" : "/profile";

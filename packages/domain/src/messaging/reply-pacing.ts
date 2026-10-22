import { z } from "zod";

export const MAX_REPLY_DELAY_SECONDS = 86_400;
export const MAX_INACTIVITY_RESET_SECONDS = 604_800;

/** Global policy values are integer seconds, never provider timestamps or milliseconds. */
export const ReplyPacingSchema = z.object({
  initialDelaySeconds: z.number().int().min(0).max(MAX_REPLY_DELAY_SECONDS),
  activeDelaySeconds: z.number().int().min(0).max(MAX_REPLY_DELAY_SECONDS),
  inactivityResetSeconds: z.number().int().min(1).max(MAX_INACTIVITY_RESET_SECONDS),
}).strict();
export type ReplyPacing = z.infer<typeof ReplyPacingSchema>;
export const DEFAULT_REPLY_PACING: Readonly<ReplyPacing> = Object.freeze(ReplyPacingSchema.parse({
  initialDelaySeconds: 600,
  activeDelaySeconds: 90,
  inactivityResetSeconds: 3600,
}));

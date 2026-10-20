import { z } from "zod";
import { ReplyPacingSchema, type ReplyPacing } from "../../../domain/src/messaging/reply-pacing.ts";

export const PlatformAiInstructionsInputSchema = z.object({
  additionalInstructions: z.string(),
  replyPacing: ReplyPacingSchema.optional(),
}).strict();
export type PlatformAiInstructions = {
  baseInstructions: string;
  additionalInstructions: string;
  replyPacing: ReplyPacing;
};

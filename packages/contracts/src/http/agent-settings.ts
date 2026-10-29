import { z } from "zod";
import { ReplyPacingSchema, type ReplyPacing } from "../../../domain/src/messaging/reply-pacing.ts";

export const ResponseTimingInputSchema = z.object({ responseTiming: ReplyPacingSchema }).strict();
export type ResponseTiming = { responseTiming: ReplyPacing };

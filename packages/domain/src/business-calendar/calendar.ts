import { z } from "zod";
import { CalendarDateSchema, OrderedInstantIntervalSchema } from "./values.ts";

/** Business-only closures form a union; duplicates, overlaps and adjacency are valid.
 * Strict keys prevent an unsupported resource scope from becoming a global closure.
 */
export const BusinessClosureInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), date: CalendarDateSchema }).strict(),
  OrderedInstantIntervalSchema.safeExtend({ kind: z.literal("interval") }).strict(),
]);
export type BusinessClosureInput = z.infer<typeof BusinessClosureInputSchema>;
export type BusinessClosure = BusinessClosureInput & { id: string };

import { z } from "zod";
import { renderAgentResponse, type AgentResponse } from "./response.ts";
import { CalendarDateSchema, InstantSchema, type ToolConversationMessage, type ToolConversationRequest } from "@agendia/domain";

// The calendar engine in packages/domain/src/appointments/availability.ts uses this fixed IANA zone;
// it is not a profile setting or a model-selected timezone.
export const AGENT_CALENDAR_TIME_ZONE = "America/Argentina/Buenos_Aires";
export interface AgentDatePresentation {
  timeZone: string;
  localDate: string;
  localTime: string;
  weekday: string;
  label: string;
}
/** Presentation only. Never insert these fields into quote terms or fingerprints. */
export function canonicalAgentDate(instant: unknown, timeZone: unknown): AgentDatePresentation | null {
  const parsed = InstantSchema.safeParse(instant);
  if (!parsed.success || typeof timeZone !== "string" || !timeZone) return null;
  try {
    const formatter = new Intl.DateTimeFormat("es-AR", {
      timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(parsed.data));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
    const localDate = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
    const localTime = `${part("hour")}:${part("minute")}`;
    const weekday = part("weekday");
    const month = new Intl.DateTimeFormat("es-AR", { timeZone, month: "long" }).format(new Date(parsed.data));
    return { timeZone, localDate, localTime, weekday, label: `${weekday} ${Number(part("day"))} de ${month} de ${part("year")} a las ${localTime}` };
  } catch { return null; }
}

const id = z.uuid();
const selection = { serviceId: id, resourceId: id.optional(), startsAt: InstantSchema };
const nameField = z.object({ value: z.string().min(1).max(100).refine(value => value.trim() === value),
  messageId: id, start: z.number().int().nonnegative() }).strict();
const memberBinding = { evidenceReference: z.string().regex(/^[a-f0-9]{64}$/u),
  messageId: id, evidence: z.string().min(1).max(12000) };
const schemas = {
  read_business: z.object({}).strict(),
  read_catalog: z.object({}).strict(),
  read_calendar: z.object({}).strict(),
  read_resources: z.object({}).strict(),
  availability: z.object({
    serviceId: id.describe("Use only an ID from fresh read_catalog results or validated pending state for the chosen service."),
    date: CalendarDateSchema,
    resourceId: id.describe("Use only an ID from fresh read_resources results or validated pending state for the chosen resource.").optional(),
    appointmentId: id.describe("Only a current sender-owned eligible reschedule reference; omit for a new availability search. Never invent IDs or drop retained reschedule context.").optional(),
  }).strict(),
  owned_appointments: z.object({}).strict(),
  owned_appointment: z.object({ appointmentId: id }).strict(),
  prepare_booking: z.object(selection).strict(),
  collect_booking_names: z.object({ namesReference: z.string().regex(/^[a-f0-9]{64}$/u),
    firstName: nameField.optional(), lastName: nameField.optional(),
  }).strict().refine(args => args.firstName !== undefined || args.lastName !== undefined),
  prepare_change: z.object({ appointmentId: id, serviceId: id.optional(), resourceId: id.optional(), startsAt: InstantSchema.optional() })
    .strict().refine(args => args.serviceId !== undefined || args.resourceId !== undefined || args.startsAt !== undefined),
  confirm_quote: z.object({}).strict(),
  confirm_quote_naturally: z.object({
    evidence: z.string().min(1).max(12000),
    evidenceReference: z.string().regex(/^[a-f0-9]{64}$/u),
    quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  clear_pending: z.object({}).strict(),
  cancel: z.object({ appointmentId: id, binding: z.object({
    evidence: z.string().min(1).max(12000),
    evidenceReference: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().optional() }).strict(),
  notes: z.object({ appointmentId: id, notes: z.string().max(2000).nullable(),
    binding: z.object({ ...memberBinding, start: z.number().int().nonnegative().optional() }).strict().optional(),
  }).strict().refine(args => !args.binding || (args.notes === null ? args.binding.start === undefined : args.binding.start !== undefined)),
  preference: z.object({ appointmentId: id, resourceId: id.nullable(),
    binding: z.object({ ...memberBinding, resourceReference: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict().optional(),
  }).strict().refine(args => !args.binding || (args.resourceId === null ? args.binding.resourceReference === undefined : args.binding.resourceReference !== undefined)),
};
type ToolName = keyof typeof schemas;
export type AgentToolCommand = {
  [Name in ToolName]: { name: Name; arguments: z.infer<(typeof schemas)[Name]> }
}[ToolName];
const descriptions: Record<ToolName, string> = {
  read_business: "Read registered displayName, description and address. Missing data is not an infrastructure failure.",
  read_catalog: "Read active services and current prices and durations; these are not appointment quotes.",
  read_calendar: "Read habitual business hours and closures. This does not establish appointment availability.",
  read_resources: "Read active resources, schedules, service IDs and current-turn resourceReference for preference metadata. No capacity reserved.",
  availability: "Read actual slots on exactly one date for a tenant service and optional resource. startGroups indexes reference returned items and describe quarter-hour start options, not appointment end times; hasMore means results are incomplete. Optional appointmentId is verified as current sender-owned before excluding its occupancy for a change. No reservation.",
  owned_appointments: "Read current sender-owned appointments with target/snapshot-bound cancellationReference, notesReference and preferenceReference.",
  owned_appointment: "Inspect one current sender-owned appointment with cancellationReference, notesReference and preferenceReference. IDs never establish ownership.",
  prepare_booking: "Prepare a real slot quote, not a booking, including before offering a concrete alternative even when names are missing. Replaces previous pending selection. Confirmation requires later explicit customer consent after quote delivery.",
  collect_booking_names: "Patch only the customer's own new-booking names in an active draft. Copy its fresh namesReference and literal field values from authenticated nameSources, each with messageId and zero-based UTF-16 start offset. Omitted fields are retained; corrections replace only supplied fields. Never use DNI, insurance, profile, third-person names, history or summaries. Binding authenticates provenance, NOT semantic name ownership. Names alone never authorize booking; completing missing names can stage a booking only after prior clear acceptance of the same delivered quote. Use the returned fresh reference for another patch.",
  prepare_change: "Prepare a sender-owned change quote, not a saved change. Requires later explicit confirmation after delivery.",
  confirm_quote: "Legacy literal confirmation or pending names using the actual received message. Effects are staged until session commit.",
  confirm_quote_naturally: "Interpret clear explicit acceptance of the exact delivered pending quote. Copy the COMPLETE current message as evidence and its runtime naturalConfirmation bindings. Never invoke for ambiguity, hypotheticals, negation or changed conditions: clarify or prepare a fresh quote instead. Backend verifies evidence authenticity and quote context, NOT consent semantics; interpretation can be wrong. Effects remain staged until session commit.",
  clear_pending: "Discard the pending draft/quote when the customer changes their mind. Never cancels or changes a saved appointment.",
  cancel: "Cancel a freshly inspected owned appointment for a clear current request or contextual affirmative answer. Copy its cancellationReference into binding.evidenceReference and COMPLETE currentEvidence into binding.evidence. Clarify genuinely ambiguous intent/target; never invoke for negation, hypotheticals or history. Binding verifies current context and target snapshot, NOT consent semantics. Omit binding only for legacy literal cancellation. Effects are staged until session commit.",
  notes: "Native: binding uses notesReference as evidenceReference, authenticated nameSources messageId/full evidence, and literal UTF-16 start. Null clear omits start. No rewriting. Without binding: legacy guards.",
  preference: "Native metadata only: binding uses preferenceReference, nameSources messageId/full evidence, and fresh resourceReference for non-null selection. Null clear omits resourceReference. Without binding: legacy guards.",
};
export const agentToolDefinitions: ToolConversationRequest["tools"] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as ToolName], parameters: z.toJSONSchema(schema) as ToolConversationRequest["tools"][number]["parameters"],
}));

export type AgentToolDiagnostic = {
  code: "agent.tool_completed";
  toolName: ToolName | "unknown";
  status: AgentToolResult["status"] | "infrastructure_failure";
} | {
  code: "agent.turn_completed";
  toolCalls: number;
  completedCalls: number;
  failedCalls: number;
} | {
  code: "agent.tool_rejected";
  toolName: ToolName | "unknown";
  errorCode: import("@agendia/db").AppointmentError["code"] | "INVALID_TOOL" | "UNKNOWN_APPOINTMENT_ERROR";
  referenceFailureKind?: "service" | "resource" | "appointment_context";
  schemaIssueCategory?: "unknown_tool" | "unexpected_fields" | "invalid_type" | "invalid_value";
};
export type AgentToolDiagnostics = (event: AgentToolDiagnostic) => void;

export function emitAgentDiagnostic(diagnose: AgentToolDiagnostics | undefined, event: AgentToolDiagnostic): void {
  // Observability must never roll back a mutation or turn its retry into a duplicate.
  try { Promise.resolve(diagnose?.(event)).catch(() => {}); } catch {}
}

export function parseAgentTool(name: string, args: unknown,
  diagnose?: AgentToolDiagnostics): AgentToolCommand | null {
  if (!Object.hasOwn(schemas, name)) {
    emitAgentDiagnostic(diagnose, { code: "agent.tool_rejected", toolName: "unknown", errorCode: "INVALID_TOOL", schemaIssueCategory: "unknown_tool" });
    return null;
  }
  const toolName = name as ToolName;
  const parsed = schemas[toolName].safeParse(args);
  if (parsed.success) return { name: toolName, arguments: parsed.data } as AgentToolCommand;
  // Never forward Zod issues: paths, unknown keys and messages can contain private input.
  const issue = parsed.error.issues[0];
  const schemaIssueCategory = issue?.code === "unrecognized_keys" ? "unexpected_fields"
    : issue?.code === "invalid_type" ? "invalid_type" : "invalid_value";
  emitAgentDiagnostic(diagnose, { code: "agent.tool_rejected", toolName, errorCode: "INVALID_TOOL", schemaIssueCategory });
  return null;
}

/** Inside a transaction, staged_action is NOT committed. Only the outer session return
 * attests durability. Results are structured facts for model-authored prose;
 * prepared_quote is no mutation. No result may be sent separately.
 */
export type AgentToolResult = (
  | { status: "data"; data: unknown }
  | { status: "unavailable_data"; code: string }
  | { status: "clarification" | "rejected"; code: string; reason?: string; missingFields?: readonly string[];
      alternatives?: { items: unknown[]; hasMore: boolean; resourceName?: string | null }; proposal?: unknown }
  | { status: "prepared_quote"; quote: unknown; reason?: string; presentation?: AgentDatePresentation | null }
  | { status: "staged_action"; operation: string; appointment: unknown }) & {
    namesReference?: string | null; presentationReference?: string | null };
export type AgentSessionOutcome =
  | { status: "committed"; outboundId: string; actions: { operation: string; appointmentId: string }[] }
  | { status: "not_current" | "infrastructure_failure" };

/** T3 copies these opaque runtime references plus the exact context.message into
 * confirm_quote_naturally ONLY after interpreting clear acceptance of that quote.
 * For ambiguous, negated, hypothetical or changed conditions, return clarification
 * or prepare a new quote instead. Authentic non-consent text can still pass the
 * binding checks if a model misinterprets it: that false-positive risk is not a
 * deterministic backend guarantee. No boolean assertion can remove that risk.
 */
export interface NaturalConfirmationBinding {
  readonly evidenceReference: string;
  readonly quoteFingerprint: string;
}
/** The handler is a transaction-local runtime capability, not a model repository.
 * Calls are serialized even if the provider batches them. Retaining this object
 * after the callback gives no capability. Infrastructure exceptions must abort
 * the entire transaction; do not turn them into missing business facts.
 */
export class AgentToolSession {
  renderResponse(raw: string): AgentResponse { return renderAgentResponse(raw); }
  private calls = 0;
  private observedCalls = 0;
  private completedCalls = 0;
  private failedCalls = 0;
  private turnReported = false;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  constructor(private handler: (command: AgentToolCommand) => Promise<AgentToolResult>,
    readonly context: Readonly<{ message: string; recent: readonly string[]; pending: unknown;
      naturalConfirmation?: Readonly<NaturalConfirmationBinding> | null; messages?: readonly ToolConversationMessage[];
      namesReference?: string | null; nameSources?: readonly { messageId: string; text: string }[];
      pendingPresentation?: Readonly<AgentDatePresentation> | null; pendingQuotePresentationReference?: string | null }> = { message: "", recent: [], pending: null },
    private diagnose?: AgentToolDiagnostics,
    private rejectPreparation?: () => void) {}
  execute(name: string, args: unknown): Promise<AgentToolResult> {
    this.observedCalls++;
    const toolName = Object.hasOwn(schemas, name) ? name as ToolName : "unknown";
    const completed = (output: AgentToolResult): AgentToolResult => {
      this.completedCalls++;
      emitAgentDiagnostic(this.diagnose, { code: "agent.tool_completed", toolName, status: output.status });
      return output;
    };
    if (this.closed) return Promise.resolve(completed({ status: "rejected", code: "SESSION_LIMIT" }));
    const overLimit = ++this.calls > 16;
    const result = this.tail.then(async () => {
      if (this.closed) return { status: "rejected", code: "SESSION_CLOSED" } as const;
      if (this.failure) throw this.failure;
      // Rejections that bypass the handler still follow invocation order, including batches.
      const command = overLimit ? null : parseAgentTool(name, args, this.diagnose);
      const output: AgentToolResult = overLimit ? { status: "rejected", code: "SESSION_LIMIT" }
        : command ? await this.handler(command) : { status: "rejected", code: "INVALID_TOOL" };
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 16384) throw new Error("Tool result limit");
      if (output.status === "rejected" && (toolName === "prepare_booking" || toolName === "prepare_change"))
        this.rejectPreparation?.();
      return output;
    }).then(completed, error => {
      this.failedCalls++;
      emitAgentDiagnostic(this.diagnose, { code: "agent.tool_completed", toolName, status: "infrastructure_failure" });
      throw error;
    });
    this.tail = result.catch(error => { this.failure = error; });
    return result;
  }
  async drain(): Promise<void> { await this.tail; if (this.failure) throw this.failure; }
  close(): void { this.closed = true; }
  /** Called by the transaction owner only after drain and durable commit. */
  reportCompletedTurn(): void {
    if (this.turnReported || !this.closed || this.failure || this.completedCalls !== this.observedCalls) return;
    this.turnReported = true;
    emitAgentDiagnostic(this.diagnose, { code: "agent.turn_completed", toolCalls: this.observedCalls,
      completedCalls: this.completedCalls, failedCalls: this.failedCalls });
  }
}

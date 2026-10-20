import { z } from "zod";
import {
  AppointmentRecordSchema,
  AvailabilitySlotSchema,
  ManualAppointmentChangeSchema,
  ManualAppointmentCreateSchema,
  ManualAppointmentNotesSchema,
  ManualAppointmentStateSchema,
} from "./http/appointments.ts";

export * from "./http/appointments.ts";
export * from "./http/resources.ts";
export * from "./http/business-calendar.ts";
export * from "./http/agent-settings.ts";

export const CatalogDeletionAckSchema = z.object({ id: z.string().uuid() }).strict();
export type CatalogDeletionAck = z.infer<typeof CatalogDeletionAckSchema>;

export const PRODUCT_HTTP_ROUTES = Object.freeze([
  "/auth/login",
  "/auth/logout",
  "/auth/session",
  "/admin/businesses",
  "/admin/ai-instructions",
  "/admin/businesses/:id/user",
  "/admin/businesses/:id/status",
  "/me/appointments",
  "/me/appointments/:appointmentId",
  "/me/appointments/:appointmentId/notes",
  "/me/appointments/:appointmentId/state",
  "/me/appointments/availability",
  "/me/clients",
  "/me/clients/:id",
  "/me/services",
  "/me/services/:id",
  "/me/services/:id/status",
  "/me/resources",
  "/me/resources/:id",
  "/me/resources/:id/status",
  "/me/business-calendar",
  "/me/business-calendar/closures",
  "/me/business-calendar/closures/:id",
  "/me/business-profile",
  "/me/assistant",
  "/me/whatsapp",
  "/me/whatsapp/link",
  "/me/whatsapp/status",
] as const);

export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
]);
export const SafeErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: z.string().min(1).max(128),
  details: z.record(z.string(), z.string()).optional(),
});
export type SafeError = z.infer<typeof SafeErrorSchema>;

const SENSITIVE =
  /(pass(word)?|secret|token|cookie|authorization|api[-_]?key|qr|credential)/i;
export function redactFields(
  details: Record<string, unknown> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      SENSITIVE.test(key) ? "[REDACTED]" : String(value),
    ]),
  );
}

export function makeSafeError(
  code: SafeError["code"],
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): SafeError {
  const safe = details ? redactFields(details) : undefined;
  return SafeErrorSchema.parse({
    code,
    message,
    requestId,
    ...(safe ? { details: safe } : {}),
  });
}

export function toOpenApiDocument() {
  return {
    openapi: "3.1.0" as const,
    info: { title: "agendIA API", version: "1.0.0" },
    paths: Object.fromEntries(PRODUCT_HTTP_ROUTES.map((route) => [route,
      route === "/me/appointments/availability" ? {
        get: {
          summary: "Query all owned business appointment availability choices",
          description: "Strict serviceId/date query with optional resourceId and owned upcoming Confirmed appointmentId reschedule context. Unknown query keys or a request body are invalid. Server clock determines lead time. Suspended or unassigned live catalogs yield no offers; foreign or retired IDs are not found. Advisory only: saves must revalidate; no reservation or customer/sender identity proof.",
          parameters: [
            { name: "serviceId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
            { name: "date", in: "query", required: true, schema: { type: "string", format: "date", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } },
            ...["resourceId", "appointmentId"].map(name => ({ name, in: "query", required: false, schema: { type: "string", format: "uuid" } })),
          ],
          responses: Object.fromEntries([200, 400, 401, 403, 404, 409, 500].map(status => [String(status), {
            description: status === 200 ? "All advisory D2 slots" : status === 409 ? "Reschedule appointment is final or started" : "Safe operation error",
            content: { "application/json": { schema: status === 200
              ? { type: "array", items: { $ref: "#/components/schemas/AvailabilitySlot" } }
              : { $ref: "#/components/schemas/SafeError" } } },
          }])),
        },
      } : route === "/me/appointments/:appointmentId/notes" || route === "/me/appointments/:appointmentId/state" ? {
        patch: {
          summary: "Manual owned appointment action (business session, Origin and CSRF required)",
          description: route.endsWith("/notes")
            ? "Strict notes string/null only; null clears and empty string is retained. Confirmed-only, including already started. No length limit; NUL is invalid. All other saved fields are preserved."
            : "Strict final state (done, cancelled, no_show) and confirmed literal true only, even for AI-origin bookings. Server derives businessAdmin/manual and fresh time after the tenant business lock. Cancellation has no cutoff; Done/NoShow are allowed at or after start, not end. Final states are immutable: no reopening or automatic transitions. All other saved fields are preserved.",
          parameters: [{ name: "appointmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${route.endsWith("/notes") ? "ManualAppointmentNotes" : "ManualAppointmentState"}` } } } },
          responses: Object.fromEntries([200, 400, 401, 403, 404, 409, 500].map(status => [String(status), {
            description: status === 200 ? "Current client identity and saved appointment terms; atomic generic audit/outbox only, no AI or WhatsApp effects"
              : status === 400 ? "VALIDATION_FAILED: invalid strict body, ID, query or literal confirmation"
              : status === 401 ? "UNAUTHENTICATED: session required"
              : status === 403 ? "FORBIDDEN: business role, Origin or CSRF"
              : status === 404 ? "NOT_FOUND: unknown or foreign appointment"
              : status === 409 ? "CONFLICT: final state or attendance before start"
              : "INTERNAL_ERROR: safe atomic operation failure",
            content: { "application/json": { schema: { $ref: `#/components/schemas/${status === 200 ? "AppointmentRecord" : "SafeError"}` } } },
          }])),
        },
      } : route === "/me/appointments" || route === "/me/appointments/:appointmentId" ? {
        get: {
          summary: "Read owned appointment history (business session; all states, no range default or cap)",
          description: "Strict query keys only. Bounds are exact explicit-offset instants, not calendar dates. Session determines business scope; business-admin access does not authenticate a customer sender.",
          parameters: route === "/me/appointments" ? [
            { name: "clientId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
            ...["from", "to"].map(name => ({ name, in: "query", required: false, schema: { type: "string", format: "date-time" }, description: name === "from" ? "Inclusive start instant (explicit offset)" : "Exclusive start instant (explicit offset); must be after from" })),
          ] : [{ name: "appointmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: Object.fromEntries([200, 400, 401, 403, 404, 500].map(status => [String(status), {
            description: status === 200 ? "Current client identity and frozen appointment terms" : "Safe operation error",
            content: { "application/json": { schema: status !== 200 ? { $ref: "#/components/schemas/SafeError" }
              : route === "/me/appointments" ? { type: "array", items: { $ref: "#/components/schemas/AppointmentRecord" } }
              : { $ref: "#/components/schemas/AppointmentRecord" } } },
          }])),
        },
        ...(route === "/me/appointments" ? { post: {
          summary: "Create a Confirmed manual appointment (business session, Origin and CSRF required)",
          description: "Strict body; exactly one owned clientId or newClient. confirmed must be literal true: explicit manual commit, not customer/AI sender proof. date is the selected local calendar date. Server revalidates exact epoch availability and every expectedTerms field under the business lock; terms are only an optimistic precondition. Persisted identity and terms come from the server. No customer preference, WhatsApp jobs or idempotency guarantee.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ManualAppointmentCreate" } } } },
          responses: Object.fromEntries([201, 400, 401, 403, 404, 409, 500].map(status => [String(status), {
            description: status === 201 ? "Current client identity and server snapshot" : status === 400 ? "VALIDATION_FAILED: invalid strict body or confirmation" : status === 401 ? "UNAUTHENTICATED: session required" : status === 403 ? "FORBIDDEN: business role, Origin or CSRF" : status === 404 ? "NOT_FOUND: foreign, missing or retired owned ID" : status === 409 ? "CONFLICT: no current offer, stale terms, busy capacity or duplicate client phone" : "INTERNAL_ERROR: safe atomic operation failure",
            content: { "application/json": { schema: { $ref: `#/components/schemas/${status === 201 ? "AppointmentRecord" : "SafeError"}` } } },
          }])),
        } } : { patch: {
          summary: "Change owned Confirmed appointment structure (business session, Origin and CSRF required)",
          description: "Strict serviceId/resourceId/startRaw/date/expectedTerms/confirmed body only. Literal true is manual confirmation, not customer sender proof. Server locks then revalidates epoch and full effective snapshot: unchanged identities retain saved terms. Actual changes require live eligible choices; final or started structural changes conflict. A validated stored identity/epoch no-op retains all physical fields without availability or catalog refresh, even after start or retirement. Client, notes, state, origin and preference are immutable; no WhatsApp/AI effects or idempotency guarantee. Notes/state/delete operations are unsupported.",
          parameters: [{ name: "appointmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ManualAppointmentChange" } } } },
          responses: Object.fromEntries([200, 400, 401, 403, 404, 409, 500].map(status => [String(status), {
            description: status === 200 ? "Current client identity and effective server snapshot" : status === 400 ? "VALIDATION_FAILED: invalid strict body, ID or confirmation" : status === 401 ? "UNAUTHENTICATED: session required" : status === 403 ? "FORBIDDEN: business role, Origin or CSRF" : status === 404 ? "NOT_FOUND: unknown or foreign owned context" : status === 409 ? "CONFLICT: final/started structure, unavailable or busy choice, stale terms" : "INTERNAL_ERROR: safe atomic operation failure",
            content: { "application/json": { schema: { $ref: `#/components/schemas/${status === 200 ? "AppointmentRecord" : "SafeError"}` } } },
          }])),
        } }),
      } : route === "/me/services/:id" || route === "/me/resources/:id" ? {
        delete: {
          summary: "Retire owned catalog item (business session, Origin and CSRF required)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: Object.fromEntries([200, 400, 401, 403, 404, 409, 500].map(status => [String(status), {
            description: status === 200 ? "Retired catalog identity" : "Safe operation error",
            content: { "application/json": { schema: { $ref: `#/components/schemas/${status === 200 ? "CatalogDeletionAck" : "SafeError"}` } } },
          }])),
        },
      } : {},
    ])),
    components: {
      schemas: {
        ManualAppointmentCreate: {
          ...z.toJSONSchema(ManualAppointmentCreateSchema, { io: "input" }),
          oneOf: [
            { required: ["clientId"], not: { required: ["newClient"] } },
            { required: ["newClient"], not: { required: ["clientId"] } },
          ],
        },
        ManualAppointmentChange: z.toJSONSchema(ManualAppointmentChangeSchema, { io: "input" }),
        ManualAppointmentNotes: z.toJSONSchema(ManualAppointmentNotesSchema, { io: "input" }),
        ManualAppointmentState: z.toJSONSchema(ManualAppointmentStateSchema, { io: "input" }),
        AppointmentRecord: z.toJSONSchema(AppointmentRecordSchema),
        AvailabilitySlot: z.toJSONSchema(AvailabilitySlotSchema, { io: "input" }),
        CatalogDeletionAck: {
          type: "object", required: ["id"], additionalProperties: false,
          properties: { id: { type: "string", format: "uuid" } },
        },
        SafeError: {
          type: "object",
          required: ["code", "message", "requestId"],
          additionalProperties: false,
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            requestId: { type: "string" },
            details: { type: "object" },
          },
        },
      },
    },
  };
}

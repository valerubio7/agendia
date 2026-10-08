import { z } from "zod";
import type { BusinessClosure, BusinessClosureInput, WeeklySchedule, ResourceInput } from "@agendia/domain";
export type ResourceRequest = ResourceInput;
export type ResourceDto = Omit<ResourceInput, "description"> & {
  id: string; description: string | null; status: "active" | "suspended";
};
export type BusinessClosureDto = BusinessClosure;
export type BusinessClosureRequest = BusinessClosureInput;
export const CatalogDeletionAckSchema = z.object({ id: z.string().uuid() }).strict();
export type CatalogDeletionAck = z.infer<typeof CatalogDeletionAckSchema>;

/** Null means unconfigured; an empty map is explicitly all off. */
export type BusinessCalendarDto = { weeklySchedule: WeeklySchedule | null };
export type BusinessCalendarInput = { weeklySchedule: WeeklySchedule };

export const PRODUCT_HTTP_ROUTES = Object.freeze([
  "/auth/login",
  "/auth/logout",
  "/auth/session",
  "/admin/businesses",
  "/admin/ai-instructions",
  "/admin/businesses/:id/user",
  "/admin/businesses/:id/status",
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

export const PlatformAiInstructionsInputSchema = z.object({
  additionalInstructions: z.string(),
}).strict();
export type PlatformAiInstructions = {
  baseInstructions: string;
  additionalInstructions: string;
};

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
      route === "/me/services/:id" || route === "/me/resources/:id" ? {
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

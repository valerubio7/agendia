import { z } from "zod";

export const PRODUCT_HTTP_ROUTES = Object.freeze([
  "/auth/login",
  "/auth/logout",
  "/auth/session",
  "/admin/businesses",
  "/admin/businesses/:id/user",
  "/admin/businesses/:id/status",
  "/me/business-profile",
  "/me/assistant",
  "/me/whatsapp",
  "/me/whatsapp/link",
  "/me/whatsapp/status",
] as const);

export const ErrorCodeSchema = z.enum(["VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INTERNAL_ERROR"]);
export const SafeErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: z.string().min(1).max(128),
  details: z.record(z.string(), z.string()).optional(),
});
export type SafeError = z.infer<typeof SafeErrorSchema>;

const SENSITIVE = /(pass(word)?|secret|token|cookie|authorization|api[-_]?key|qr|credential)/i;
export function redactFields(details: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : String(value)]));
}

export function makeSafeError(code: SafeError["code"], message: string, requestId: string, details?: Record<string, unknown>): SafeError {
  const safe = details ? redactFields(details) : undefined;
  return SafeErrorSchema.parse({ code, message, requestId, ...(safe ? { details: safe } : {}) });
}

export function toOpenApiDocument() {
  return {
    openapi: "3.1.0" as const,
    info: { title: "AgendIA API", version: "1.0.0" },
    paths: Object.fromEntries(PRODUCT_HTTP_ROUTES.map((route) => [route, {}])),
    components: { schemas: { SafeError: {
      type: "object", required: ["code", "message", "requestId"], additionalProperties: false,
      properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" }, details: { type: "object" } },
    } } },
  };
}

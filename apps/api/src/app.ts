import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { Algorithm, hash } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuthService,
  digestOpaqueToken,
  deriveSessionCsrf,
  verifyLoginPassword,
  sessionCookie,
  validateMutationRequest,
} from "@agendia/auth";
import { makeSafeError, PlatformAiInstructionsInputSchema, AppointmentRecordSchema, AvailabilitySlotSchema, ManualAppointmentCreateSchema, ManualAppointmentChangeSchema, ManualAppointmentNotesSchema, ManualAppointmentStateSchema, AppointmentOperationKeySchema, AppointmentOperationReceiptSchema } from "@agendia/contracts";
import {
  RECEPTIONIST_SYSTEM_INSTRUCTIONS,
} from "@agendia/domain";
import {
  tenantContext,
  TenantUnitOfWork,
  ResourceCatalogError,
  AppointmentError,
  AppointmentOperationError,
  type AppointmentOperationRow,
  type createRuntimePools,
} from "@agendia/db";

import { registerBusinessProfileRoutes } from "./routes/business-profile.ts";
import { registerAgentSettingsRoutes } from "./routes/agent-settings.ts";
import { registerWhatsappRoutes } from "./routes/whatsapp.ts";
import { registerClientRoutes } from "./routes/clients.ts";
import { registerServiceRoutes } from "./routes/services.ts";
import { registerResourceRoutes } from "./routes/resources.ts";
import { registerBusinessClosureRoutes, registerBusinessCalendarRoutes } from "./routes/business-calendar.ts";
import { registerAppointmentOperationRoutes, registerAppointmentListRoute, registerAppointmentRoutes } from "./routes/appointments.ts";
import type { Session } from "./routes/context.ts";

const COOKIE = "__Host-agendia_session";
type Pools = ReturnType<typeof createRuntimePools>;
export interface ApiOptions {
  pools: Pools;
  expectedOrigin: string;
  absoluteTtlMs?: number;
  idleTtlMs?: number;
  linkCodeKey?: Buffer;
}
const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(16),
});

function legacyApi(auth: AuthService) {
  const app = Fastify({ logger: false });
  app.post("/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    if (!body?.email || !body.password)
      return reply.code(400).send({ code: "VALIDATION_FAILED" });
    try {
      return reply.send({
        csrfToken: (await auth.login(body.email, body.password)).csrfToken,
      });
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED" });
    }
  });
  app.post("/auth/logout", async (_request, reply) => reply.code(204).send());
  // The legacy in-memory HTTP adapter never issues/authenticates cookies; do not expose recovery.
  app.post("/auth/csrf", async (_request, reply) => reply.header("cache-control", "no-store").code(401).send({ code: "UNAUTHENTICATED" }));
  app.get("/auth/session", async (_request, reply) =>
    reply.code(401).send({ code: "UNAUTHENTICATED" }),
  );
  return app;
}

export function buildApi(input: AuthService | ApiOptions) {
  if (input instanceof AuthService) return legacyApi(input);
  const { pools, expectedOrigin, linkCodeKey } = input;
  const absoluteTtl = input.absoluteTtlMs ?? 8 * 60 * 60_000;
  const idleTtl = input.idleTtlMs ?? 30 * 60_000;
  const app = Fastify({ logger: false });
  void app.register(cookie);
  const fail = (
    reply: FastifyReply,
    request: FastifyRequest,
    status: number,
    code:
      | "VALIDATION_FAILED"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INTERNAL_ERROR",
    message: string,
  ) => reply.code(status).send(makeSafeError(code, message, request.id));
  const originOk = (request: FastifyRequest) =>
    request.headers.origin === expectedOrigin;
  const session = async (request: FastifyRequest): Promise<Session | null> => {
    const token = request.cookies[COOKIE];
    if (!token) return null;
    const found = await pools.api.run(
      undefined,
      (repo) =>
        repo.session(digestOpaqueToken(token)) as Promise<Session | null>,
    );
    if (found)
      await pools.api.run(undefined, (repo) =>
        repo.touchSession(found.session_id, new Date(Date.now() + idleTtl)),
      );
    return found;
  };
  const mutation = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await session(request);
    const csrf = request.headers["x-csrf-token"] as string | undefined;
    if (!auth) {
      fail(reply, request, 401, "UNAUTHENTICATED", "Authentication required");
      return null;
    }
    if (
      !validateMutationRequest({
        origin: request.headers.origin ?? "",
        expectedOrigin,
        csrfHeader: csrf ?? "",
        sessionToken: request.cookies[COOKIE]!,
        csrfSession:
          csrf && auth.csrf_sha256 === digestOpaqueToken(csrf) ? csrf : "",
      })
    ) {
      fail(reply, request, 403, "FORBIDDEN", "Mutation protection failed");
      return null;
    }
    return auth;
  };
  const context = (auth: Session, request: FastifyRequest) =>
    tenantContext({
      businessId: auth.business_id!,
      actorId: auth.identity_id,
      role: auth.role,
      requestId: request.id,
    });
  const events = (
    type: string,
    request: FastifyRequest,
    stableKey = `${type}:${randomUUID()}`,
    payload: object = {},
  ) => ({
    audit: {
      eventType: type,
      outcome: "success" as const,
      eventHash: createHash("sha256")
        .update(`${type}:${request.id}`)
        .digest("hex"),
    },
    outbox: { topic: type, stableKey, payload },
  });
  const tenantWrite = <T>(
    auth: Session,
    request: FastifyRequest,
    type: string,
    work: Parameters<TenantUnitOfWork["execute"]>[2],
    payload: object = {},
  ) => {
    const header = request.headers["x-appointment-operation-key"];
    const route = request.routeOptions.url ?? "";
    let operation;
    if (header !== undefined && route.startsWith("/me/appointments") && request.method !== "GET") {
      const key = AppointmentOperationKeySchema.safeParse(header);
      if (!key.success) throw new AppointmentOperationError(400, makeSafeError("VALIDATION_FAILED", "Invalid operation key", request.id));
      const kind = request.method === "POST" ? "create" : route.endsWith("/notes") ? "notes" : route.endsWith("/state") ? "state" : "change";
      const schema = kind === "create" ? ManualAppointmentCreateSchema : kind === "change" ? ManualAppointmentChangeSchema
        : kind === "notes" ? ManualAppointmentNotesSchema : ManualAppointmentStateSchema;
      const target = kind === "create" ? null : String((request.params as { appointmentId: string }).appointmentId).toLowerCase();
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([name, item]) => [name, canonical(typeof item === "string" && /Id$/.test(name) ? item.toLowerCase() : item)])) : value;
      operation = { key: key.data, kind: kind as AppointmentOperationRow["kind"], target, status: kind === "create" ? 201 : 200,
        fingerprint: createHash("sha256").update(JSON.stringify(canonical({ kind, target, payload: schema.parse(request.body) }))).digest("hex"),
        failure: (cause: unknown) => {
          if (!(cause instanceof AppointmentError) || ["INVALID_ACTION_CONTEXT", "INVALID_ATTENDANCE_TIME"].includes(cause.code)) return null;
          const status = cause.code === "INVALID_INPUT" ? 400 : cause.code === "UNKNOWN_OWNED_ID" ? 404 : 409;
          const code = status === 400 ? "VALIDATION_FAILED" : status === 404 ? "NOT_FOUND" : "CONFLICT";
          return { status, body: makeSafeError(code, "Appointment operation was rejected", request.id) };
        },
      };
    }
    return new TenantUnitOfWork(pools.api).execute(context(auth, request), events(type, request, undefined, payload), work, operation) as Promise<T>;
  };
  const adminWrite = <T>(
    auth: Session,
    request: FastifyRequest,
    businessId: string,
    type: string,
    work: Parameters<TenantUnitOfWork["execute"]>[2],
  ) =>
    new TenantUnitOfWork(pools.admin).execute(
      tenantContext({
        businessId,
        actorId: auth.identity_id,
        role: "platform_admin",
        requestId: request.id,
      }),
      events(type, request),
      work,
    ) as Promise<T>;

  app.post("/auth/login", async (request, reply) => {
    if (!originOk(request))
      return fail(reply, request, 403, "FORBIDDEN", "Origin rejected");
    try {
      const body = credentials.parse(request.body),
        normalized = body.email.trim().toLowerCase();
      // Origin was checked first. Database failure and exhaustion both fail closed before hash work.
      const admitted = await pools.api.run(undefined, repo => repo.admitLogin(digestOpaqueToken(normalized))).catch(() => false);
      if (!admitted) {
        reply.header("retry-after", "900");
        return fail(reply, request, 429, "FORBIDDEN", "Too many login attempts");
      }
      const identity = await pools.api.run(undefined, (repo) =>
        repo.authIdentity(normalized),
      );
      const validPassword = await verifyLoginPassword(identity?.password_phc, body.password);
      if (
        !identity?.active ||
        identity.business_status === "suspended" ||
        !validPassword
      ) {
        await pools.api.run(
          identity?.business_id
            ? tenantContext({
                businessId: identity.business_id,
                actorId: identity.id,
                role: identity.role,
                requestId: request.id,
              })
            : undefined,
          (repo) =>
            repo.appendRuntimeAudit(identity?.business_id ?? null, {
              code: "auth.login_failed",
              outcome: "denied",
              source: "api",
              ...(identity?.id ? { actorId: identity.id } : {}),
              requestId: request.id,
            }),
        );
        return fail(
          reply,
          request,
          401,
          "UNAUTHENTICATED",
          "Invalid credentials",
        );
      }
      const token = randomBytes(32).toString("hex"),
        csrf = deriveSessionCsrf(token),
        now = Date.now();
      await pools.api.run(
        identity.business_id
          ? tenantContext({
              businessId: identity.business_id,
              actorId: identity.id,
              role: identity.role,
              requestId: request.id,
            })
          : undefined,
        async (repo) => {
          await repo.createSession({
            identityId: identity.id,
            tokenHash: digestOpaqueToken(token),
            csrfHash: digestOpaqueToken(csrf),
            absolute: new Date(now + absoluteTtl),
            idle: new Date(now + Math.min(idleTtl, absoluteTtl)),
          });
          await repo.appendRuntimeAudit(identity.business_id, {
            code: "auth.login",
            outcome: "success",
            source: "api",
            actorId: identity.id,
            requestId: request.id,
          });
        },
      );
      const c = sessionCookie(token);
      reply.setCookie(c.name, c.value, c);
      return { csrfToken: csrf };
    } catch {
      return fail(
        reply,
        request,
        401,
        "UNAUTHENTICATED",
        "Invalid credentials",
      );
    }
  });
  app.post("/auth/csrf", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!originOk(request) || request.headers["x-csrf-bootstrap"] !== "1")
      return fail(reply, request, 403, "FORBIDDEN", "Origin or bootstrap header rejected");
    if (!await session(request))
      return fail(reply, request, 401, "UNAUTHENTICATED", "Authentication required");
    // No rotation: legacy random tokens remain valid alongside this stable per-session value.
    return { csrfToken: deriveSessionCsrf(request.cookies[COOKIE]!) };
  });
  app.get("/auth/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = await session(request);
    return auth
      ? { role: auth.role, businessId: auth.business_id, identityId: auth.identity_id }
      : fail(reply, request, 401, "UNAUTHENTICATED", "Authentication required");
  });
  app.post("/auth/logout", async (request, reply) => {
    const auth = await mutation(request, reply);
    if (!auth) return;
    await pools.api.run(
      auth.business_id ? context(auth, request) : undefined,
      async (repo) => {
        await repo.revokeSession(digestOpaqueToken(request.cookies[COOKIE]!));
        await repo.appendRuntimeAudit(auth.business_id, {
          code: "auth.logout",
          outcome: "success",
          source: "api",
          actorId: auth.identity_id,
          requestId: request.id,
        });
      },
    );
    reply.clearCookie(COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
    return reply.code(204).send();
  });

  const requireAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
    mutate = false,
  ) => {
    const auth = mutate
      ? await mutation(request, reply)
      : await session(request);
    if (!auth) {
      if (!reply.sent)
        fail(reply, request, 401, "UNAUTHENTICATED", "Authentication required");
      return null;
    }
    if (auth.role !== "platform_admin") {
      fail(reply, request, 404, "NOT_FOUND", "Resource not found");
      return null;
    }
    return auth;
  };
  app.get("/admin/ai-instructions", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return {
      baseInstructions: RECEPTIONIST_SYSTEM_INSTRUCTIONS,
      ...await pools.admin.run(undefined, (repo) => repo.platformAiInstructions()),
    };
  });
  app.put("/admin/ai-instructions", async (request, reply) => {
    if (!(await requireAdmin(request, reply, true))) return;
    const body = PlatformAiInstructionsInputSchema.safeParse(request.body);
    if (!body.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid instructions");
    return {
      baseInstructions: RECEPTIONIST_SYSTEM_INSTRUCTIONS,
      ...await pools.admin.run(undefined, (repo) =>
        repo.updatePlatformAiInstructions(body.data.additionalInstructions, body.data.replyPacing)),
    };
  });
  app.get("/admin/businesses", async (request, reply) =>
    (await requireAdmin(request, reply))
      ? pools.admin.run(undefined, (repo) => repo.listBusinesses())
      : undefined,
  );
  app.post("/admin/businesses", async (request, reply) => {
    const auth = await requireAdmin(request, reply, true);
    if (!auth) return;
    try {
      const body = z
        .object({
          name: z.string().trim().min(1).max(160),
          userEmail: z.string().email(),
          initialPassword: z.string().min(16),
        })
        .parse(request.body);
      const id = randomUUID();
      const phc = await hash(body.initialPassword, {
        algorithm: Algorithm.Argon2id,
      });
      await adminWrite(auth, request, id, "business.created", (repo) =>
        repo.createBusinessUser({
          id,
          name: body.name,
          email: body.userEmail.trim().toLowerCase(),
          passwordPhc: phc,
        }),
      );
      return reply
        .code(201)
        .send(await pools.admin.run(undefined, (repo) => repo.business(id)));
    } catch {
      return fail(
        reply,
        request,
        400,
        "VALIDATION_FAILED",
        "Invalid business data",
      );
    }
  });
  app.put("/admin/businesses/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply, true);
    if (!auth) return;
    try {
      const { id } = request.params as { id: string };
      const { name } = z
        .object({ name: z.string().trim().min(1).max(160) })
        .parse(request.body);
      const changed = await adminWrite<unknown[]>(
        auth,
        request,
        id,
        "business.updated",
        (repo) => repo.renameBusiness(id, name),
      );
      return changed.length
        ? pools.admin.run(undefined, (repo) => repo.business(id))
        : fail(reply, request, 404, "NOT_FOUND", "Resource not found");
    } catch {
      return fail(
        reply,
        request,
        400,
        "VALIDATION_FAILED",
        "Invalid business data",
      );
    }
  });
  app.put("/admin/businesses/:id/user", async (request, reply) => {
    const auth = await requireAdmin(request, reply, true);
    if (!auth) return;
    try {
      const { id } = request.params as { id: string };
      const { password } = z
        .object({ password: z.string().min(16) })
        .parse(request.body);
      const phc = await hash(password, { algorithm: Algorithm.Argon2id });
      const ok = await adminWrite<boolean>(
        auth,
        request,
        id,
        "business_user.password_replaced",
        (repo) => repo.replaceBusinessPassword(id, phc),
      );
      return ok
        ? { replaced: true }
        : fail(reply, request, 404, "NOT_FOUND", "Resource not found");
    } catch {
      return fail(
        reply,
        request,
        400,
        "VALIDATION_FAILED",
        "Invalid user data",
      );
    }
  });
  app.put("/admin/businesses/:id/status", async (request, reply) => {
    const auth = await requireAdmin(request, reply, true);
    if (!auth) return;
    try {
      const { id } = request.params as { id: string };
      const { status } = z
        .object({ status: z.enum(["active", "suspended"]) })
        .parse(request.body);
      if (!(await pools.admin.run(undefined, (repo) => repo.business(id))))
        return fail(reply, request, 404, "NOT_FOUND", "Resource not found");
      await adminWrite(auth, request, id, `business.${status}`, (repo) =>
        repo.setBusinessStatus(id, status),
      );
      return pools.admin.run(undefined, (repo) => repo.business(id));
    } catch {
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid status");
    }
  });

  const requireTenant = async (
    request: FastifyRequest,
    reply: FastifyReply,
    mutate = false,
  ) => {
    const auth = mutate
      ? await mutation(request, reply)
      : await session(request);
    if (!auth) {
      if (!reply.sent)
        fail(reply, request, 401, "UNAUTHENTICATED", "Authentication required");
      return null;
    }
    if (auth.role !== "business_user" || !auth.business_id) {
      fail(reply, request, 403, "FORBIDDEN", "Business role required");
      return null;
    }
    return auth;
  };
  const closureMissing = new Error("Closure not found");
  const closureFailure = (error: unknown, request: FastifyRequest, reply: FastifyReply) =>
    error === closureMissing
      ? fail(reply, request, 404, "NOT_FOUND", "Closure not found")
      : error instanceof ResourceCatalogError && error.code === "FUTURE_APPOINTMENT_CONFLICT"
        ? fail(reply, request, 409, "CONFLICT", "Calendar change conflicts with future appointments")
        : fail(reply, request, 500, "INTERNAL_ERROR", "Calendar operation failed");
  const operationDto = (auth: Session, key: string, row: AppointmentOperationRow | null, absent = "not_found") =>
    AppointmentOperationReceiptSchema.parse({ key, businessId: auth.business_id, identityId: auth.identity_id,
      state: row?.state ?? absent, kind: row?.kind ?? null, target: row?.target ?? null, httpStatus: row?.result?.status ?? null,
      appointment: row?.state === "completed" ? row.result!.body : null,
      error: row?.state === "failed" ? z.object({ code: z.string(), message: z.string() }).parse(row.result!.body) : null });
  registerAppointmentOperationRoutes(app, { pools, requireTenant, context, fail, operationDto });
  registerAppointmentListRoute(app, { pools, requireTenant, context, fail });
  const sameAppointmentTerms = (expected: z.infer<typeof AvailabilitySlotSchema>["terms"], actual: z.infer<typeof AppointmentRecordSchema>["terms"]) =>
    Object.keys(expected).every(key => expected[key as keyof typeof expected] === actual[key as keyof typeof actual]);
  registerAppointmentRoutes(app, { pools, requireTenant, context, fail, tenantWrite, sameAppointmentTerms });
  registerBusinessClosureRoutes(app, {
    pools, requireTenant, context, fail, tenantWrite, closureFailure, closureMissing,
  });
  const resourceMissing = Symbol("resource not found");
  const resourceFailure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error === resourceMissing)
      return fail(reply, request, 404, "NOT_FOUND", "Resource not found");
    if (error instanceof ResourceCatalogError && error.code === "FUTURE_APPOINTMENT_CONFLICT")
      return fail(reply, request, 409, "CONFLICT", "Resource change conflicts with future appointments");
    if (error instanceof ResourceCatalogError)
      return error.code === "UNKNOWN_SERVICE"
        ? fail(reply, request, 400, "VALIDATION_FAILED", "Services must belong to this business")
        : fail(reply, request, 409, "CONFLICT", "Resource hours must fit business hours");
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "23505") return fail(reply, request, 409, "CONFLICT", "Resource name already exists");
    if (["22021", "22P05", "22P02", "22007", "22008", "23514"].includes(String(code)))
      return fail(reply, request, 400, "VALIDATION_FAILED", "Resource value cannot be stored");
    return fail(reply, request, 500, "INTERNAL_ERROR", "Resource operation failed");
  };
  registerResourceRoutes(app, {
    pools, requireTenant, context, fail, tenantWrite, resourceFailure, resourceMissing,
  });
  registerBusinessCalendarRoutes(app, {
    pools, requireTenant, context, fail, tenantWrite, closureFailure, resourceFailure,
  });
  const clientNotFound = Symbol("client not found");
  const clientFailure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error === clientNotFound)
      return fail(reply, request, 404, "NOT_FOUND", "Client not found");
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const constraint = error && typeof error === "object" && "constraint_name" in error ? error.constraint_name : undefined;
    if (code === "23505" && constraint === "clients_business_phone_key")
      return fail(reply, request, 409, "CONFLICT", "Client phone already exists");
    // PostgreSQL TEXT cannot represent NUL (or invalid Unicode encodings).
    if (code === "22021" || code === "22P05" || code === "23514")
      return fail(reply, request, 400, "VALIDATION_FAILED", "Client value cannot be stored");
    return fail(reply, request, 500, "INTERNAL_ERROR", "Client operation failed");
  };
  registerClientRoutes(app, {
    pools, requireTenant, context, fail, tenantWrite, clientFailure, clientNotFound,
  });
  const serviceNotFound = Symbol("service not found");
  const serviceFailure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error === serviceNotFound)
      return fail(reply, request, 404, "NOT_FOUND", "Service not found");
    if (error instanceof ResourceCatalogError && error.code === "FUTURE_APPOINTMENT_CONFLICT")
      return fail(reply, request, 409, "CONFLICT", "Service change conflicts with future appointments");
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "23505")
      return fail(reply, request, 409, "CONFLICT", "Service name already exists");
    // A valid domain duration may exceed PostgreSQL's integer representation.
    if (code === "22003")
      return fail(reply, request, 400, "VALIDATION_FAILED", "Service value cannot be stored");
    return fail(reply, request, 500, "INTERNAL_ERROR", "Service operation failed");
  };
  registerServiceRoutes(app, {
    pools, requireTenant, context, fail, tenantWrite, serviceFailure, serviceNotFound,
  });
  registerBusinessProfileRoutes(app, { pools, requireTenant, context, fail, tenantWrite });
  registerAgentSettingsRoutes(app, { pools, requireTenant, context, fail, tenantWrite });
  registerWhatsappRoutes(app, { pools, requireTenant, context, fail, tenantWrite, linkCodeKey });
  return app;
}

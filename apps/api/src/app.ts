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
import { makeSafeError, PlatformAiInstructionsInputSchema, AppointmentListQuerySchema, AppointmentRecordSchema, AppointmentAvailabilityQuerySchema, AvailabilitySlotSchema, ManualAppointmentCreateSchema, ManualAppointmentChangeSchema, ManualAppointmentNotesSchema, ManualAppointmentStateSchema, AppointmentOperationKeySchema, AppointmentOperationContextSchema, AppointmentOperationReceiptSchema } from "@agendia/contracts";
import {
  parseInstantMs,
  RECEPTIONIST_SYSTEM_INSTRUCTIONS,
  ServiceInputSchema,
  ResourceInputSchema,
  ClientInputSchema,
  WeeklyScheduleSchema,
  BusinessClosureInputSchema,
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
  app.get("/me/appointment-operations/:key", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const key = AppointmentOperationKeySchema.safeParse((request.params as { key: string }).key);
    if (!key.success || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid operation key");
    return pools.api.run(context(auth, request), async repo => {
      if (!await repo.lockAppointmentOperation(context(auth, request), key.data, false)) return operationDto(auth, key.data, null, "pending");
      return operationDto(auth, key.data, await repo.appointmentOperation(context(auth, request), key.data));
    });
  });
  app.post("/me/appointment-operations/:key/cancel", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = AppointmentOperationContextSchema.safeParse(request.body);
    const key = AppointmentOperationKeySchema.safeParse((request.params as { key: string }).key);
    if (!parsed.success || !key.success || parsed.data.key !== key.data || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid cancellation context");
    const row = await pools.api.run(context(auth, request), async repo => {
      await repo.lockAppointmentOperation(context(auth, request), key.data);
      const previous = await repo.appointmentOperation(context(auth, request), key.data);
      if (previous) return previous;
      if (parsed.data.target && !await repo.getAppointment(auth.business_id!, parsed.data.target)) return null;
      const cancelled: AppointmentOperationRow = { kind: parsed.data.kind, target: parsed.data.target, fingerprint: null, state: "cancelled", result: null };
      await repo.recordAppointmentOperation(context(auth, request), key.data, cancelled);
      return cancelled;
    });
    if (!row) return fail(reply, request, 404, "NOT_FOUND", "Appointment context not found");
    if (row.kind !== parsed.data.kind || row.target !== parsed.data.target)
      return fail(reply, request, 409, "CONFLICT", "Operation context differs");
    return operationDto(auth, key.data, row);
  });
  app.get("/me/appointments", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const parsed = AppointmentListQuerySchema.safeParse(request.query);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid appointment filters");
    try {
      const records = await pools.api.run(context(auth, request), repo => repo.listAppointments(auth.business_id!, parsed.data));
      return AppointmentRecordSchema.array().parse(records);
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment read failed");
    }
  });
  const sameAppointmentTerms = (expected: z.infer<typeof AvailabilitySlotSchema>["terms"], actual: z.infer<typeof AppointmentRecordSchema>["terms"]) =>
    Object.keys(expected).every(key => expected[key as keyof typeof expected] === actual[key as keyof typeof actual]);
  app.post("/me/appointments", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ManualAppointmentCreateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment request");
    try {
      const saved = await tenantWrite(auth, request, "appointment.created", async repo => {
        // Clock freshness starts AFTER the actual advisory lock wait, not at HTTP arrival.
        await repo.acquireBusinessCalendarLock(context(auth, request));
        const now = new Date().toISOString();
        const { serviceId, resourceId, startRaw, date, expectedTerms, clientId, newClient, notes } = parsed.data;
        if (clientId && !await repo.getClientById(clientId)) throw new AppointmentError("UNKNOWN_OWNED_ID");
        const slots = await repo.listAppointmentAvailability(auth.business_id!, { serviceId, resourceId, date }, { clock: () => now });
        const slot = slots.find(slot => slot.startMs === parseInstantMs(startRaw));
        if (!slot || !sameAppointmentTerms(expectedTerms, slot.terms))
          throw new AppointmentError("UNAVAILABLE");
        // Never persist request terms, confirmation as customer proof, or assigned-resource preference.
        return AppointmentRecordSchema.parse(await repo.createAppointment(auth.business_id!,
          { serviceId, resourceId, startRaw, ...(clientId ? { clientId } : { newClient }), ...(notes === undefined ? {} : { notes }) },
          { origin: "manual", now }));
      });
      return reply.code(201).send(saved);
    } catch (error) {
      if (error instanceof AppointmentOperationError) return reply.code(error.status).send(error.body);
      if (error instanceof AppointmentError) {
        if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment request");
        if (error.code === "UNKNOWN_OWNED_ID") return fail(reply, request, 404, "NOT_FOUND", "Appointment context not found");
        if (["INELIGIBLE_CATALOG", "UNAVAILABLE", "BUSY", "CLIENT_CONFLICT"].includes(error.code))
          return fail(reply, request, 409, "CONFLICT", "Appointment offer no longer available");
      }
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment creation failed");
    }
  });
  app.patch("/me/appointments/:appointmentId", async (request, reply) => {
    // Reserve the static GET-only URI before dynamic detail write authorization; no SQL/effects.
    if ((request.params as { appointmentId: string }).appointmentId === "availability")
      return fail(reply, request, 404, "NOT_FOUND", "Route not found");
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ManualAppointmentChangeSchema.safeParse(request.body);
    const params = z.object({ appointmentId: z.string().uuid().transform(id => id.toLowerCase()) }).strict().safeParse(request.params);
    if (!parsed.success || !params.success || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment change");
    const { appointmentId } = params.data;
    try {
      return await tenantWrite(auth, request, "appointment.updated", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        const now = new Date().toISOString();
        const current = await repo.getAppointment(auth.business_id!, appointmentId);
        if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
        const { serviceId, resourceId, startRaw, date, expectedTerms } = parsed.data;
        const storedNoOp = serviceId === current.terms.serviceId && resourceId === current.terms.resourceId
          && parseInstantMs(startRaw) === current.startMs;
        if (storedNoOp) {
          // Stored terms are only a precondition. DAL still validates state, clock and physical coherence.
          if (!sameAppointmentTerms(expectedTerms, current.terms)) throw new AppointmentError("UNAVAILABLE");
        } else {
          const slots = await repo.listAppointmentAvailability(auth.business_id!, { serviceId, resourceId, date }, { appointmentId, clock: () => now });
          const slot = slots.find(slot => slot.startMs === parseInstantMs(startRaw));
          if (!slot || !sameAppointmentTerms(expectedTerms, slot.terms)) throw new AppointmentError("UNAVAILABLE");
        }
        // No customer expression: preserve even a historical retired-resource preference.
        return AppointmentRecordSchema.parse(await repo.changeAppointment(auth.business_id!, appointmentId,
          { serviceId, resourceId, startRaw }, { now }));
      });
    } catch (error) {
      if (error instanceof AppointmentOperationError) return reply.code(error.status).send(error.body);
      if (error instanceof AppointmentError) {
        if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment change");
        if (error.code === "UNKNOWN_OWNED_ID") return fail(reply, request, 404, "NOT_FOUND", "Appointment context not found");
        if (["STATE_LOCKED", "STARTED_STRUCTURE_LOCKED", "INELIGIBLE_CATALOG", "UNAVAILABLE", "BUSY", "LEAD_TIME"].includes(error.code))
          return fail(reply, request, 409, "CONFLICT", "Appointment change no longer available");
      }
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment change failed");
    }
  });
  // Nonstructural actions deliberately bypass live catalogs and availability quotes.
  for (const suffix of ["notes", "state"] as const) {
    app.patch(`/me/appointments/:appointmentId/${suffix}`, async (request, reply) => {
      const auth = await requireTenant(request, reply, true);
      if (!auth) return;
      const parsed = (suffix === "notes" ? ManualAppointmentNotesSchema : ManualAppointmentStateSchema).safeParse(request.body);
      const params = z.object({ appointmentId: z.string().uuid().transform(id => id.toLowerCase()) }).strict().safeParse(request.params);
      if (!parsed.success || !params.success || !z.object({}).strict().safeParse(request.query).success)
        return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment action");
      try {
        return await tenantWrite(auth, request, "appointment.updated", async repo => {
          await repo.acquireBusinessCalendarLock(context(auth, request));
          const now = new Date().toISOString();
          const trusted = { actor: "businessAdmin", channel: "manual", now } as const;
          const value = parsed.data;
          const saved = "notes" in value
            ? await repo.setAppointmentNotes(auth.business_id!, params.data.appointmentId, value, trusted)
            : await repo.transitionAppointment(auth.business_id!, params.data.appointmentId, value.state,
              { ...trusted, confirmed: value.confirmed });
          return AppointmentRecordSchema.parse(saved);
        });
      } catch (error) {
        if (error instanceof AppointmentOperationError) return reply.code(error.status).send(error.body);
        if (error instanceof AppointmentError) {
          if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment action");
          if (error.code === "UNKNOWN_OWNED_ID") return fail(reply, request, 404, "NOT_FOUND", "Appointment not found");
          if (["NOTES_LOCKED", "STATE_LOCKED", "NOT_TRANSITION", "BEFORE_START", "CONFIRMATION_REQUIRED", "ATTENDANCE_FORBIDDEN"].includes(error.code))
            return fail(reply, request, 409, "CONFLICT", "Appointment action not allowed");
        }
        return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment action failed");
      }
    });
  }
  app.get("/me/appointments/availability", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const parsed = AppointmentAvailabilityQuerySchema.safeParse(request.query);
    // Fastify does not parse GET payloads; reject their framing as well as parsed bodies.
    const hasBody = request.body !== undefined || request.headers["transfer-encoding"] !== undefined
      || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0");
    if (!parsed.success || hasBody)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid availability query");
    // Business authorization precedes trusted reschedule context; this is not sender proof.
    const { appointmentId, ...query } = parsed.data;
    try {
      const slots = await pools.api.run(context(auth, request), repo => repo.listAppointmentAvailability(
        auth.business_id!, query, appointmentId === undefined ? {} : { appointmentId },
      ));
      return AvailabilitySlotSchema.array().parse(slots);
    } catch (error) {
      if (error instanceof AppointmentError) {
        if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid availability query");
        if (error.code === "UNKNOWN_OWNED_ID" || error.code === "INELIGIBLE_CATALOG")
          return fail(reply, request, 404, "NOT_FOUND", "Availability context not found");
        if (error.code === "STATE_LOCKED" || error.code === "STARTED_STRUCTURE_LOCKED")
          return fail(reply, request, 409, "CONFLICT", "Appointment cannot be rescheduled");
      }
      return fail(reply, request, 500, "INTERNAL_ERROR", "Availability read failed");
    }
  });
  app.get("/me/appointments/:appointmentId", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const params = z.object({ appointmentId: z.string().uuid().transform(id => id.toLowerCase()) }).strict().safeParse(request.params);
    if (!params.success || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid appointment ID or query");
    try {
      const record = await pools.api.run(context(auth, request), repo => repo.getAppointment(auth.business_id!, params.data.appointmentId));
      if (!record) return fail(reply, request, 404, "NOT_FOUND", "Appointment not found");
      return AppointmentRecordSchema.parse(record);
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment read failed");
    }
  });
  app.get("/me/business-calendar/closures", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    try {
      return await pools.api.run(context(auth, request), repo => repo.listBusinessClosures(auth.business_id!));
    } catch (error) { return closureFailure(error, request, reply); }
  });
  app.post("/me/business-calendar/closures", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = BusinessClosureInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid closure fields");
    try {
      const saved = await tenantWrite(auth, request, "business_closure.created", async repo => {
        // Repository owns the early lock and future-Confirmed closure guard.
        return repo.createBusinessClosure(auth.business_id!, parsed.data);
      });
      return reply.code(201).send(saved);
    } catch (error) { return closureFailure(error, request, reply); }
  });
  app.put("/me/business-calendar/closures/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = BusinessClosureInputSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid closure fields");
    try {
      return await tenantWrite(auth, request, "business_closure.updated", async repo => {
        const saved = await repo.updateBusinessClosure(auth.business_id!, params.data.id, parsed.data);
        if (!saved) throw closureMissing;
        return saved;
      });
    } catch (error) { return closureFailure(error, request, reply); }
  });
  app.delete("/me/business-calendar/closures/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid closure ID");
    try {
      await tenantWrite(auth, request, "business_closure.deleted", async repo => {
        if (!await repo.deleteBusinessClosure(auth.business_id!, params.data.id)) throw closureMissing;
      });
      return reply.code(204).send();
    } catch (error) { return closureFailure(error, request, reply); }
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
  app.get("/me/resources", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    try {
      return await pools.api.run(context(auth, request), repo => repo.listResources(auth.business_id!));
    } catch (error) { return resourceFailure(error, request, reply); }
  });
  app.post("/me/resources", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ResourceInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid resource fields");
    try {
      const saved = await tenantWrite(auth, request, "resource.created", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        return repo.createResource(auth.business_id!, parsed.data);
      });
      return reply.code(201).send(saved);
    } catch (error) { return resourceFailure(error, request, reply); }
  });
  app.put("/me/resources/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = ResourceInputSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid resource fields");
    try {
      return await tenantWrite(auth, request, "resource.updated", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        const saved = await repo.updateResource(auth.business_id!, params.data.id, parsed.data);
        if (!saved) throw resourceMissing;
        return saved;
      });
    } catch (error) { return resourceFailure(error, request, reply); }
  });
  app.delete("/me/resources/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid().transform(id => id.toLowerCase()) }).safeParse(request.params);
    if (!params.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid resource ID");
    try {
      await tenantWrite(auth, request, "resource.deleted", async repo => {
        if (!await repo.deleteResource(auth.business_id!, params.data.id)) throw resourceMissing;
      }, { id: params.data.id });
      return { id: params.data.id };
    } catch (error) { return resourceFailure(error, request, reply); }
  });
  app.put("/me/resources/:id/status", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(request.body);
    if (!params.success || !parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid resource status");
    try {
      return await tenantWrite(auth, request, "resource.status_changed", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        const saved = await repo.setResourceStatus(auth.business_id!, params.data.id, parsed.data.status);
        if (!saved) throw resourceMissing;
        return saved;
      });
    } catch (error) { return resourceFailure(error, request, reply); }
  });
  const calendarBody = z.object({ weeklySchedule: WeeklyScheduleSchema });
  app.get("/me/business-calendar", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    try {
      return await pools.api.run(context(auth, request), repo => repo.getBusinessCalendar(auth.business_id!));
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Calendar operation failed");
    }
  });
  app.put("/me/business-calendar", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = calendarBody.safeParse(request.body);
    if (!parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid weekly schedule");
    try {
      return await tenantWrite(auth, request, "business_calendar.updated", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        // Repository guards configured resource hours and future Confirmed intervals.
        return repo.saveBusinessCalendar(auth.business_id!, parsed.data.weeklySchedule);
      });
    } catch (error) {
      if (error instanceof ResourceCatalogError && error.code === "FUTURE_APPOINTMENT_CONFLICT")
        return closureFailure(error, request, reply);
      if (error instanceof ResourceCatalogError) return resourceFailure(error, request, reply);
      return fail(reply, request, 500, "INTERNAL_ERROR", "Calendar operation failed");
    }
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
  app.get("/me/clients", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const parsed = z.object({ q: z.string().optional() }).safeParse(request.query);
    if (!parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid client search");
    try {
      return await pools.api.run(context(auth, request), repo => repo.listClients(parsed.data.q));
    } catch (error) {
      return clientFailure(error, request, reply);
    }
  });
  app.post("/me/clients", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ClientInputSchema.safeParse(request.body);
    if (!parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid client fields");
    try {
      const saved = await tenantWrite(auth, request, "client.created", repo =>
        repo.createClient(auth.business_id!, parsed.data));
      return reply.code(201).send(saved);
    } catch (error) {
      return clientFailure(error, request, reply);
    }
  });
  app.put("/me/clients/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = ClientInputSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid client fields");
    try {
      return await tenantWrite(auth, request, "client.updated", async repo => {
        const saved = await repo.updateClient(auth.business_id!, params.data.id, parsed.data);
        if (!saved) throw clientNotFound;
        return saved;
      });
    } catch (error) {
      return clientFailure(error, request, reply);
    }
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
  app.get("/me/services", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    try {
      return await pools.api.run(context(auth, request), repo => repo.listServices());
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });
  app.post("/me/services", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ServiceInputSchema.safeParse(request.body);
    if (!parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid service fields");
    try {
      const saved = await tenantWrite(auth, request, "service.created", repo =>
        repo.createService(auth.business_id!, parsed.data));
      return reply.code(201).send(saved);
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });
  app.put("/me/services/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = ServiceInputSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid service fields");
    try {
      return await tenantWrite(auth, request, "service.updated", async repo => {
        const saved = await repo.updateService(auth.business_id!, params.data.id, parsed.data);
        if (!saved) throw serviceNotFound;
        return saved;
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });
  app.delete("/me/services/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid().transform(id => id.toLowerCase()) }).safeParse(request.params);
    if (!params.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid service ID");
    try {
      await tenantWrite(auth, request, "service.deleted", async repo => {
        if (!await repo.deleteService(auth.business_id!, params.data.id)) throw serviceNotFound;
      }, { id: params.data.id });
      return { id: params.data.id };
    } catch (error) { return serviceFailure(error, request, reply); }
  });
  app.put("/me/services/:id/status", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(request.body);
    if (!params.success || !parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid service status");
    try {
      return await tenantWrite(auth, request, "service.status_changed", async repo => {
        const saved = await repo.setServiceStatus(auth.business_id!, params.data.id, parsed.data.status);
        if (!saved) throw serviceNotFound;
        return saved;
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });
  registerBusinessProfileRoutes(app, { pools, requireTenant, context, fail, tenantWrite });
  registerAgentSettingsRoutes(app, { pools, requireTenant, context, fail, tenantWrite });
  registerWhatsappRoutes(app, { pools, requireTenant, context, fail, tenantWrite, linkCodeKey });
  return app;
}

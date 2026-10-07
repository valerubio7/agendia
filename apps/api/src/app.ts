import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuthService,
  digestOpaqueToken,
  sessionCookie,
  validateMutationRequest,
} from "@agendia/auth";
import { makeSafeError, PlatformAiInstructionsInputSchema } from "@agendia/contracts";
import {
  AI_SYSTEM_INSTRUCTIONS,
  AssistantConfigInputSchema,
  BusinessProfileSchema,
  ServiceInputSchema,
  ClientInputSchema,
  WeeklyScheduleSchema,
} from "@agendia/domain";
import {
  openLinkCode,
  tenantContext,
  TenantUnitOfWork,
  type createRuntimePools,
} from "@agendia/db";

const COOKIE = "__Host-agendia_session";
type Pools = ReturnType<typeof createRuntimePools>;
type Session = {
  session_id: string;
  identity_id: string;
  role: "platform_admin" | "business_user";
  business_id: string | null;
  csrf_sha256: string;
};
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
  ) => ({
    audit: {
      eventType: type,
      outcome: "success" as const,
      eventHash: createHash("sha256")
        .update(`${type}:${request.id}`)
        .digest("hex"),
    },
    outbox: { topic: type, stableKey, payload: {} },
  });
  const tenantWrite = <T>(
    auth: Session,
    request: FastifyRequest,
    type: string,
    work: Parameters<TenantUnitOfWork["execute"]>[2],
  ) =>
    new TenantUnitOfWork(pools.api).execute(
      context(auth, request),
      events(type, request),
      work,
    ) as Promise<T>;
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
      const identity = await pools.api.run(undefined, (repo) =>
        repo.authIdentity(normalized),
      );
      if (
        !identity?.active ||
        identity.business_status === "suspended" ||
        !(await verify(identity.password_phc, body.password))
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
        csrf = randomBytes(32).toString("hex"),
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
  app.get("/auth/session", async (request, reply) => {
    const auth = await session(request);
    return auth
      ? { role: auth.role, businessId: auth.business_id }
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
      baseInstructions: AI_SYSTEM_INSTRUCTIONS,
      ...await pools.admin.run(undefined, (repo) => repo.platformAiInstructions()),
    };
  });
  app.put("/admin/ai-instructions", async (request, reply) => {
    if (!(await requireAdmin(request, reply, true))) return;
    const body = PlatformAiInstructionsInputSchema.safeParse(request.body);
    if (!body.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid instructions");
    return {
      baseInstructions: AI_SYSTEM_INSTRUCTIONS,
      ...await pools.admin.run(undefined, (repo) =>
        repo.updatePlatformAiInstructions(body.data.additionalInstructions)),
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
        // Resource-hours and confirmed-booking guards join this locked UoW in T05/T09.
        return repo.saveBusinessCalendar(auth.business_id!, parsed.data.weeklySchedule);
      });
    } catch {
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
        const saved = await repo.updateClient(params.data.id, parsed.data);
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
        const saved = await repo.updateService(params.data.id, parsed.data);
        if (!saved) throw serviceNotFound;
        return saved;
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
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
        const saved = await repo.setServiceStatus(params.data.id, parsed.data.status);
        if (!saved) throw serviceNotFound;
        return saved;
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });
  app.get("/me/business-profile", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    return auth
      ? ((await pools.api.run(context(auth, request), (repo) =>
          repo.profile(),
        )) ?? {})
      : undefined;
  });
  app.put("/me/business-profile", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    try {
      const profile = BusinessProfileSchema.parse(request.body);
      await tenantWrite(auth, request, "profile.updated", (repo) =>
        repo.saveFullProfile(auth.business_id!, profile),
      );
      return profile;
    } catch {
      return fail(
        reply,
        request,
        400,
        "VALIDATION_FAILED",
        "Invalid profile fields",
      );
    }
  });
  app.get("/me/assistant", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    return auth
      ? ((await pools.api.run(context(auth, request), (repo) =>
          repo.assistant(),
        )) ?? {})
      : undefined;
  });
  app.put("/me/assistant", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    try {
      const parsed = AssistantConfigInputSchema.parse(request.body),
        { expectedRevision, ...fields } = parsed;
      const saved = await tenantWrite<object | null>(
        auth,
        request,
        "assistant.updated",
        (repo) =>
          repo.saveFullAssistant(auth.business_id!, fields, expectedRevision),
      );
      return (
        saved ?? fail(reply, request, 409, "CONFLICT", "Revision conflict")
      );
    } catch {
      return fail(
        reply,
        request,
        400,
        "VALIDATION_FAILED",
        "Invalid assistant fields",
      );
    }
  });
  const whatsapp = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    return (
      (await pools.api.run(context(auth, request), (repo) =>
        repo.whatsapp(),
      )) ?? {
        id: null,
        status: "link_required",
        linkedNumber: null,
        linkedAt: null,
        lastConnectedAt: null,
      }
    );
  };
  app.get("/me/whatsapp", whatsapp);
  app.get("/me/whatsapp/status", whatsapp);
  app.post("/me/whatsapp/link", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const assistant = await pools.api.run(context(auth, request), (repo) =>
      repo.assistant(),
    );
    if (!assistant || assistant.active !== true)
      return fail(
        reply,
        request,
        409,
        "CONFLICT",
        "Activate the assistant before linking WhatsApp",
      );
    const current = await pools.api.run(context(auth, request), (repo) =>
      repo.whatsapp(),
    );
    if (
      current &&
      !["link_required", "error"].includes(current.status as string)
    )
      return fail(
        reply,
        request,
        409,
        "CONFLICT",
        "WhatsApp connection already linked",
      );
    await tenantWrite(
      auth,
      request,
      "whatsapp.link_requested",
      async () => undefined,
    );
    return reply.code(202).send({ status: "linking" });
  });
  app.get("/me/whatsapp/link", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const code = await pools.api.run(context(auth, request), (repo) =>
      repo.currentLinkCode(new Date()),
    );
    if (!code || !linkCodeKey)
      return fail(reply, request, 404, "NOT_FOUND", "Link code not available");
    try {
      return { qr: openLinkCode(linkCodeKey, code) };
    } catch {
      return fail(reply, request, 404, "NOT_FOUND", "Link code not available");
    }
  });
  return app;
}

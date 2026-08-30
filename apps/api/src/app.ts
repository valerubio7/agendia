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
import { makeSafeError } from "@agendia/contracts";
import {
  AssistantConfigInputSchema,
  BusinessProfileSchema,
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
      | "CONFLICT",
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

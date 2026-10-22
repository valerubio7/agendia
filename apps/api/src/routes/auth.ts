import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { randomBytes } from "node:crypto";
import { digestOpaqueToken, deriveSessionCsrf, verifyLoginPassword, sessionCookie } from "@agendia/auth";
import { tenantContext } from "@agendia/db";
import { COOKIE, type HttpAuth } from "../auth/http-auth.ts";
import type { TenantRouteContext } from "./context.ts";

export function registerAuthRoutes(
  app: FastifyInstance,
  { pools, context, fail, originOk, session, mutation, absoluteTtl, idleTtl, credentials }: Pick<TenantRouteContext, "pools" | "context" | "fail"> & HttpAuth & {
    absoluteTtl: number;
    idleTtl: number;
    credentials: z.ZodType<{ email: string; password: string }>;
  },
) {
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
}

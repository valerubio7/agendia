import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ResponseTimingInputSchema } from "@agendia/contracts";
import type { TenantUnitOfWork } from "@agendia/db";
import type { Session, TenantRouteContext } from "./context.ts";

export function registerAdministrationRoutes(
  app: FastifyInstance,
  { pools, fail, requireAdmin, adminWrite }: Pick<TenantRouteContext, "pools" | "fail"> & {
    requireAdmin: TenantRouteContext["requireTenant"];
    adminWrite: <T>(
      auth: Session,
      request: FastifyRequest,
      businessId: string,
      type: string,
      work: Parameters<TenantUnitOfWork["execute"]>[2],
    ) => Promise<T>;
  },
) {
  app.get("/admin/response-timing", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return { responseTiming: await pools.admin.run(undefined, repo => repo.globalReplyPacing()) };
  });
  app.put("/admin/response-timing", async (request, reply) => {
    if (!(await requireAdmin(request, reply, true))) return;
    const body = ResponseTimingInputSchema.safeParse(request.body);
    if (!body.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid response timing");
    return { responseTiming: await pools.admin.run(undefined, repo => repo.updateResponseTiming(body.data.responseTiming)) };
  });
  app.get("/admin/businesses", async (request, reply) =>
    (await requireAdmin(request, reply))
      ? pools.admin.run(undefined, (repo) => repo.listBusinesses())
      : undefined,
  );
  app.get("/admin/registrations", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    reply.header("cache-control", "no-store");
    return pools.admin.run(undefined, repo => repo.listRegistrations());
  });
  for (const decision of ["approve", "reject"] as const) {
    app.post(`/admin/registrations/:id/${decision}`, async (request, reply) => {
      const auth = await requireAdmin(request, reply, true);
      if (!auth) return;
      const id = z.string().uuid().safeParse((request.params as { id: string }).id);
      if (!id.success) return fail(reply, request, 404, "NOT_FOUND", "Resource not found");
      try {
        const decided = await pools.admin.run(undefined, async repo => {
          const ok = await repo.decideRegistration(id.data, decision === "approve");
          if (ok) await repo.appendRuntimeAudit(null, { code: `auth.registration_${decision === "approve" ? "approved" : "rejected"}`, outcome: "success", source: "api", actorId: auth.identity_id, requestId: request.id });
          return ok;
        });
        return decided ? { decided: true } : fail(reply, request, 404, "NOT_FOUND", "Resource not found");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505")
          return fail(reply, request, 409, "CONFLICT", "Registration unavailable");
        return fail(reply, request, 500, "INTERNAL_ERROR", "Registration decision failed");
      }
    });
  }
  app.delete("/admin/businesses/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply, true);
    if (!auth) return;
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) return fail(reply, request, 404, "NOT_FOUND", "Resource not found");
    try {
      const deleted = await pools.admin.run(undefined, repo => repo.deleteBusiness(id.data, auth.session_id, auth.identity_id, request.id));
      return deleted ? { deleted: true } : fail(reply, request, 404, "NOT_FOUND", "Resource not found");
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Business deletion failed");
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
}

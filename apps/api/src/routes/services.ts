import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServiceInputSchema } from "@agendia/domain";
import type { RouteFailure, TenantRouteContext } from "./context.ts";

export function registerServiceRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, serviceFailure, serviceNotFound }: TenantRouteContext & {
    serviceFailure: RouteFailure;
    serviceNotFound: symbol;
  },
) {
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
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ResourceInputSchema } from "@agendia/domain";
import type { RouteFailure, TenantRouteContext } from "./context.ts";

export function registerResourceRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, resourceFailure, resourceMissing }: TenantRouteContext & {
    resourceFailure: RouteFailure;
    resourceMissing: symbol;
  },
) {
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
}

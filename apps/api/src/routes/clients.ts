import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ClientInputSchema } from "@agendia/domain";
import type { RouteFailure, TenantRouteContext } from "./context.ts";

export function registerClientRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, clientFailure, clientNotFound }: TenantRouteContext & {
    clientFailure: RouteFailure;
    clientNotFound: symbol;
  },
) {
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
}

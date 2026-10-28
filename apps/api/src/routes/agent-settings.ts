import type { FastifyInstance } from "fastify";
import { AgentConfigInputSchema } from "@agendia/domain";
import type { TenantRouteContext } from "./context.ts";

export function registerAgentSettingsRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite }: TenantRouteContext,
) {
  app.get("/me/agent", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    return auth
      ? ((await pools.api.run(context(auth, request), (repo) =>
          repo.agent(),
        )) ?? {})
      : undefined;
  });
  app.put("/me/agent", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    try {
      const parsed = AgentConfigInputSchema.parse(request.body),
        { expectedRevision, ...fields } = parsed;
      const saved = await tenantWrite<object | null>(
        auth,
        request,
        "agent.updated",
        (repo) =>
          repo.saveFullAgent(auth.business_id!, fields, expectedRevision),
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
        "Invalid agent fields",
      );
    }
  });
}

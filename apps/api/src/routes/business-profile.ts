import type { FastifyInstance } from "fastify";
import { BusinessProfileSchema } from "@agendia/domain";
import type { TenantRouteContext } from "./context.ts";

export function registerBusinessProfileRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite }: TenantRouteContext,
) {
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
}

import type { FastifyInstance } from "fastify";
import { ProfileService } from "@agendia/domain";
export function registerBusinessProfileRoutes(app: FastifyInstance, profiles: ProfileService, resolveTenant: (request: unknown) => string | null) {
  app.get("/me/business-profile", async (request, reply) => { const tenant = resolveTenant(request); return tenant ? profiles.get(tenant) ?? {} : reply.code(401).send({ code: "UNAUTHENTICATED" }); });
  app.put("/me/business-profile", async (request, reply) => { const tenant = resolveTenant(request); if (!tenant) return reply.code(401).send({ code: "UNAUTHENTICATED" }); try { return profiles.save(tenant, request.body); } catch { return reply.code(400).send({ code: "VALIDATION_FAILED", message: "Revisá los campos" }); } });
}

import type { FastifyInstance } from "fastify";
import type { AssistantConfigService } from "@agendia/domain";
export function registerAssistantRoutes(app: FastifyInstance, service: AssistantConfigService, resolveTenant: (request: unknown) => string | null) {
  app.get("/me/assistant", async (request, reply) => { const tenant = resolveTenant(request); return tenant ? service.get(tenant) ?? {} : reply.code(401).send({ code: "UNAUTHENTICATED" }); });
  app.put("/me/assistant", async (request, reply) => { const tenant = resolveTenant(request); if (!tenant) return reply.code(401).send({ code: "UNAUTHENTICATED" }); try { return service.save(tenant, request.body); } catch (error) { return reply.code(error instanceof Error && error.message === "Revision conflict" ? 409 : 400).send({ code: "VALIDATION_FAILED" }); } });
}

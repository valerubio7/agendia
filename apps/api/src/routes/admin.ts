import type { FastifyInstance } from "fastify";
import type { AdministrationService } from "@agendia/domain";

export function registerAdminRoutes(app: FastifyInstance, administration: AdministrationService, requireAdmin: (request: unknown) => boolean) {
  app.get("/admin/businesses", async (request, reply) => requireAdmin(request) ? administration.listProjections() : reply.code(404).send({ code: "NOT_FOUND" }));
  app.post("/admin/businesses", async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(404).send({ code: "NOT_FOUND" });
    const body = request.body as { name: string; userEmail: string; initialPassword: string };
    const business = await administration.createBusiness({ ...body, requestId: request.id });
    return reply.code(201).send(administration.project(business.id));
  });
  app.put("/admin/businesses/:id/status", async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(404).send({ code: "NOT_FOUND" });
    const { id } = request.params as { id: string }; const { status } = request.body as { status: "active" | "suspended" };
    try { administration.setBusinessStatus(id, status, request.id); return administration.project(id); }
    catch { return reply.code(404).send({ code: "NOT_FOUND" }); }
  });
}

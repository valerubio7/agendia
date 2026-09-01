import type { FastifyInstance } from "fastify";
import {
  projectWhatsAppStatus,
  type WhatsAppConnectionService,
} from "@agendia/domain";

export interface WhatsAppLinkController {
  requestLink(tenant: string): void;
  consumeLink(tenant: string, now: number): string | null;
  now(): number;
}

export function registerWhatsAppRoutes(
  app: FastifyInstance,
  service: WhatsAppConnectionService,
  resolveTenant: (request: unknown) => string | null,
  linking?: WhatsAppLinkController,
) {
  const status = async (
    request: unknown,
    reply: {
      code: (status: number) => {
        send: (body: Record<string, unknown>) => unknown;
      };
    },
  ) => {
    const tenant = resolveTenant(request);
    if (!tenant) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    const connection = service.ensureConnection(tenant);
    return {
      id: connection.id,
      status: projectWhatsAppStatus(connection.state),
      linkedNumber: connection.linkedNumber,
      linkedAt: connection.linkedAt,
      lastConnectedAt: connection.lastConnectedAt,
    };
  };
  app.get("/me/whatsapp", status);
  app.get("/me/whatsapp/status", status);
  if (linking) {
    app.post("/me/whatsapp/link", async (request, reply) => {
      const tenant = resolveTenant(request);
      if (!tenant) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        linking.requestLink(tenant);
        return reply.code(202).send({ status: "linking" });
      } catch {
        return reply.code(409).send({ code: "CONFLICT" });
      }
    });
    app.get("/me/whatsapp/link", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const tenant = resolveTenant(request);
      if (!tenant) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const qr = linking.consumeLink(tenant, linking.now());
      return qr ? { qr } : reply.code(404).send({ code: "NOT_FOUND" });
    });
  }
}

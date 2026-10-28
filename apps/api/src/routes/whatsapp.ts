import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { openLinkCode } from "@agendia/db";
import type { TenantRouteContext } from "./context.ts";

export function registerWhatsappRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, linkCodeKey }: TenantRouteContext & { linkCodeKey: Buffer | undefined },
) {
  const whatsapp = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    return (
      (await pools.api.run(context(auth, request), (repo) =>
        repo.whatsapp(),
      )) ?? {
        id: null,
        status: "link_required",
        linkedNumber: null,
        linkedAt: null,
        lastConnectedAt: null,
      }
    );
  };
  app.get("/me/whatsapp", whatsapp);
  app.get("/me/whatsapp/status", whatsapp);
  app.post("/me/whatsapp/link", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const agent = await pools.api.run(context(auth, request), (repo) =>
      repo.agent(),
    );
    if (!agent || agent.active !== true)
      return fail(
        reply,
        request,
        409,
        "CONFLICT",
        "Activate the agent before linking WhatsApp",
      );
    const current = await pools.api.run(context(auth, request), (repo) =>
      repo.whatsapp(),
    );
    if (
      current &&
      !["link_required", "error"].includes(current.status as string)
    )
      return fail(
        reply,
        request,
        409,
        "CONFLICT",
        "WhatsApp connection already linked",
      );
    await tenantWrite(
      auth,
      request,
      "whatsapp.link_requested",
      async () => undefined,
    );
    return reply.code(202).send({ status: "linking" });
  });
  app.get("/me/whatsapp/link", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const code = await pools.api.run(context(auth, request), (repo) =>
      repo.currentLinkCode(new Date()),
    );
    if (!code || !linkCodeKey)
      return fail(reply, request, 404, "NOT_FOUND", "Link code not available");
    try {
      return { qr: openLinkCode(linkCodeKey, code) };
    } catch {
      return fail(reply, request, 404, "NOT_FOUND", "Link code not available");
    }
  });
}

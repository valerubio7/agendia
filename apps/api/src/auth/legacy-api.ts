import Fastify from "fastify";
import type { AuthService } from "@agendia/auth";

export function legacyApi(auth: AuthService) {
  const app = Fastify({ logger: false });
  app.post("/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    if (!body?.email || !body.password)
      return reply.code(400).send({ code: "VALIDATION_FAILED" });
    try {
      return reply.send({
        csrfToken: (await auth.login(body.email, body.password)).csrfToken,
      });
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED" });
    }
  });
  app.post("/auth/logout", async (_request, reply) => reply.code(204).send());
  // The legacy in-memory HTTP adapter never issues/authenticates cookies; do not expose recovery.
  app.post("/auth/csrf", async (_request, reply) => reply.header("cache-control", "no-store").code(401).send({ code: "UNAUTHENTICATED" }));
  app.get("/auth/session", async (_request, reply) =>
    reply.code(401).send({ code: "UNAUTHENTICATED" }),
  );
  return app;
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { digestOpaqueToken, validateMutationRequest } from "@agendia/auth";
import type { Session, TenantRouteContext } from "../routes/context.ts";

export const COOKIE = "__Host-agendia_session";

export function createHttpAuth(
  { pools, expectedOrigin, idleTtl, fail }: Pick<TenantRouteContext, "pools" | "fail"> & {
    expectedOrigin: string;
    idleTtl: number;
  },
) {
  const originOk = (request: FastifyRequest) =>
    request.headers.origin === expectedOrigin;
  const session = async (request: FastifyRequest): Promise<Session | null> => {
    const token = request.cookies[COOKIE];
    if (!token) return null;
    const found = await pools.api.run(
      undefined,
      (repo) =>
        repo.session(digestOpaqueToken(token)) as Promise<Session | null>,
    );
    if (found)
      await pools.api.run(undefined, (repo) =>
        repo.touchSession(found.session_id, new Date(Date.now() + idleTtl)),
      );
    return found;
  };
  const mutation = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await session(request);
    const csrf = request.headers["x-csrf-token"] as string | undefined;
    if (!auth) {
      fail(reply, request, 401, "UNAUTHENTICATED", "Authentication required");
      return null;
    }
    if (
      !validateMutationRequest({
        origin: request.headers.origin ?? "",
        expectedOrigin,
        csrfHeader: csrf ?? "",
        sessionToken: request.cookies[COOKIE]!,
        csrfSession:
          csrf && auth.csrf_sha256 === digestOpaqueToken(csrf) ? csrf : "",
      })
    ) {
      fail(reply, request, 403, "FORBIDDEN", "Mutation protection failed");
      return null;
    }
    return auth;
  };
  return { originOk, session, mutation };
}

export type HttpAuth = ReturnType<typeof createHttpAuth>;

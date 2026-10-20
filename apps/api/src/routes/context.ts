import type { FastifyReply, FastifyRequest } from "fastify";
import type { createRuntimePools, TenantContext, TenantUnitOfWork } from "@agendia/db";

export type Session = {
  session_id: string;
  identity_id: string;
  role: "platform_admin" | "business_user";
  business_id: string | null;
  csrf_sha256: string;
};

export type RouteFailure = (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) => FastifyReply;

export interface TenantRouteContext {
  pools: ReturnType<typeof createRuntimePools>;
  requireTenant: (
    request: FastifyRequest,
    reply: FastifyReply,
    mutate?: boolean,
  ) => Promise<Session | null>;
  context: (auth: Session, request: FastifyRequest) => TenantContext;
  fail: (
    reply: FastifyReply,
    request: FastifyRequest,
    status: number,
    code:
      | "VALIDATION_FAILED"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INTERNAL_ERROR",
    message: string,
  ) => FastifyReply;
  tenantWrite: <T>(
    auth: Session,
    request: FastifyRequest,
    type: string,
    work: Parameters<TenantUnitOfWork["execute"]>[2],
    payload?: object,
  ) => Promise<T>;
}

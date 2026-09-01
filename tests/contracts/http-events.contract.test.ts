import { describe, expect, test } from "bun:test";
import {
  AuditEventSchema,
  PRODUCT_HTTP_ROUTES,
  SafeErrorSchema,
  buildAuditEvent,
  makeSafeError,
  toOpenApiDocument,
} from "../../packages/contracts/src/index.ts";
import { AtomicUnitOfWork } from "../../packages/domain/src/unit-of-work.ts";

describe("safe HTTP and event contracts", () => {
  test("returns a uniform field error without leaking provider details", () => {
    const error = makeSafeError(
      "VALIDATION_FAILED",
      "Datos inválidos",
      "req-7",
      { email: "Formato inválido", apiKey: "sk-secret" },
    );
    expect(SafeErrorSchema.parse(error)).toEqual({
      code: "VALIDATION_FAILED",
      message: "Datos inválidos",
      requestId: "req-7",
      details: { email: "Formato inválido", apiKey: "[REDACTED]" },
    });
  });

  test("generates OpenAPI from the same safe response schema", () => {
    const document = toOpenApiDocument();
    expect(document.components.schemas.SafeError.required).toEqual([
      "code",
      "message",
      "requestId",
    ]);
    expect(document.openapi).toBe("3.1.0");
  });

  test("allowlists v1 routes and contractually excludes conversation or message viewers", () => {
    expect(PRODUCT_HTTP_ROUTES).toContain("/me/whatsapp/status");
    expect(
      PRODUCT_HTTP_ROUTES.some((route) =>
        /conversations|messages|search/i.test(route),
      ),
    ).toBe(false);
  });

  test("allowlists audit metadata and preserves tenant scope", () => {
    const event = buildAuditEvent({
      businessId: "11111111-1111-4111-8111-111111111111",
      actorId: "user-1",
      type: "assistant.updated",
      outcome: "success",
      requestId: "req-8",
      metadata: { revision: 2, password: "secret" },
    });
    expect(AuditEventSchema.parse(event).metadata).toEqual({
      revision: 2,
      password: "[REDACTED]",
    });
  });
});

describe("atomic mutation, audit and outbox", () => {
  test("commits all staged effects together", async () => {
    const committed: string[] = [];
    const uow = new AtomicUnitOfWork((effects) => {
      committed.push(...effects);
    });
    await uow.execute(async (stage) => {
      stage("business:update");
      stage("audit:business.updated");
      stage("outbox:business.updated");
    });
    expect(committed).toEqual([
      "business:update",
      "audit:business.updated",
      "outbox:business.updated",
    ]);
  });

  test("commits no partial effects after a domain failure", async () => {
    const committed: string[] = [];
    const uow = new AtomicUnitOfWork((effects) => {
      committed.push(...effects);
    });
    await expect(
      uow.execute(async (stage) => {
        stage("business:update");
        throw new Error("forced failure");
      }),
    ).rejects.toThrow("forced failure");
    expect(committed.length).toBe(0);
  });
});

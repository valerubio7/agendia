import { describe, expect, test } from "bun:test";
import {
  AuditEventSchema,
  CatalogDeletionAckSchema,
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

  test("allowlists service catalog and lifecycle paths in derived OpenAPI", () => {
    const document = toOpenApiDocument();
    for (const route of ["/me/services", "/me/services/:id", "/me/services/:id/status"]) {
      expect(PRODUCT_HTTP_ROUTES as readonly string[]).toContain(route);
      expect(document.paths).toHaveProperty(route);
    }
    expect(PRODUCT_HTTP_ROUTES.some(route => /services.*delete/.test(route))).toBe(false); // DELETE uses the existing detail URI.
  });

  test("allowlists resource catalog lifecycle paths without booking operations", () => {
    const routes = ["/me/resources", "/me/resources/:id", "/me/resources/:id/status"];
    expect(PRODUCT_HTTP_ROUTES.filter(route => route.includes("resources")) as readonly string[]).toEqual(routes);
    for (const route of routes) expect(toOpenApiDocument().paths).toHaveProperty(route);
  });

  test("allowlists only client registry paths, not delete/archive/notes", () => {
    const document = toOpenApiDocument();
    for (const route of ["/me/clients", "/me/clients/:id"]) {
      expect(PRODUCT_HTTP_ROUTES as readonly string[]).toContain(route);
      expect(document.paths).toHaveProperty(route);
    }
    expect(PRODUCT_HTTP_ROUTES.filter(route => route.includes("clients"))).toEqual([
      "/me/clients", "/me/clients/:id",
    ]);
  });

  test("allowlists the weekly calendar and global closure collection/entity routes", () => {
    expect(PRODUCT_HTTP_ROUTES as readonly string[]).toContain("/me/business-calendar");
    expect(toOpenApiDocument().paths).toHaveProperty("/me/business-calendar");
    const routes = ["/me/business-calendar", "/me/business-calendar/closures", "/me/business-calendar/closures/:id"] as const;
    expect(PRODUCT_HTTP_ROUTES.filter(route => route.includes("calendar"))).toEqual([...routes]);
    for (const route of routes) expect(toOpenApiDocument().paths).toHaveProperty(route);
  });

  test("documents only catalog DELETE methods with UUID acknowledgements and safe errors", () => {
    const document = toOpenApiDocument();
    for (const route of ["/me/services/:id", "/me/resources/:id"]) {
      expect(document.paths[route]).toHaveProperty("delete.parameters", [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }]);
      expect(document.paths[route]).toHaveProperty("delete.responses.200.content.application/json.schema.$ref", "#/components/schemas/CatalogDeletionAck");
      for (const status of [400, 401, 403, 404, 409, 500])
        expect(document.paths[route]).toHaveProperty(`delete.responses.${status}.content.application/json.schema.$ref`, "#/components/schemas/SafeError");
    }
    expect(document.components.schemas).toHaveProperty("CatalogDeletionAck", { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", format: "uuid" } } });
    const id = "11111111-1111-4111-8111-111111111111";
    expect(CatalogDeletionAckSchema.parse({ id })).toEqual({ id });
    expect(CatalogDeletionAckSchema.safeParse({ id, status: "active" }).success).toBe(false);
    expect(CatalogDeletionAckSchema.safeParse({ id: "bad" }).success).toBe(false);
    expect(Object.entries(document.paths).filter(([, item]) => "delete" in item).map(([route]) => route)).toEqual(["/me/services/:id", "/me/resources/:id"]);
    expect(document.paths["/me/clients/:id"]).not.toHaveProperty("delete");
    expect(PRODUCT_HTTP_ROUTES.some(route => /appointments|booking|slots/.test(route))).toBe(false);
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

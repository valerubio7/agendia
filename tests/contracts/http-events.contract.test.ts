import { describe, expect, test } from "bun:test";
import {
  AppointmentRecordSchema,
  type AppointmentRecord,
  AuditEventSchema,
  CatalogDeletionAckSchema,
  PRODUCT_HTTP_ROUTES,
  SafeErrorSchema,
  buildAuditEvent,
  makeSafeError,
  toOpenApiDocument,
} from "../../packages/contracts/src/index.ts";
import * as httpContracts from "../../packages/contracts/src/http.ts";
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
    expect(PRODUCT_HTTP_ROUTES.filter(route => /appointments|booking|slots/.test(route))).toEqual(["/me/appointments", "/me/appointments/:appointmentId", "/me/appointments/:appointmentId/notes", "/me/appointments/:appointmentId/state", "/me/appointments/availability"]);
  });

  test("appointment reads expose exactly two GETs and the strict stored projection", () => {
    const document = toOpenApiDocument();
    for (const route of ["/me/appointments", "/me/appointments/:appointmentId"]) {
      expect(Object.keys(document.paths[route]!)).toEqual(route === "/me/appointments" ? ["get", "post"] : ["get", "patch"]);
      for (const status of [400, 401, 403, 404, 500])
        expect(document.paths[route]).toHaveProperty(`get.responses.${status}.content.application/json.schema.$ref`, "#/components/schemas/SafeError");
    }
    expect(document.paths["/me/appointments"]).toHaveProperty("get.parameters", [
      { name: "clientId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
      ...["from", "to"].map(name => ({ name, in: "query", required: false, schema: { type: "string", format: "date-time" }, description: name === "from" ? "Inclusive start instant (explicit offset)" : "Exclusive start instant (explicit offset); must be after from" })),
    ]);
    expect(document.paths["/me/appointments/:appointmentId"]).toHaveProperty("get.parameters", [{ name: "appointmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }]);
    expect(document.paths["/me/appointments"]).toHaveProperty("get.responses.200.content.application/json.schema", { type: "array", items: { $ref: "#/components/schemas/AppointmentRecord" } });
    expect(document.paths["/me/appointments/:appointmentId"]).toHaveProperty("get.responses.200.content.application/json.schema.$ref", "#/components/schemas/AppointmentRecord");
    const id = "11111111-1111-4111-8111-111111111111";
    const record: AppointmentRecord = { id, client: { id, firstName: "Current", lastName: "Name", phone: "+5491123456789" }, startsAt: "2026-06-01T00:00:00-03:00", startMs: 1780282800000, endMs: 1780283700000,
      terms: { serviceId: id, serviceName: "Frozen", resourceId: id, resourceName: "Frozen", durationMinutes: 15, priceArs: 0 }, state: "cancelled", origin: "ai", notes: null, customerResourcePreference: id };
    expect(AppointmentRecordSchema.parse(record)).toEqual(record);
    const schema = document.components.schemas.AppointmentRecord;
    expect(schema.required).toEqual(Object.keys(record));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties!)).toEqual(Object.keys(record));
    for (const invalid of [{ ...record, clock: 1 }, { ...record, role: "customer" }, { ...record, id: undefined }, { ...record, startMs: 1n }, { ...record, terms: { ...record.terms, priceArs: Infinity } }, { ...record, terms: { ...record.terms, priceArs: -1 } }, { ...record, client: { ...record.client, phone: undefined } }])
      expect(AppointmentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  test("availability has one static GET and strict query/slot contracts matching D2", () => {
    const document = toOpenApiDocument();
    const route = "/me/appointments/availability";
    expect(document.paths).toHaveProperty(route);
    const schemas = httpContracts;
    expect(schemas.AvailabilitySlotSchema).toBeDefined();
    expect(schemas.AppointmentAvailabilityQuerySchema).toBeDefined();
    const id = "11111111-1111-4111-8111-111111111111";
    const slot = { start: "0001-01-01T00:00:00-03:00", startMs: -62135586000000, endMs: -62135584200000, resourceId: id,
      terms: { serviceId: id, serviceName: "Saved", resourceId: id, resourceName: "Saved", durationMinutes: 30, priceArs: 12.34567 } };
    expect(schemas.AvailabilitySlotSchema!.safeParse(slot).success).toBe(true);
    expect(schemas.AvailabilitySlotSchema!.safeParse({ ...slot, start: "9999-12-31T23:45:00-03:00", startMs: 253402310700000, endMs: 253402312500000 }).success).toBe(true);
    for (const invalid of [{ ...slot, clock: 1 }, { ...slot, startMs: Infinity }, { ...slot, endMs: Number.MAX_SAFE_INTEGER + 1 }, { ...slot, start: "0000-01-01T00:00:00Z" }, { ...slot, terms: { ...slot.terms, priceArs: -1 } }, { ...slot, terms: { ...slot.terms, role: "customer" } }])
      expect(schemas.AvailabilitySlotSchema!.safeParse(invalid).success).toBe(false);
    expect(schemas.AppointmentAvailabilityQuerySchema!.safeParse({ serviceId: id, date: "0001-01-01", resourceId: id, appointmentId: id }).success).toBe(true);
    for (const query of [{ date: "2099-06-01" }, { serviceId: id }, { serviceId: id, date: "0000-01-01" }, { serviceId: id, date: "2099-02-30" }, { serviceId: id, date: "2099-06-01", clock: "past" }])
      expect(schemas.AppointmentAvailabilityQuerySchema!.safeParse(query).success).toBe(false);
    const path = document.paths[route]!;
    expect(Object.keys(path)).toEqual(["get"]);
    expect(path).toHaveProperty("get.responses.200.content.application/json.schema", { type: "array", items: { $ref: "#/components/schemas/AvailabilitySlot" } });
    for (const status of [400, 401, 403, 404, 409, 500])
      expect(path).toHaveProperty(`get.responses.${status}.content.application/json.schema.$ref`, "#/components/schemas/SafeError");
    expect(path).toHaveProperty("get.parameters", [
      { name: "serviceId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
      { name: "date", in: "query", required: true, schema: { type: "string", format: "date", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } },
      ...["resourceId", "appointmentId"].map(name => ({ name, in: "query", required: false, schema: { type: "string", format: "uuid" } })),
    ]);
    expect(document.components.schemas).toHaveProperty("AvailabilitySlot.additionalProperties", false);
  });

  test("manual POST alone documents explicit confirmation, client XOR and safe errors", () => {
    const document = toOpenApiDocument(), path = document.paths["/me/appointments"];
    expect(path).toHaveProperty("post.responses.201.content.application/json.schema.$ref", "#/components/schemas/AppointmentRecord");
    for (const status of [400, 401, 403, 404, 409, 500])
      expect(path).toHaveProperty(`post.responses.${status}.content.application/json.schema.$ref`, "#/components/schemas/SafeError");
    expect(document.components.schemas).toHaveProperty("ManualAppointmentCreate.oneOf", [
      { required: ["clientId"], not: { required: ["newClient"] } },
      { required: ["newClient"], not: { required: ["clientId"] } },
    ]);
    for (const route of ["/me/appointments", "/me/appointments/:appointmentId", "/me/appointments/availability"])
      for (const method of ["patch", "put", "delete"])
        if (route !== "/me/appointments/:appointmentId" || method !== "patch") expect(document.paths[route]).not.toHaveProperty(method);
    expect(httpContracts).toHaveProperty("ManualAppointmentCreateSchema");
  });

  test("structural PATCH alone has strict confirmation/terms preconditions and safe responses", () => {
    const document = toOpenApiDocument(), path = document.paths["/me/appointments/:appointmentId"];
    expect(path).toHaveProperty("patch.requestBody.content.application/json.schema.$ref", "#/components/schemas/ManualAppointmentChange");
    expect(path).toHaveProperty("patch.responses.200.content.application/json.schema.$ref", "#/components/schemas/AppointmentRecord");
    for (const status of [400, 401, 403, 404, 409, 500])
      expect(path).toHaveProperty(`patch.responses.${status}.content.application/json.schema.$ref`, "#/components/schemas/SafeError");
    expect(document.components.schemas).toHaveProperty("ManualAppointmentChange.additionalProperties", false);
    expect(document.components.schemas).toHaveProperty("ManualAppointmentChange.required", ["serviceId", "resourceId", "startRaw", "date", "expectedTerms", "confirmed"]);
    expect(Object.entries(document.paths).filter(([, item]) => "patch" in item).map(([route]) => route)).toEqual(["/me/appointments/:appointmentId", "/me/appointments/:appointmentId/notes", "/me/appointments/:appointmentId/state"]);
  });

  test("nonstructural suffixes export strict notes and explicitly confirmed final-state contracts", () => {
    const document = toOpenApiDocument();
    for (const [suffix, name] of [["notes", "ManualAppointmentNotes"], ["state", "ManualAppointmentState"]]) {
      const path = document.paths[`/me/appointments/:appointmentId/${suffix}`];
      expect(path).toBeDefined();
      expect(Object.keys(path!)).toEqual(["patch"]);
      expect(path).toHaveProperty("patch.requestBody.content.application/json.schema.$ref", `#/components/schemas/${name}`);
      expect(path).toHaveProperty("patch.responses.200.content.application/json.schema.$ref", "#/components/schemas/AppointmentRecord");
      for (const status of [400, 401, 403, 404, 409, 500])
        expect(path).toHaveProperty(`patch.responses.${status}.content.application/json.schema.$ref`, "#/components/schemas/SafeError");
      expect(document.components.schemas).toHaveProperty(`${name}.additionalProperties`, false);
    }
    expect(httpContracts).toHaveProperty("ManualAppointmentNotesSchema");
    expect(httpContracts).toHaveProperty("ManualAppointmentStateSchema");
    const notes = httpContracts.ManualAppointmentNotesSchema, state = httpContracts.ManualAppointmentStateSchema;
    for (const value of [null, "", "x".repeat(10000)]) expect(notes.safeParse({ notes: value }).success).toBe(true);
    for (const value of [{}, { notes: 1 }, { notes: "bad\u0000" }, { notes: null, actor: "businessAdmin" }]) expect(notes.safeParse(value).success).toBe(false);
    for (const value of ["cancelled", "done", "no_show"]) expect(state.safeParse({ state: value, confirmed: true }).success).toBe(true);
    for (const value of [{ state: "confirmed", confirmed: true }, { state: "pending", confirmed: true }, { state: "done" }, { state: "done", confirmed: "true" }, { state: "done", confirmed: false }, { state: "done", confirmed: true, now: "2099-01-01" }]) expect(state.safeParse(value).success).toBe(false);
    expect(document.components.schemas).toHaveProperty("ManualAppointmentState.properties.confirmed.const", true);
    expect(document.components.schemas).toHaveProperty("ManualAppointmentState.properties.state.enum", ["done", "cancelled", "no_show"]);
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

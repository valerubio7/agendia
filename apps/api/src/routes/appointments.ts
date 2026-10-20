import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AppointmentListQuerySchema,
  AppointmentRecordSchema,
  AppointmentAvailabilityQuerySchema,
  AvailabilitySlotSchema,
  ManualAppointmentCreateSchema,
  ManualAppointmentChangeSchema,
  ManualAppointmentNotesSchema,
  ManualAppointmentStateSchema,
  AppointmentOperationKeySchema,
  AppointmentOperationContextSchema,
  type AppointmentOperationReceiptSchema,
} from "@agendia/contracts";
import { parseInstantMs } from "@agendia/domain";
import { AppointmentError, AppointmentOperationError, type AppointmentOperationRow } from "@agendia/db";
import type { Session, TenantRouteContext } from "./context.ts";

type AppointmentReadContext = Pick<TenantRouteContext, "pools" | "requireTenant" | "context" | "fail">;

export function registerAppointmentOperationRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, operationDto }: AppointmentReadContext & {
    operationDto: (
      auth: Session,
      key: string,
      row: AppointmentOperationRow | null,
      absent?: string,
    ) => z.infer<typeof AppointmentOperationReceiptSchema>;
  },
) {
  app.get("/me/appointment-operations/:key", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const key = AppointmentOperationKeySchema.safeParse((request.params as { key: string }).key);
    if (!key.success || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid operation key");
    return pools.api.run(context(auth, request), async repo => {
      if (!await repo.lockAppointmentOperation(context(auth, request), key.data, false)) return operationDto(auth, key.data, null, "pending");
      return operationDto(auth, key.data, await repo.appointmentOperation(context(auth, request), key.data));
    });
  });
  app.post("/me/appointment-operations/:key/cancel", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = AppointmentOperationContextSchema.safeParse(request.body);
    const key = AppointmentOperationKeySchema.safeParse((request.params as { key: string }).key);
    if (!parsed.success || !key.success || parsed.data.key !== key.data || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid cancellation context");
    const row = await pools.api.run(context(auth, request), async repo => {
      await repo.lockAppointmentOperation(context(auth, request), key.data);
      const previous = await repo.appointmentOperation(context(auth, request), key.data);
      if (previous) return previous;
      if (parsed.data.target && !await repo.getAppointment(auth.business_id!, parsed.data.target)) return null;
      const cancelled: AppointmentOperationRow = { kind: parsed.data.kind, target: parsed.data.target, fingerprint: null, state: "cancelled", result: null };
      await repo.recordAppointmentOperation(context(auth, request), key.data, cancelled);
      return cancelled;
    });
    if (!row) return fail(reply, request, 404, "NOT_FOUND", "Appointment context not found");
    if (row.kind !== parsed.data.kind || row.target !== parsed.data.target)
      return fail(reply, request, 409, "CONFLICT", "Operation context differs");
    return operationDto(auth, key.data, row);
  });
}

export function registerAppointmentListRoute(
  app: FastifyInstance,
  { pools, requireTenant, context, fail }: AppointmentReadContext,
) {
  app.get("/me/appointments", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const parsed = AppointmentListQuerySchema.safeParse(request.query);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid appointment filters");
    try {
      const records = await pools.api.run(context(auth, request), repo => repo.listAppointments(auth.business_id!, parsed.data));
      return AppointmentRecordSchema.array().parse(records);
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment read failed");
    }
  });
}

export function registerAppointmentRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, sameAppointmentTerms }: TenantRouteContext & {
    sameAppointmentTerms: (
      expected: z.infer<typeof AvailabilitySlotSchema>["terms"],
      actual: z.infer<typeof AppointmentRecordSchema>["terms"],
    ) => boolean;
  },
) {
  app.post("/me/appointments", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ManualAppointmentCreateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment request");
    try {
      const saved = await tenantWrite(auth, request, "appointment.created", async repo => {
        // Clock freshness starts AFTER the actual advisory lock wait, not at HTTP arrival.
        await repo.acquireBusinessCalendarLock(context(auth, request));
        const now = new Date().toISOString();
        const { serviceId, resourceId, startRaw, date, expectedTerms, clientId, newClient, notes } = parsed.data;
        if (clientId && !await repo.getClientById(clientId)) throw new AppointmentError("UNKNOWN_OWNED_ID");
        const slots = await repo.listAppointmentAvailability(auth.business_id!, { serviceId, resourceId, date }, { clock: () => now });
        const slot = slots.find(slot => slot.startMs === parseInstantMs(startRaw));
        if (!slot || !sameAppointmentTerms(expectedTerms, slot.terms))
          throw new AppointmentError("UNAVAILABLE");
        // Never persist request terms, confirmation as customer proof, or assigned-resource preference.
        return AppointmentRecordSchema.parse(await repo.createAppointment(auth.business_id!,
          { serviceId, resourceId, startRaw, ...(clientId ? { clientId } : { newClient }), ...(notes === undefined ? {} : { notes }) },
          { origin: "manual", now }));
      });
      return reply.code(201).send(saved);
    } catch (error) {
      if (error instanceof AppointmentOperationError) return reply.code(error.status).send(error.body);
      if (error instanceof AppointmentError) {
        if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment request");
        if (error.code === "UNKNOWN_OWNED_ID") return fail(reply, request, 404, "NOT_FOUND", "Appointment context not found");
        if (["INELIGIBLE_CATALOG", "UNAVAILABLE", "BUSY", "CLIENT_CONFLICT"].includes(error.code))
          return fail(reply, request, 409, "CONFLICT", "Appointment offer no longer available");
      }
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment creation failed");
    }
  });
  app.patch("/me/appointments/:appointmentId", async (request, reply) => {
    // Reserve the static GET-only URI before dynamic detail write authorization; no SQL/effects.
    if ((request.params as { appointmentId: string }).appointmentId === "availability")
      return fail(reply, request, 404, "NOT_FOUND", "Route not found");
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = ManualAppointmentChangeSchema.safeParse(request.body);
    const params = z.object({ appointmentId: z.string().uuid().transform(id => id.toLowerCase()) }).strict().safeParse(request.params);
    if (!parsed.success || !params.success || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment change");
    const { appointmentId } = params.data;
    try {
      return await tenantWrite(auth, request, "appointment.updated", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        const now = new Date().toISOString();
        const current = await repo.getAppointment(auth.business_id!, appointmentId);
        if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
        const { serviceId, resourceId, startRaw, date, expectedTerms } = parsed.data;
        const storedNoOp = serviceId === current.terms.serviceId && resourceId === current.terms.resourceId
          && parseInstantMs(startRaw) === current.startMs;
        if (storedNoOp) {
          // Stored terms are only a precondition. DAL still validates state, clock and physical coherence.
          if (!sameAppointmentTerms(expectedTerms, current.terms)) throw new AppointmentError("UNAVAILABLE");
        } else {
          const slots = await repo.listAppointmentAvailability(auth.business_id!, { serviceId, resourceId, date }, { appointmentId, clock: () => now });
          const slot = slots.find(slot => slot.startMs === parseInstantMs(startRaw));
          if (!slot || !sameAppointmentTerms(expectedTerms, slot.terms)) throw new AppointmentError("UNAVAILABLE");
        }
        // No customer expression: preserve even a historical retired-resource preference.
        return AppointmentRecordSchema.parse(await repo.changeAppointment(auth.business_id!, appointmentId,
          { serviceId, resourceId, startRaw }, { now }));
      });
    } catch (error) {
      if (error instanceof AppointmentOperationError) return reply.code(error.status).send(error.body);
      if (error instanceof AppointmentError) {
        if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment change");
        if (error.code === "UNKNOWN_OWNED_ID") return fail(reply, request, 404, "NOT_FOUND", "Appointment context not found");
        if (["STATE_LOCKED", "STARTED_STRUCTURE_LOCKED", "INELIGIBLE_CATALOG", "UNAVAILABLE", "BUSY", "LEAD_TIME"].includes(error.code))
          return fail(reply, request, 409, "CONFLICT", "Appointment change no longer available");
      }
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment change failed");
    }
  });
  // Nonstructural actions deliberately bypass live catalogs and availability quotes.
  for (const suffix of ["notes", "state"] as const) {
    app.patch(`/me/appointments/:appointmentId/${suffix}`, async (request, reply) => {
      const auth = await requireTenant(request, reply, true);
      if (!auth) return;
      const parsed = (suffix === "notes" ? ManualAppointmentNotesSchema : ManualAppointmentStateSchema).safeParse(request.body);
      const params = z.object({ appointmentId: z.string().uuid().transform(id => id.toLowerCase()) }).strict().safeParse(request.params);
      if (!parsed.success || !params.success || !z.object({}).strict().safeParse(request.query).success)
        return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment action");
      try {
        return await tenantWrite(auth, request, "appointment.updated", async repo => {
          await repo.acquireBusinessCalendarLock(context(auth, request));
          const now = new Date().toISOString();
          const trusted = { actor: "businessAdmin", channel: "manual", now } as const;
          const value = parsed.data;
          const saved = "notes" in value
            ? await repo.setAppointmentNotes(auth.business_id!, params.data.appointmentId, value, trusted)
            : await repo.transitionAppointment(auth.business_id!, params.data.appointmentId, value.state,
              { ...trusted, confirmed: value.confirmed });
          return AppointmentRecordSchema.parse(saved);
        });
      } catch (error) {
        if (error instanceof AppointmentOperationError) return reply.code(error.status).send(error.body);
        if (error instanceof AppointmentError) {
          if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid manual appointment action");
          if (error.code === "UNKNOWN_OWNED_ID") return fail(reply, request, 404, "NOT_FOUND", "Appointment not found");
          if (["NOTES_LOCKED", "STATE_LOCKED", "NOT_TRANSITION", "BEFORE_START", "CONFIRMATION_REQUIRED", "ATTENDANCE_FORBIDDEN"].includes(error.code))
            return fail(reply, request, 409, "CONFLICT", "Appointment action not allowed");
        }
        return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment action failed");
      }
    });
  }
  app.get("/me/appointments/availability", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const parsed = AppointmentAvailabilityQuerySchema.safeParse(request.query);
    // Fastify does not parse GET payloads; reject their framing as well as parsed bodies.
    const hasBody = request.body !== undefined || request.headers["transfer-encoding"] !== undefined
      || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0");
    if (!parsed.success || hasBody)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid availability query");
    // Business authorization precedes trusted reschedule context; this is not sender proof.
    const { appointmentId, ...query } = parsed.data;
    try {
      const slots = await pools.api.run(context(auth, request), repo => repo.listAppointmentAvailability(
        auth.business_id!, query, appointmentId === undefined ? {} : { appointmentId },
      ));
      return AvailabilitySlotSchema.array().parse(slots);
    } catch (error) {
      if (error instanceof AppointmentError) {
        if (error.code === "INVALID_INPUT") return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid availability query");
        if (error.code === "UNKNOWN_OWNED_ID" || error.code === "INELIGIBLE_CATALOG")
          return fail(reply, request, 404, "NOT_FOUND", "Availability context not found");
        if (error.code === "STATE_LOCKED" || error.code === "STARTED_STRUCTURE_LOCKED")
          return fail(reply, request, 409, "CONFLICT", "Appointment cannot be rescheduled");
      }
      return fail(reply, request, 500, "INTERNAL_ERROR", "Availability read failed");
    }
  });
  app.get("/me/appointments/:appointmentId", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    const params = z.object({ appointmentId: z.string().uuid().transform(id => id.toLowerCase()) }).strict().safeParse(request.params);
    if (!params.success || !z.object({}).strict().safeParse(request.query).success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid appointment ID or query");
    try {
      const record = await pools.api.run(context(auth, request), repo => repo.getAppointment(auth.business_id!, params.data.appointmentId));
      if (!record) return fail(reply, request, 404, "NOT_FOUND", "Appointment not found");
      return AppointmentRecordSchema.parse(record);
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Appointment read failed");
    }
  });
}

import { describe, expect, test } from "bun:test";
import {
  AppointmentStateSchema,
  AppointmentOriginSchema,
  AppointmentTermsSnapshotSchema,
  canEditAppointmentNotes,
  canTransitionAppointment,
  captureAppointmentTerms,
  type AppointmentState,
  type AppointmentActionContext,
} from "../../packages/domain/src/appointment-lifecycle.ts";

import * as domain from "../../packages/domain/src/index.ts";

const states = ["confirmed", "done", "cancelled", "no_show"] as const;
const origins = ["manual", "ai"] as const;
const start = "2026-06-01T10:00:00.001Z";
const appointment = { state: "confirmed" as AppointmentState, origin: "manual" as const, startsAt: start };
const admin: AppointmentActionContext = {
  actor: "businessAdmin", channel: "manual", confirmed: true, now: start,
};
const service = {
  id: "a1234567-89ab-4cde-8fab-0123456789ab", name: "Consulta",
  durationMinutes: 30, priceArs: 0,
};
const resource = { id: "b1234567-89ab-4cde-8fab-0123456789ab", name: "Ana" };
const terms = {
  serviceId: service.id, serviceName: service.name,
  resourceId: resource.id, resourceName: resource.name,
  durationMinutes: service.durationMinutes, priceArs: service.priceArs,
};

describe("appointment vocabulary and explicit transitions", () => {
  test("publishes the pure contracts through the domain entry point", () => {
    expect(domain.AppointmentStateSchema).toBe(AppointmentStateSchema);
    expect(domain.AppointmentOriginSchema).toBe(AppointmentOriginSchema);
    expect(domain.AppointmentTermsSnapshotSchema).toBe(AppointmentTermsSnapshotSchema);
    expect(domain.canEditAppointmentNotes).toBe(canEditAppointmentNotes);
    expect(domain.canTransitionAppointment).toBe(canTransitionAppointment);
    expect(domain.captureAppointmentTerms).toBe(captureAppointmentTerms);
  });

  test("accepts exactly four states and two origins", () => {
    for (const state of states) expect(AppointmentStateSchema.parse(state)).toBe(state);
    for (const origin of origins) expect(AppointmentOriginSchema.parse(origin)).toBe(origin);
    for (const invalid of ["pending", "Confirmed", "no-show", "noshow", "completed", "", null]) {
      expect(AppointmentStateSchema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of ["Manual", "AI", "automatic", "customer", null]) {
      expect(AppointmentOriginSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test("complete matrix denies reapply, reopen and every final-state action", () => {
    for (const origin of origins) {
      for (const state of states) {
        expect(canEditAppointmentNotes(state)).toEqual(state === "confirmed"
          ? { ok: true } : { ok: false, error: "notes_locked" });
        for (const target of states) {
          expect(canTransitionAppointment({ ...appointment, origin, state }, target, admin))
            .toEqual(state === "confirmed" && target !== "confirmed"
              ? { ok: true } : { ok: false, error: "not_transition" });
        }
      }
    }
  });

  test("cast-malformed targets cannot become final transitions", () => {
    for (const target of ["pending", "unknown", null]) {
      expect(canTransitionAppointment(appointment, target as AppointmentState, admin))
        .toEqual({ ok: false, error: "not_transition" });
    }
  });

  test("unknown channels cannot bypass manual acknowledgement", () => {
    expect(canTransitionAppointment(appointment, "cancelled", {
      ...admin, channel: "unknown" as AppointmentActionContext["channel"], confirmed: false,
    })).toEqual({ ok: false, error: "invalid_action_context" });
  });

  test("unknown actors fail closed without changing verified platform admin cancellation", () => {
    expect(canTransitionAppointment(appointment, "cancelled", {
      ...admin, actor: "unknown" as AppointmentActionContext["actor"],
    })).toEqual({ ok: false, error: "invalid_action_context" });
    expect(canTransitionAppointment(appointment, "cancelled", { ...admin, actor: "platformAdmin" }))
      .toEqual({ ok: true });
  });

  test("elapsed time alone does not mutate state or initiate attendance", () => {
    const input = Object.freeze({ ...appointment });
    expect(canTransitionAppointment(input, "confirmed", { ...admin, now: "2027-01-01T00:00:00Z" }))
      .toEqual({ ok: false, error: "not_transition" });
    expect(input).toEqual(appointment);
  });
});

describe("attendance policy", () => {
  test("business admin can mark attendance only at or after exact start", () => {
    for (const target of ["done", "no_show"] as const) {
      for (const now of ["2026-06-01T10:00:00.001Z", "2026-06-01T07:00:00.001-03:00", "2026-06-01T10:00:00.002Z"]) {
        expect(canTransitionAppointment(appointment, target, { ...admin, now })).toEqual({ ok: true });
      }
      for (const now of ["2026-06-01T09:59:59Z", "2026-06-01T10:00:00.000Z"]) {
        expect(canTransitionAppointment(appointment, target, { ...admin, now }))
          .toEqual({ ok: false, error: "before_start" });
      }
    }
  });

  test("invalid start or injected clock fails closed rather than normalizing", () => {
    const invalidTimes = ["invalid", "2026-02-30T10:00:00Z", "2026-06-01T10:00:00", "2026-06-01T10:00:00.0011Z"];
    for (const target of ["done", "no_show"] as const) {
      for (const invalid of invalidTimes) {
        expect(canTransitionAppointment({ ...appointment, startsAt: invalid }, target, admin))
          .toEqual({ ok: false, error: "invalid_attendance_time" });
        expect(canTransitionAppointment(appointment, target, { ...admin, now: invalid }))
          .toEqual({ ok: false, error: "invalid_attendance_time" });
      }
    }
  });

  test("creation origin never grants attendance; AI channel is denied even for admin", () => {
    for (const origin of origins) {
      for (const target of ["done", "no_show"] as const) {
        for (const actor of ["customer", "ai", "platformAdmin"] as const) {
          for (const channel of ["manual", "ai"] as const) {
            expect(canTransitionAppointment({ ...appointment, origin }, target, { ...admin, actor, channel }))
              .toEqual({ ok: false, error: "attendance_forbidden" });
          }
        }
        expect(canTransitionAppointment({ ...appointment, origin }, target, { ...admin, channel: "ai" }))
          .toEqual({ ok: false, error: "attendance_forbidden" });
      }
    }
  });
});

describe("explicit final action acknowledgement", () => {
  test("manual actions require literal true for both creation origins", () => {
    for (const origin of origins) {
      for (const target of ["cancelled", "done", "no_show"] as const) {
        for (const confirmed of [undefined, false, "true", 1, null]) {
          expect(canTransitionAppointment({ ...appointment, origin }, target, { ...admin, confirmed }))
            .toEqual({ ok: false, error: "confirmation_required" });
        }
        expect(canTransitionAppointment({ ...appointment, origin }, target, admin)).toEqual({ ok: true });
      }
    }
  });

  test("confirmed cancellation has no cutoff; clear AI requests need no redundant acknowledgement", () => {
    for (const origin of origins) {
      for (const now of ["2020-01-01T00:00:00Z", start, "2030-01-01T00:00:00Z", "invalid"]) {
        for (const actor of ["businessAdmin", "customer", "ai"] as const) {
          expect(canTransitionAppointment({ ...appointment, origin }, "cancelled", {
            actor, channel: "ai", now,
          })).toEqual({ ok: true });
        }
        expect(canTransitionAppointment({ ...appointment, origin }, "cancelled", { ...admin, now }))
          .toEqual({ ok: true });
        expect(canTransitionAppointment({ ...appointment, origin }, "cancelled", {
          ...admin, actor: "customer", now,
        })).toEqual({ ok: true });
        expect(canTransitionAppointment({ ...appointment, origin }, "cancelled", {
          ...admin, actor: "customer", confirmed: false, now,
        })).toEqual({ ok: false, error: "confirmation_required" });
      }
    }
  });
});

describe("initial server catalog terms", () => {
  test("captures detached immutable terms without mutating catalog or storing client names", () => {
    const catalogService = Object.freeze({ ...service, description: "server", clientName: "not terms" });
    const catalogResource = Object.freeze({ ...resource, clientName: "not terms" });
    const snapshot = captureAppointmentTerms(catalogService, catalogResource);
    expect(snapshot).toEqual(terms);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(catalogService).toEqual({ ...service, description: "server", clientName: "not terms" });
    expect(catalogResource).toEqual({ ...resource, clientName: "not terms" });
    const mutableService = { ...service };
    const mutableResource = { ...resource };
    const detached = captureAppointmentTerms(mutableService, mutableResource);
    mutableService.priceArs = 999;
    mutableResource.name = "Changed";
    expect(detached).toEqual(terms);
  });

  test("uses catalog fields only, not appointment overrides or unknown client fields", () => {
    const snapshot = captureAppointmentTerms({ ...service, termsOverride: { priceArs: 999 } }, resource);
    expect(snapshot.priceArs).toBe(0);
    expect(AppointmentTermsSnapshotSchema.parse({ ...terms, clientName: "private", termsOverride: {} }))
      .toEqual(terms);
  });

  test("canonicalizes IDs, preserves validated label semantics and has no text or price caps", () => {
    const label = "Á漢🧑🏽‍💻".repeat(6400);
    const snapshot = captureAppointmentTerms({
      ...service, id: service.id.toUpperCase(), name: `  ${label}  `, durationMinutes: 15, priceArs: 1.123456789,
    }, { ...resource, id: resource.id.toUpperCase(), name: label });
    expect(snapshot).toEqual({ ...terms, serviceName: label, resourceName: label, durationMinutes: 15, priceArs: 1.123456789 });
    expect(captureAppointmentTerms({ ...service, durationMinutes: 15 * 10000, priceArs: Number.MAX_VALUE }, resource).priceArs)
      .toBe(Number.MAX_VALUE);
  });

  test("rejects invalid IDs, labels, nonpositive or off-grid duration and invalid ARS price", () => {
    for (const field of ["serviceId", "resourceId"] as const) {
      for (const value of ["not-a-uuid", "", null]) {
        expect(AppointmentTermsSnapshotSchema.safeParse({ ...terms, [field]: value }).success).toBe(false);
      }
    }
    for (const field of ["serviceName", "resourceName"] as const) {
      for (const value of ["", " \t\n", null, 123]) {
        expect(AppointmentTermsSnapshotSchema.safeParse({ ...terms, [field]: value }).success).toBe(false);
      }
    }
    for (const durationMinutes of [0, -15, 14, 15.5, Infinity, NaN]) {
      expect(AppointmentTermsSnapshotSchema.safeParse({ ...terms, durationMinutes }).success).toBe(false);
    }
    for (const priceArs of [-1, Infinity, -Infinity, NaN]) {
      expect(AppointmentTermsSnapshotSchema.safeParse({ ...terms, priceArs }).success).toBe(false);
    }
    for (const field of Object.keys(terms)) {
      const missing: Record<string, unknown> = { ...terms };
      delete missing[field];
      expect(AppointmentTermsSnapshotSchema.safeParse(missing).success).toBe(false);
    }
    expect(() => captureAppointmentTerms({ ...service, priceArs: -1 }, resource)).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import {
  prepareAppointmentChange,
  resolveCustomerResourcePreference,
  type AppointmentChangeCandidate,
  type AppointmentChangeContext,
  type AppointmentChangeFacts,
} from "../../packages/domain/src/appointment-changes.ts";
import * as domain from "../../packages/domain/src/index.ts";
import { captureAppointmentTerms, type WeeklySchedule } from "../../packages/domain/src/index.ts";

const serviceId = "a1234567-89ab-4cde-8fab-0123456789ab";
const resourceId = "b1234567-89ab-4cde-8fab-0123456789ab";
const otherServiceId = "c1234567-89ab-4cde-8fab-0123456789ab";
const otherResourceId = "d1234567-89ab-4cde-8fab-0123456789ab";
const service = { id: serviceId, name: "Saved service", durationMinutes: 30, priceArs: 100, status: "active" as const };
const resource = { id: resourceId, name: "Saved resource", status: "active" as const, serviceIds: [serviceId, otherServiceId] };
const terms = captureAppointmentTerms(service, resource);
const startsAt = "2026-06-01T09:00:00-03:00";
const current: AppointmentChangeFacts = {
  state: "confirmed", origin: "manual", startsAt, terms, customerResourcePreference: resourceId,
};
const allWeek: WeeklySchedule = Object.fromEntries(
  Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]),
);
const context: AppointmentChangeContext = {
  now: "2026-06-01T11:30:00Z", businessHours: allWeek, resourceHours: allWeek,
};
const candidate: AppointmentChangeCandidate = { service, resource, startsAt };
const changedService = { ...service, id: otherServiceId, name: "New service", durationMinutes: 60, priceArs: 250 };
const changedResource = { ...resource, id: otherResourceId, name: "New resource" };
const variants: AppointmentChangeCandidate[] = [
  { ...candidate, service: changedService },
  { ...candidate, resource: changedResource },
  { ...candidate, startsAt: "2026-06-01T13:00:00Z" },
];
function accepted(input = candidate, clock = context, facts = current) {
  const result = prepareAppointmentChange(facts, input, clock);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("structural change policy", () => {
  test("exports both pure helpers from the domain entry point", () => {
    expect(domain.prepareAppointmentChange).toBe(prepareAppointmentChange);
    expect(domain.resolveCustomerResourcePreference).toBe(resolveCustomerResourcePreference);
  });

  test("all rejection variants are frozen and cannot have ok or error rewritten", () => {
    const rejections = [
      ["state_locked", prepareAppointmentChange({ ...current, state: "done" }, candidate, context)],
      ["invalid_change_input", prepareAppointmentChange(current, candidate, { ...context, now: "bad" })],
      ["invalid_change_input", prepareAppointmentChange(current, {
        ...variants[1]!, resource: { ...changedResource, serviceIds: ["bad"] },
      }, context)],
      ["started_structure_locked", prepareAppointmentChange(current, variants[1]!, { ...context, now: startsAt })],
      ["ineligible_catalog", prepareAppointmentChange(current, {
        ...variants[1]!, service: { ...service, status: "suspended" },
      }, context)],
      ["structural_unavailable", prepareAppointmentChange(current, variants[1]!, { ...context, resourceHours: {} })],
      ["lead_time", prepareAppointmentChange(current, {
        ...candidate, startsAt: "2026-06-01T12:15:00Z",
      }, context)],
    ] as const;
    for (const [error, result] of rejections) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Reflect.set(result, "ok", true)).toBe(false);
      expect(Reflect.set(result, "error", "rewritten")).toBe(false);
      expect(result).toEqual({ ok: false, error });
    }
  });

  test("final states deny every edit for both origins", () => {
    for (const origin of ["manual", "ai"] as const) {
      for (const state of ["done", "cancelled", "no_show"] as const) {
        for (const input of [candidate, ...variants]) {
          expect(prepareAppointmentChange({ ...current, origin, state }, input, context))
            .toEqual({ ok: false, error: "state_locked" });
        }
      }
      for (const input of variants) expect(accepted(input, context, { ...current, origin }).changed).toBe(true);
    }
  });

  test("locks each actual change at and after CURRENT start, not candidate start", () => {
    for (const input of variants) {
      expect(accepted(input, { ...context, now: "2026-06-01T11:59:59.999Z" }).changed).toBe(true);
      for (const now of ["2026-06-01T12:00:00Z", "2026-06-01T12:00:00.001Z"]) {
        expect(prepareAppointmentChange(current, input, { ...context, now }))
          .toEqual({ ok: false, error: "started_structure_locked" });
      }
    }
  });

  test("semantic no-op preserves raw start and all terms, even after start or catalog suspension", () => {
    const input = {
      startsAt: "2026-06-01T12:00:00Z",
      service: { ...service, id: serviceId.toUpperCase(), name: "Renamed", priceArs: 999, durationMinutes: 90, status: "suspended" as const },
      resource: { ...resource, id: resourceId.toUpperCase(), name: "Renamed resource", status: "suspended" as const },
    };
    const result = accepted(input, { ...context, now: "2027-01-01T00:00:00Z", businessHours: {} });
    expect(result.changed).toBe(false);
    expect(result.startsAt).toBe(startsAt);
    expect(result.terms).toEqual(terms);
    expect(result.customerResourcePreference).toBe(resourceId);
  });

  test("invalid exact start or clock, UUID and catalog terms fail closed", () => {
    for (const invalid of ["bad", "2026-02-30T12:00:00Z", "2026-06-01T12:00:00", "2026-06-01T12:00:00.0001Z"]) {
      expect(prepareAppointmentChange({ ...current, startsAt: invalid }, candidate, context).ok).toBe(false);
      expect(prepareAppointmentChange(current, { ...candidate, startsAt: invalid }, context).ok).toBe(false);
      expect(prepareAppointmentChange(current, candidate, { ...context, now: invalid }).ok).toBe(false);
    }
    for (const patch of [{ id: "bad" }, { durationMinutes: 14 }, { priceArs: -1 }, { name: " " }]) {
      expect(prepareAppointmentChange(current, { ...candidate, service: { ...service, ...patch } }, context))
        .toEqual({ ok: false, error: "invalid_change_input" });
    }
  });

  test("unchanged-start edits inside one hour use structural checks, not lead time", () => {
    for (const input of variants.slice(0, 2)) expect(accepted(input).changed).toBe(true);
    const moved = { ...candidate, startsAt: "2026-06-01T13:00:00Z" };
    expect(prepareAppointmentChange(current, moved, { ...context, now: "2026-06-01T12:00:00.001Z" }).ok).toBe(false);
    // Keep the current booking upcoming while isolating the new-start lead boundary.
    const laterCurrent = { ...current, startsAt: "2026-06-01T15:00:00Z" };
    expect(prepareAppointmentChange(laterCurrent, moved, { ...context, now: "2026-06-01T12:00:00.001Z" }))
      .toEqual({ ok: false, error: "lead_time" });
    expect(accepted(moved, { ...context, now: "2026-06-01T12:00:00Z" }, laterCurrent).changed).toBe(true);
    expect(accepted({ ...candidate, startsAt: "2099-01-01T12:00:00Z" }).changed).toBe(true);
  });

  test("actual structural edits require active, assigned service and resource", () => {
    for (const input of variants) {
      for (const invalid of [
        { ...input, service: { ...input.service, status: "suspended" as const } },
        { ...input, resource: { ...input.resource, status: "suspended" as const } },
        { ...input, resource: { ...input.resource, serviceIds: [] } },
      ]) expect(prepareAppointmentChange(current, invalid, context)).toEqual({ ok: false, error: "ineligible_catalog" });
    }
  });
});

describe("agreed terms and effective interval", () => {
  test("same service retains saved terms; real resource change alone updates its snapshot", () => {
    const renamed = { ...service, name: "Renamed service", durationMinutes: 90, priceArs: 999 };
    const result = accepted({ ...candidate, service: renamed, resource: changedResource });
    expect(result.terms).toEqual({ ...terms, resourceId: otherResourceId, resourceName: "New resource" });
    const dated = accepted({ ...candidate, service: renamed, resource: { ...resource, name: "Renamed" }, startsAt: "2026-06-02T12:00:00Z" });
    expect(dated.terms).toEqual(terms);
    expect(dated.startsAt).toBe("2026-06-02T12:00:00Z");
  });

  test("real service change adopts current service terms but preserves unchanged resource label", () => {
    const result = accepted({ ...candidate, service: changedService, resource: { ...resource, name: "Renamed" } });
    expect(result.terms).toEqual({ ...terms, serviceId: otherServiceId, serviceName: "New service", durationMinutes: 60, priceArs: 250 });
    expect(accepted({ ...candidate, service: changedService, resource: changedResource }).terms)
      .toEqual({ ...result.terms, resourceId: otherResourceId, resourceName: "New resource" });
  });

  test("saved duration, not updated catalog duration, drives hours, pauses, closures and busy overlap", () => {
    const input = { ...candidate, service: { ...service, durationMinutes: 15 }, resource: changedResource };
    const narrow: WeeklySchedule = { 1: [{ startMinute: 540, endMinute: 555 }, { startMinute: 570, endMinute: 600 }] };
    const block = { start: "2026-06-01T12:15:00Z", end: "2026-06-01T12:30:00Z" };
    for (const constraints of [
      { businessHours: narrow }, { resourceHours: narrow },
      { closedIntervals: [block] }, { busyIntervals: [block] },
    ]) expect(prepareAppointmentChange(current, input, { ...context, ...constraints }))
      .toEqual({ ok: false, error: "structural_unavailable" });
    const adjacent = { start: "2026-06-01T12:30:00Z", end: "2026-06-01T13:00:00Z" };
    expect(accepted(input, { ...context, busyIntervals: [adjacent] }).terms.durationMinutes).toBe(30);
    const fullHalfHour: WeeklySchedule = { 1: [{ startMinute: 540, endMinute: 570 }] };
    expect(accepted({ ...input, service: { ...service, durationMinutes: 90 } }, {
      ...context, businessHours: fullHalfHour, resourceHours: fullHalfHour,
    }).terms.durationMinutes).toBe(30);
  });

  test("new service duration drives full interval and half-open closed dates", () => {
    const block = { start: "2026-06-01T12:30:00Z", end: "2026-06-01T13:00:00Z" };
    for (const constraints of [{ busyIntervals: [block] }, { closedIntervals: [block] }]) {
      expect(prepareAppointmentChange(current, variants[0]!, { ...context, ...constraints }))
        .toEqual({ ok: false, error: "structural_unavailable" });
    }
    const overnight = { ...candidate, startsAt: "2026-06-01T23:30:00-03:00" };
    expect(accepted(overnight, { ...context, closedDates: ["2026-06-02"] }).terms.durationMinutes).toBe(30);
    expect(prepareAppointmentChange(current, { ...overnight, service: changedService }, {
      ...context, closedDates: ["2026-06-02"],
    })).toEqual({ ok: false, error: "structural_unavailable" });
  });

  test("delegates IANA grid, off days and caller-scoped self exclusion without generating slots", () => {
    for (const constraints of [{ businessHours: {} }, { resourceHours: {} }, { closedDates: ["2026-06-01"] }]) {
      expect(prepareAppointmentChange(current, variants[1]!, { ...context, ...constraints }).ok).toBe(false);
    }
    expect(prepareAppointmentChange(current, { ...candidate, startsAt: "2026-06-01T13:01:00Z" }, context))
      .toEqual({ ok: false, error: "structural_unavailable" });
    const self = { start: "2026-06-01T12:00:00Z", end: "2026-06-01T12:30:00Z" };
    expect(prepareAppointmentChange(current, variants[1]!, { ...context, busyIntervals: [self] }).ok).toBe(false);
    expect(accepted(variants[1]!, { ...context, busyIntervals: [] }).changed).toBe(true);
    // IANA rollback repeats Saturday's 23:00 hour; the elapsed interval still fits.
    const historical = { ...current, startsAt: "2008-03-15T23:45:00-02:00" };
    expect(accepted({ ...candidate, startsAt: historical.startsAt, resource: changedResource }, {
      ...context, now: "2008-03-16T01:30:00Z",
      businessHours: { 6: [{ startMinute: 1380, endMinute: 1440 }] },
      resourceHours: { 6: [{ startMinute: 1380, endMinute: 1440 }] },
    }, historical).changed).toBe(true);
  });

  test("outputs are detached frozen values and leave catalog, saved terms and preference untouched", () => {
    const before = structuredClone({ current, candidate });
    const result = accepted({ ...candidate, resource: Object.freeze(changedResource) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.terms)).toBe(true);
    expect(result.terms).not.toBe(terms);
    expect(result.customerResourcePreference).toBe(resourceId);
    expect({ current, candidate }).toEqual(before);
    expect(Object.keys(result.terms).sort()).toEqual(Object.keys(terms).sort());
  });
});

describe("explicit customer preference value transform, not permission", () => {
  test("absence retains the saved value or null for new booking; assignment has no input here", () => {
    expect(resolveCustomerResourcePreference(resourceId)).toBe(resourceId);
    expect(resolveCustomerResourcePreference(null)).toBeNull();
    expect(accepted(variants[1]!).customerResourcePreference).toBe(resourceId);
  });
  test("only an explicit resolved customer expression selects or clears preference", () => {
    const expression = Object.freeze({ kind: "chosen" as const, resourceId: otherResourceId.toUpperCase() });
    expect(resolveCustomerResourcePreference(resourceId, expression)).toBe(otherResourceId);
    expect(resolveCustomerResourcePreference(null, expression)).toBe(otherResourceId);
    expect(resolveCustomerResourcePreference(resourceId, { kind: "none" })).toBeNull();
    expect(expression.resourceId).toBe(otherResourceId.toUpperCase());
    expect(() => resolveCustomerResourcePreference(null, { kind: "chosen", resourceId: "not-owned-id" })).toThrow();
  });
});

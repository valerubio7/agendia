import { describe, expect, test } from "bun:test";
import {
  ResourceInputSchema,
  isResourceEligibleForService,
  isResourceNameAvailable,
  isResourceScheduleWithinBusiness,
  normalizeResourceName,
  type ResourceInput,
  type ResourceNameEntry,
} from "./index.ts";

const serviceId = "a1234567-89ab-4cde-8fab-0123456789ab";
const otherId = "b1234567-89ab-4cde-8fab-0123456789ab";
const valid: ResourceInput = { name: "Ana", serviceIds: [serviceId], weeklySchedule: {} };
const span = (startMinute: number, endMinute: number) => ({ startMinute, endMinute });

describe("resource input", () => {
  test("requires name, explicit assignments and explicit weekly hours", () => {
    for (const field of ["name", "serviceIds", "weeklySchedule"] as const) {
      const input = { ...valid };
      delete (input as Partial<ResourceInput>)[field];
      expect(ResourceInputSchema.safeParse(input).success).toBe(false);
    }
    for (const name of ["", " \t\n", 123, null]) {
      expect(ResourceInputSchema.safeParse({ ...valid, name }).success).toBe(false);
    }
    expect(ResourceInputSchema.parse({ ...valid, name: "  Ána  María\n" }).name).toBe("Ána  María");
  });

  test("reuses optional untrimmed description and unlimited Unicode text", () => {
    expect(ResourceInputSchema.parse(valid)).toEqual(valid);
    for (const description of ["", "  descripción  ", "🧑🏽‍💻漢字".repeat(10_000)]) {
      expect(ResourceInputSchema.parse({ ...valid, description }).description).toBe(description);
    }
    expect(ResourceInputSchema.safeParse({ ...valid, description: 123 }).success).toBe(false);
    expect(ResourceInputSchema.safeParse({ ...valid, description: null }).success).toBe(false);
    const name = "Á漢🧑🏽‍💻".repeat(10_000);
    expect(ResourceInputSchema.parse({ ...valid, name }).name).toBe(name);
  });

  test("canonicalizes UUID case and deduplicates as a logical set; empty means no eligibility", () => {
    const serviceIds = [serviceId.toUpperCase(), otherId, serviceId, otherId.toUpperCase()];
    expect(ResourceInputSchema.parse({ ...valid, serviceIds }).serviceIds).toEqual([serviceId, otherId]);
    expect(ResourceInputSchema.parse({ ...valid, serviceIds: [] }).serviceIds).toEqual([]);
    for (const ids of [["Ana"], ["not-a-uuid"], [123], [null], serviceId, null]) {
      expect(ResourceInputSchema.safeParse({ ...valid, serviceIds: ids }).success).toBe(false);
    }
  });

  test("accepts explicit off days, non-grid minutes, multiple spans, overnight and week wrap", () => {
    for (const weeklySchedule of [
      {}, { 1: [] }, { 1: [span(541, 719), span(781, 1003)] },
      { 1: [span(1381, 61)] }, { 6: [span(1381, 61)] },
    ]) {
      expect(ResourceInputSchema.parse({ ...valid, weeklySchedule }).weeklySchedule).toEqual(weeklySchedule);
    }
    for (const weeklySchedule of [
      null, [], { 7: [] }, { 1: [span(60, 60)] }, { 1: [span(-1, 60)] },
      { 1: [span(1440, 60)] }, { 1: [span(60, 1441)] }, { 1: [span(60.5, 90)] },
      { 1: [{ startMinute: 60 }] }, { 1: [span(60, NaN)] },
    ]) {
      expect(ResourceInputSchema.safeParse({ ...valid, weeklySchedule }).success).toBe(false);
    }
  });
});

describe("resource naming", () => {
  const entries: readonly ResourceNameEntry[] = [
    { id: "ana", businessId: "one", name: "  Ána María  " },
    { id: "other", businessId: "two", name: "Luis" },
  ];
  test("uses business-scoped case/outer-whitespace equivalence only", () => {
    expect(normalizeResourceName("  ÁNA  María\n")).toBe("ána  maría");
    expect(isResourceNameAvailable("one", " ÁNA MARÍA ", entries)).toBe(false);
    expect(isResourceNameAvailable("two", "Ána María", entries)).toBe(true);
    expect(isResourceNameAvailable("one", "Luis", entries)).toBe(true);
    for (const name of ["Ana María", "Ána  María", "新".repeat(10_000)]) {
      expect(isResourceNameAvailable("one", name, entries)).toBe(true);
    }
    expect(isResourceNameAvailable("one", "Ána María", [])).toBe(true);
  });
  test("excludes only the edited ID, not another conflicting resource", () => {
    expect(isResourceNameAvailable("one", "ÁNA María", entries, "ana")).toBe(true);
    expect(isResourceNameAvailable("one", "ÁNA María", entries, "other")).toBe(false);
    const duplicates = [...entries, { id: "duplicate", businessId: "one", name: "ÁNA MARÍA" }];
    expect(isResourceNameAvailable("one", "Ána María", duplicates, "ana")).toBe(false);
  });
});

describe("resource service eligibility", () => {
  test("requires both active statuses and an exact canonical assigned ID without mutation", () => {
    for (const resourceStatus of ["active", "suspended"] as const) {
      for (const serviceStatus of ["active", "suspended"] as const) {
        const resource = Object.freeze({ status: resourceStatus, serviceIds: Object.freeze([serviceId]) });
        const service = Object.freeze({ id: serviceId, status: serviceStatus });
        expect(isResourceEligibleForService(resource, service)).toBe(resourceStatus === "active" && serviceStatus === "active");
        expect(resource.status).toBe(resourceStatus);
        expect(service.status).toBe(serviceStatus);
      }
    }
    const resource = { status: "active" as const, serviceIds: [serviceId] };
    for (const id of [otherId, "Ana", serviceId.toUpperCase()]) {
      expect(isResourceEligibleForService(resource, { id, status: "active" })).toBe(false);
    }
    expect(isResourceEligibleForService({ status: "active", serviceIds: [] }, { id: serviceId, status: "active" })).toBe(false);
    const parsed = ResourceInputSchema.parse({ ...valid, serviceIds: [serviceId.toUpperCase()] });
    expect(isResourceEligibleForService({ ...parsed, status: "active" }, { id: serviceId, status: "active" })).toBe(true);
  });
});

test("existing containment uses actual unions, pauses, off days and week-wrap without truncation", () => {
  const resource = ResourceInputSchema.parse({ ...valid, weeklySchedule: { 1: [span(541, 719)] } });
  expect(isResourceScheduleWithinBusiness(resource.weeklySchedule, { 1: [span(540, 600), span(600, 720)] })).toBe(true);
  expect(isResourceScheduleWithinBusiness(resource.weeklySchedule, { 1: [span(540, 600), span(601, 720)] })).toBe(false);
  expect(isResourceScheduleWithinBusiness(resource.weeklySchedule, {})).toBe(false);
  expect(isResourceScheduleWithinBusiness({}, {})).toBe(true);
  const wrap = { 6: [span(1381, 61)] };
  expect(isResourceScheduleWithinBusiness(wrap, { 6: [span(1380, 1440)], 0: [span(0, 62)] })).toBe(true);
  expect(isResourceScheduleWithinBusiness(wrap, { 6: [span(1380, 1440)], 0: [span(0, 60)] })).toBe(false);
  expect(resource.weeklySchedule).toEqual({ 1: [span(541, 719)] });
});

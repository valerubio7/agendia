import { expect, test } from "@playwright/test";
import { CalendarDateSchema, InstantSchema, parseCalendarDateMs, parseInstantMs } from "@agendia/domain";
import {
  AppointmentAvailabilityQuerySchema,
  AppointmentListQuerySchema,
  ManualAppointmentCreateSchema,
  ManualAppointmentStateSchema,
} from "@agendia/contracts";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("public domain root initializes exact calendar and instant validation", () => {
  const instant = "2028-02-29T09:00:00.123-03:00";
  expect(InstantSchema.parse(instant)).toBe(instant);
  expect(parseInstantMs(instant)).toBe(Date.parse("2028-02-29T12:00:00.123Z"));
  expect(InstantSchema.safeParse("2028-02-29T09:00:00").success).toBe(false);
  expect(InstantSchema.safeParse("2028-02-29T09:00:00.1234Z").success).toBe(false);
  expect(CalendarDateSchema.parse("2028-02-29")).toBe("2028-02-29");
  expect(parseCalendarDateMs("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
  expect(CalendarDateSchema.safeParse("2027-02-29").success).toBe(false);
});

test("public HTTP schemas retain strict queries and literal confirmation", () => {
  const query = { serviceId: id.toUpperCase(), date: "2028-02-29" };
  expect(AppointmentAvailabilityQuerySchema.parse(query)).toEqual({ ...query, serviceId: id });
  expect(AppointmentAvailabilityQuerySchema.safeParse({ ...query, extra: true }).success).toBe(false);
  expect(AppointmentListQuerySchema.safeParse({
    from: "2028-02-29T09:00:00-03:00", to: "2028-02-29T11:00:00Z",
  }).success).toBe(false);
  expect(ManualAppointmentStateSchema.parse({ state: "cancelled", confirmed: true }))
    .toEqual({ state: "cancelled", confirmed: true });
  for (const confirmed of [false, "true", 1, undefined]) {
    expect(ManualAppointmentStateSchema.safeParse({ state: "done", confirmed }).success).toBe(false);
  }
  expect(ManualAppointmentStateSchema.safeParse({ state: "confirmed", confirmed: true }).success).toBe(false);
  expect(ManualAppointmentStateSchema.safeParse({ state: "done", confirmed: true, clientId: id }).success).toBe(false);
});

test("public HTTP creation retains client normalization and exclusive client source", () => {
  const request = {
    serviceId: id, resourceId: id, startRaw: "2028-02-29T09:00:00-03:00", date: "2028-02-29",
    expectedTerms: { serviceId: id, resourceId: id, serviceName: "Service", resourceName: "Resource",
      durationMinutes: 30, priceArs: 100 },
    confirmed: true, newClient: { firstName: " Ada ", lastName: " Lovelace ", phone: "+5491112345678" },
  };
  expect(ManualAppointmentCreateSchema.parse(request).newClient)
    .toEqual({ firstName: "Ada", lastName: "Lovelace", phone: "+5491112345678" });
  expect(ManualAppointmentCreateSchema.safeParse({ ...request, clientId: id }).success).toBe(false);
  expect(ManualAppointmentCreateSchema.safeParse({ ...request, confirmed: "true" }).success).toBe(false);
  expect(ManualAppointmentCreateSchema.safeParse({ ...request, extra: true }).success).toBe(false);
});

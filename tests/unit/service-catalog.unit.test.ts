import { describe, expect, test } from "bun:test";
import {
  ServiceInputSchema,
  isServiceNameAvailable,
  normalizeServiceName,
  type ServiceInput,
  type ServiceNameEntry,
} from "../../packages/domain/src/index.ts";

const valid: ServiceInput = {
  name: "Facial Treatment",
  durationMinutes: 30,
  priceArs: 1500,
};

const entries: readonly ServiceNameEntry[] = [
  { id: "service-a", businessId: "business-a", name: "  Facial Treatment  " },
  { id: "service-b", businessId: "business-a", name: "Massage" },
  { id: "service-c", businessId: "business-b", name: "Haircut" },
];

describe("service input", () => {
  test("trims outer name whitespace while preserving display casing and internal spaces", () => {
    expect(ServiceInputSchema.parse({ ...valid, name: "  Facial  Treatment \n" })).toEqual({
      ...valid,
      name: "Facial  Treatment",
    });
  });

  test("rejects omitted or blank names", () => {
    const { name: _name, ...withoutName } = valid;
    expect(ServiceInputSchema.safeParse(withoutName).success).toBe(false);
    for (const name of ["", "  ", "\t\n"]) {
      expect(ServiceInputSchema.safeParse({ ...valid, name }).success).toBe(false);
    }
  });

  test("accepts an omitted description or optional text, including empty text", () => {
    expect(ServiceInputSchema.parse(valid)).toEqual(valid);
    for (const description of ["Skin care", "", "  descriptive text  "]) {
      expect(ServiceInputSchema.parse({ ...valid, description }).description).toBe(description);
    }
    expect(ServiceInputSchema.safeParse({ ...valid, description: 123 }).success).toBe(false);
    expect(ServiceInputSchema.safeParse({ ...valid, description: null }).success).toBe(false);
  });

  for (const field of ["name", "description"] as const) {
    test(`rejects NUL in service ${field}`, () => {
      for (const text of ["\u0000", "before\u0000after", "\u0000leading", "trailing\u0000"])
        expect(ServiceInputSchema.safeParse({ ...valid, [field]: text }).success).toBe(false);
    });
  }

  for (const durationMinutes of [0, -15, 15.5, 1, 16, 29, NaN, Infinity, "30"]) {
    test(`rejects invalid duration in minutes: ${String(durationMinutes)}`, () => {
      expect(ServiceInputSchema.safeParse({ ...valid, durationMinutes }).success).toBe(false);
    });
  }

  test("accepts positive quarter-hour durations without an arbitrary maximum", () => {
    for (const durationMinutes of [15, 30, 45, 90, 150_000]) {
      expect(ServiceInputSchema.parse({ ...valid, durationMinutes }).durationMinutes).toBe(durationMinutes);
    }
  });

  for (const priceArs of [-1, NaN, Infinity, -Infinity, "1500"]) {
    test(`rejects invalid ARS price: ${String(priceArs)}`, () => {
      expect(ServiceInputSchema.safeParse({ ...valid, priceArs }).success).toBe(false);
    });
  }

  test("accepts free services and finite prices without precision or maximum restrictions", () => {
    for (const priceArs of [0, 0.001, 1500.5, Number.MAX_VALUE]) {
      expect(ServiceInputSchema.parse({ ...valid, priceArs }).priceArs).toBe(priceArs);
    }
  });

  test("requires duration and price", () => {
    expect(ServiceInputSchema.safeParse({ name: valid.name, priceArs: 0 }).success).toBe(false);
    expect(ServiceInputSchema.safeParse({ name: valid.name, durationMinutes: 15 }).success).toBe(false);
  });

  test("does not impose arbitrary text length limits", () => {
    const name = "A".repeat(10_000);
    const description = "B".repeat(20_000);
    expect(ServiceInputSchema.parse({ ...valid, name, description })).toEqual({ ...valid, name, description });
  });
});

describe("advisory business-scoped service naming", () => {
  test("normalizes only case and outer whitespace", () => {
    expect(normalizeServiceName("  FÁCIAL  Treatment\n")).toBe("fácial  treatment");
  });

  test("rejects case and outer-whitespace duplicates in the same business", () => {
    for (const name of ["Facial Treatment", "facial treatment", "  FACIAL TREATMENT\t"]) {
      expect(isServiceNameAvailable("business-a", name, entries)).toBe(false);
    }
  });

  test("allows another business to reuse a name", () => {
    expect(isServiceNameAvailable("business-b", "facial treatment", entries)).toBe(true);
    expect(isServiceNameAvailable("business-a", "Haircut", entries)).toBe(true);
  });

  test("allows new names and an empty catalog", () => {
    expect(isServiceNameAvailable("business-a", "New service", entries)).toBe(true);
    expect(isServiceNameAvailable("business-a", "Facial Treatment", [])).toBe(true);
  });

  test("does not collapse internal whitespace or equate accents", () => {
    expect(isServiceNameAvailable("business-a", "Facial  Treatment", entries)).toBe(true);
    expect(isServiceNameAvailable("business-a", "Fácial Treatment", entries)).toBe(true);
  });

  test("excludes only the edited service and still detects other same-business conflicts", () => {
    expect(isServiceNameAvailable("business-a", " FACIAL treatment ", entries, "service-a")).toBe(true);
    expect(isServiceNameAvailable("business-a", " massage ", entries, "service-a")).toBe(false);
    expect(isServiceNameAvailable("business-a", "Facial Treatment", entries, "service-c")).toBe(false);
    const duplicates = [...entries, { id: "service-d", businessId: "business-a", name: "FACIAL TREATMENT" }];
    expect(isServiceNameAvailable("business-a", "Facial Treatment", duplicates, "service-a")).toBe(false);
  });
});

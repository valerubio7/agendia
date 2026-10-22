import { describe, expect, test } from "bun:test";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import {
  ClientInputSchema,
  normalizeClientPhone,
  type ClientInput,
} from "./index.ts";

const valid: ClientInput = {
  firstName: "María",
  lastName: "Pérez",
  phone: "+5491123456789",
};

const localMobiles = [
  ["11 2345 6789", "+5491123456789"],
  ["011 2345 6789", "+5491123456789"],
  ["011 15-2345-6789", "+5491123456789"],
  ["11 15-2345-6789", "+5491123456789"],
  ["351 234 5678", "+5493512345678"],
  ["0351 234 5678", "+5493512345678"],
  ["0351 15 234 5678", "+5493512345678"],
] as const;

const internationalPhones = [
  ["+54 9 11 2345-6789", "+5491123456789"],
  ["+54 11 2345-6789", "+541123456789"],
  ["0054 11 2345-6789", "+541123456789"],
  ["0 0 54 11 2345-6789", "+541123456789"],
  ["00 54 9 11 2345-6789", "+5491123456789"],
  ["+44 20 7946 0018", "+442079460018"],
  ["0044 20 7946 0018", "+442079460018"],
  ["+1 (213) 373-4253", "+12133734253"],
] as const;

const invalidPhones: unknown[] = [
  undefined, null, 1123456789, {}, [], true,
  "", " \t\n", "not a phone", "2345 6789", "15 2345 6789",
  "+9991123456789", "+54", "000", "+5491000000000", "(+54 11) 2345-6789",
  "Call +54 9 11 2345-6789", "+54 9 11 2345-6789 please",
  "+54 9 11 2345-6789 ext. 123", "+54 9 11 2345-6789 x123",
  "+54 9 11 2345-6789#123", "+54 9 11 2345-6789;ext=123",
  "tel:+5491123456789;phone-context=example.com",
  "+5491123456789,123", "+5491123456789/123", "+5491123456789~123",
  "+5491123456789 and +442079460018",
];

describe("manual client phone normalization", () => {
  test("installed max metadata recognizes fixed, mobile and foreign fixtures", () => {
    for (const [input, number, country, type] of [
      ["011 15-2345-6789", "+5491123456789", "AR", "MOBILE"],
      ["0351 15 234 5678", "+5493512345678", "AR", "MOBILE"],
      ["0054 11 2345-6789", "+541123456789", "AR", "FIXED_LINE"],
      ["0044 20 7946 0018", "+442079460018", "GB", "FIXED_LINE"],
    ] as const) {
      const parsed = parsePhoneNumberFromString(input, { defaultCountry: "AR", extract: false });
      expect(parsed?.number).toBe(number);
      expect(parsed?.country).toBe(country);
      expect(parsed?.getType()).toBe(type);
      expect(parsed?.isValid()).toBe(true);
    }
  });

  for (const [input, number] of localMobiles) {
    test(`defaults manual local input to Argentina mobile: ${input}`, () => {
      expect(normalizeClientPhone(input)).toBe(number);
      expect(ClientInputSchema.parse({ ...valid, phone: input }).phone).toBe(number);
    });
  }

  for (const [input, number] of internationalPhones) {
    test(`preserves explicit international identity: ${input}`, () => {
      expect(normalizeClientPhone(input)).toBe(number);
      expect(ClientInputSchema.parse({ ...valid, phone: input }).phone).toBe(number);
    });
  }

  test("uses metadata validity rather than assuming a zero subscriber is invalid", () => {
    const local = parsePhoneNumberFromString("11 0000 0000", { defaultCountry: "AR", extract: false });
    expect(local?.nationalNumber).toBe("1100000000");
    expect(local?.isValid()).toBe(true);
    const mobile = parsePhoneNumberFromString("+5491100000000", { extract: false });
    expect(mobile?.isValid()).toBe(true);
    expect(mobile?.getType()).toBe("MOBILE");
    expect(normalizeClientPhone("11 0000 0000")).toBe("+5491100000000");
  });

  test("trims outer whitespace and is idempotent for every canonical fixture", () => {
    for (const [input, number] of [...localMobiles, ...internationalPhones]) {
      expect(normalizeClientPhone(` \t${input}\n`)).toBe(number);
      expect(normalizeClientPhone(number)).toBe(number);
    }
  });

  test("returns undefined for unsupported or invalid input without leaking parser errors", () => {
    for (const phone of invalidPhones) {
      expect(normalizeClientPhone(phone)).toBeUndefined();
      expect(ClientInputSchema.safeParse({ ...valid, phone }).success).toBe(false);
    }
  });
});

describe("client input", () => {
  test("trims required names without changing case, accents or internal whitespace", () => {
    expect(ClientInputSchema.parse({
      firstName: " \tMaría  José\n",
      lastName: "  de la  Peña  ",
      phone: "011 2345 6789",
    })).toEqual({ firstName: "María  José", lastName: "de la  Peña", phone: valid.phone });
  });

  test("rejects missing, null, blank and nonstring required fields safely", () => {
    for (const field of ["firstName", "lastName", "phone"] as const) {
      const { [field]: _omitted, ...missing } = valid;
      expect(ClientInputSchema.safeParse(missing).success).toBe(false);
      for (const value of [undefined, null, "", " \t\n", 123, false, {}, []]) {
        expect(ClientInputSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
      }
    }
    for (const input of [undefined, null, "", 123, []]) {
      expect(ClientInputSchema.safeParse(input).success).toBe(false);
    }
  });

  test("accepts long Unicode names without arbitrary caps", () => {
    const firstName = "María 愛🌺".repeat(2_000);
    const lastName = "Peña Ñ田".repeat(2_000);
    expect(ClientInputSchema.parse({ ...valid, firstName, lastName })).toEqual({
      ...valid, firstName, lastName,
    });
  });
});

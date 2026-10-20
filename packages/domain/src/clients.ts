import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { z } from "zod";

/**
 * Manual input only: unmarked Argentina area/subscriber numbers default to mobile.
 * Never use this inference as sender authority; WhatsApp PN is already international.
 * Returns undefined for invalid or unsupported input, without exposing parser errors.
 */
export function normalizeClientPhone(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const text = input.trim();
  // Permit phone presentation, not prose, URIs, extensions or extra dialing data.
  // This guard never strips characters to fabricate a valid number.
  if (!text || !/^[+0-9\s().-]+$/.test(text)) return undefined;

  try {
    let phone = parsePhoneNumberFromString(text, { defaultCountry: "AR", extract: false });
    if (!phone || phone.ext || phone.carrierCode) return undefined;

    // AR metadata recognizes 00 as the international dialing prefix. Leave its
    // interpretation to the parser, but exclude it (and +) from manual inference,
    // including presentation separators between the two prefix digits.
    const international = text.includes("+") || /^\D*0\D*0/.test(text);
    if (!international && phone.country === "AR" && phone.nationalNumber.length === 10) {
      // Use the metadata-parsed area/subscriber number, including non-AMBA areas.
      // A local number may be invalid as fixed but valid as mobile: validate AFTER
      // constructing the approved candidate, never guess a missing area code.
      phone = parsePhoneNumberFromString(`+549${phone.nationalNumber}`, { extract: false });
      if (!phone || phone.country !== "AR" || phone.getType() !== "MOBILE") return undefined;
    }

    return phone.isValid() ? phone.number : undefined;
  } catch {
    return undefined;
  }
}

export const ClientInputSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  phone: z.string().transform((input, ctx) => {
    const phone = normalizeClientPhone(input);
    if (phone === undefined) {
      ctx.addIssue({ code: "custom", message: "Invalid or unsupported phone number" });
      return z.NEVER;
    }
    return phone;
  }),
});

export type ClientInput = z.infer<typeof ClientInputSchema>;

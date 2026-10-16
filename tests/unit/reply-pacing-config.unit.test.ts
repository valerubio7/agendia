import { describe, expect, test } from "bun:test";
import { DEFAULT_REPLY_PACING, MAX_REPLY_DELAY_SECONDS, MAX_INACTIVITY_RESET_SECONDS, ReplyPacingSchema } from "../../packages/domain/src/index.ts";
import { PlatformAiInstructionsInputSchema } from "../../packages/contracts/src/http.ts";

describe("global reply pacing in integer seconds", () => {
  test("historical defaults and inclusive limits", () => {
    expect(DEFAULT_REPLY_PACING).toEqual({ initialDelaySeconds: 600, activeDelaySeconds: 90, inactivityResetSeconds: 3600 });
    expect(ReplyPacingSchema.parse(DEFAULT_REPLY_PACING)).toEqual(DEFAULT_REPLY_PACING);
    for (const policy of [
      { initialDelaySeconds: 0, activeDelaySeconds: 0, inactivityResetSeconds: 1 },
      { initialDelaySeconds: MAX_REPLY_DELAY_SECONDS, activeDelaySeconds: MAX_REPLY_DELAY_SECONDS, inactivityResetSeconds: MAX_INACTIVITY_RESET_SECONDS },
    ]) expect(ReplyPacingSchema.safeParse(policy).success).toBe(true);
    expect(MAX_REPLY_DELAY_SECONDS).toBe(86400);
    expect(MAX_INACTIVITY_RESET_SECONDS).toBe(604800);
  });

  test("rejects invalid units, ranges and malformed policies without coercion", () => {
    for (const field of Object.keys(DEFAULT_REPLY_PACING)) {
      for (const value of [NaN, Infinity, -Infinity, -1, 0.5, 604801, Number.MAX_SAFE_INTEGER, "90", null, undefined, true]) {
        expect(ReplyPacingSchema.safeParse({ ...DEFAULT_REPLY_PACING, [field]: value }).success).toBe(false);
      }
    }
    for (const field of ["initialDelaySeconds", "activeDelaySeconds"]) {
      expect(ReplyPacingSchema.safeParse({ ...DEFAULT_REPLY_PACING, [field]: 86401 }).success).toBe(false);
      expect(ReplyPacingSchema.safeParse({ ...DEFAULT_REPLY_PACING, [field]: 600000 }).success).toBe(false);
    }
    expect(ReplyPacingSchema.safeParse({ ...DEFAULT_REPLY_PACING, inactivityResetSeconds: 0 }).success).toBe(false);
    for (const value of [{}, null, [], { ...DEFAULT_REPLY_PACING, initialDelayMs: 600000 }]) {
      expect(ReplyPacingSchema.safeParse(value).success).toBe(false);
    }
  });

  test("instruction-only requests stay compatible; supplied policies must be complete and strict", () => {
    expect(PlatformAiInstructionsInputSchema.parse({ additionalInstructions: "raw\n " })).toEqual({ additionalInstructions: "raw\n " });
    expect(PlatformAiInstructionsInputSchema.parse({ additionalInstructions: "", replyPacing: DEFAULT_REPLY_PACING }).replyPacing).toEqual(DEFAULT_REPLY_PACING);
    for (const policy of [null, {}, { ...DEFAULT_REPLY_PACING, extra: true }, { ...DEFAULT_REPLY_PACING, activeDelaySeconds: -1 }]) {
      expect(PlatformAiInstructionsInputSchema.safeParse({ additionalInstructions: "", replyPacing: policy }).success).toBe(false);
    }
  });
});

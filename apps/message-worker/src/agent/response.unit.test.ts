import { describe, expect, test } from "bun:test";
import { renderAgentResponse } from "./response.ts";

describe("strict model-authored final response", () => {
  test("preserves exact model text without selectors or rewriting", () => {
    const text = "  Mi respuesta propia.\n";
    expect(renderAgentResponse(JSON.stringify({ text }))).toEqual({ text });
    expect(renderAgentResponse(JSON.stringify({ text, presentedQuoteReference: "a".repeat(64) })))
      .toEqual({ text, presentedQuoteReference: "a".repeat(64) });
  });
  for (const raw of ["not JSON", "null", '"texto"', '{}', '{"text":',
    ...[null, 1, [], {}, "", " \n\t", "a".repeat(4001)].map(text => JSON.stringify({ text })),
    ...["kind", "facts", "ask", "operation", "proof"].map(key => JSON.stringify({ text: "hola", [key]: "reply" })),
    JSON.stringify({ text: "hola", presentedQuoteReference: "forged" }),
    JSON.stringify({ text: "a".repeat(3990) }),
  ]) test(`aborts invalid final: ${raw.slice(0, 80)}`, () => {
    expect(() => renderAgentResponse(raw)).toThrow();
  });
  test("serialized ceiling includes JSON framing", () => {
    const raw = JSON.stringify({ text: "a".repeat(3989) });
    expect(raw.length).toBe(4000);
    expect(renderAgentResponse(raw)).toEqual({ text: "a".repeat(3989) });
  });
});

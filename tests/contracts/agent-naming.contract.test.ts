import { expect, test } from "bun:test";
import * as domain from "@agendia/domain";
import { PRODUCT_HTTP_ROUTES, toOpenApiDocument } from "@agendia/contracts";

test("public agent route replaces the old configuration endpoint", () => {
  expect(PRODUCT_HTTP_ROUTES as readonly string[]).toContain("/me/agent");
  expect(PRODUCT_HTTP_ROUTES as readonly string[]).not.toContain("/me/assistant");
  expect(toOpenApiDocument().paths).toHaveProperty("/me/agent");
  expect(toOpenApiDocument().paths).not.toHaveProperty("/me/assistant");
});

test("public agent config and message types retain validation and external roles", () => {
  expect(domain).toHaveProperty("AgentConfigInputSchema");
  expect(domain).not.toHaveProperty("AssistantConfigInputSchema");
  const config = Reflect.get(domain, "AgentConfigInputSchema");
  const valid = { style: " amable ", businessInstructions: " reglas ", active: true, expectedRevision: 0 };
  expect(config.parse(valid)).toEqual(valid);
  expect(config.safeParse({ ...valid, expectedRevision: -1 }).success).toBe(false);
  expect(config.parse({ ...valid, tenantId: "forged" })).toEqual(valid);
  expect(domain).toHaveProperty("ToolAgentMessageSchema");
  const message = Reflect.get(domain, "ToolAgentMessageSchema");
  expect(message.parse({ role: "assistant", content: "Hola" })).toEqual({ role: "assistant", content: "Hola", toolCalls: [] });
  expect(message.safeParse({ role: "agent", content: "Hola" }).success).toBe(false);
});

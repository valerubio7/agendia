import { describe, expect, test } from "bun:test";
import type { InboundWhatsAppEvent } from "../../apps/whatsapp-manager/src/inbound-handler.ts";
import {
  InMemoryInboundRepository,
  InMemorySessionRouter,
  InboundMessageHandler,
} from "../support/whatsapp-manager/inbound.ts";

const textEvent = (
  overrides: Partial<InboundWhatsAppEvent> = {},
): InboundWhatsAppEvent => ({
  sessionPublicId: "session-a",
  providerMessageId: "message-1",
  remoteJid: "549111@s.whatsapp.net",
  chatType: "individual",
  fromMe: false,
  kind: "text",
  text: "Hola",
  receivedAt: 1_000,
  ...overrides,
});

function harness(
  status: "active" | "suspended" = "active",
  assistantActive = true,
) {
  const router = new InMemorySessionRouter();
  router.add("session-a", {
    businessId: "tenant-a",
    businessStatus: status,
    assistantActive,
  });
  const repository = new InMemoryInboundRepository();
  return {
    router,
    repository,
    handler: new InboundMessageHandler(router, repository),
  };
}

describe("idempotent text-only WhatsApp ingestion", () => {
  test("stops an unknown session before touching tenant data", () => {
    const h = harness();
    expect(h.handler.handle(textEvent({ sessionPublicId: "unknown" }))).toEqual(
      { outcome: "unknown_session" },
    );
    expect(h.repository.tenantTouches).toBe(0);
    expect(h.repository.messages).toHaveLength(0);
    expect(h.repository.aiJobs).toHaveLength(0);
  });

  test("persists one message and one durable AI job for duplicate deliveries", () => {
    const h = harness();
    expect(h.handler.handle(textEvent())).toEqual({
      outcome: "accepted",
      sequence: 1,
    });
    expect(h.handler.handle(textEvent())).toEqual({ outcome: "duplicate" });
    expect(h.repository.messages).toEqual([
      {
        businessId: "tenant-a",
        conversationKey: "session-a:549111@s.whatsapp.net",
        providerMessageId: "message-1",
        sequence: 1,
        text: "Hola",
        receivedAt: 1_000,
      },
    ]);
    expect(h.repository.aiJobs).toEqual([
      {
        businessId: "tenant-a",
        conversationKey: "session-a:549111@s.whatsapp.net",
        sequence: 1,
      },
    ]);
  });

  test("persists manual business text without scheduling AI, even when automation is inactive", () => {
    const h = harness("active", false);
    expect(h.handler.handle(textEvent({ fromMe: true }))).toEqual({
      outcome: "accepted_business", sequence: 1,
    });
    expect(h.handler.handle(textEvent({ fromMe: true }))).toEqual({ outcome: "duplicate" });
    expect(h.repository.messages).toEqual([expect.objectContaining({
      direction: "outbound", text: "Hola", sequence: 1,
    })]);
    expect(h.repository.aiJobs).toHaveLength(0);
  });

  test("filters groups and multimedia before persisting content or scheduling AI", () => {
    const h = harness();
    const events = [
      textEvent({ providerMessageId: "group", chatType: "group" }),
      textEvent({ providerMessageId: "own-media", fromMe: true, kind: "image", text: null }),
      textEvent({ providerMessageId: "media", kind: "image", text: null }),
    ];
    expect(events.map((event) => h.handler.handle(event).outcome)).toEqual([
      "ignored_group",
      "ignored_non_text",
      "ignored_non_text",
    ]);
    expect(h.repository.messages).toHaveLength(0);
    expect(h.repository.aiJobs).toHaveLength(0);
  });

  test("blocks inactive or suspended businesses and sequences each conversation", () => {
    const inactive = harness("active", false);
    expect(inactive.handler.handle(textEvent()).outcome).toBe(
      "automation_inactive",
    );
    expect(inactive.repository.messages).toHaveLength(0);
    const suspended = harness("suspended", true);
    expect(suspended.handler.handle(textEvent()).outcome).toBe(
      "automation_inactive",
    );
    const ordered = harness();
    expect(ordered.handler.handle(textEvent()).sequence).toBe(1);
    expect(
      ordered.handler.handle(
        textEvent({ providerMessageId: "message-2", text: "Dos" }),
      ).sequence,
    ).toBe(2);
    expect(
      ordered.repository.messages.map((message) => message.sequence),
    ).toEqual([1, 2]);
  });
});

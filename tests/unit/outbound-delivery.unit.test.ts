import { describe, expect, test } from "bun:test";
import {
  canTransitionDelivery,
  transitionDelivery,
} from "../../packages/domain/src/messaging/outbound-delivery.ts";
import {
  DeterministicOutboundGateway,
  InMemoryOutboundRepository,
  OutboundDispatcher,
} from "../support/whatsapp-manager/outbound.ts";

function harness(result: "ack" | "rejected" | "crash") {
  const repository = new InMemoryOutboundRepository();
  repository.add({
    outboundId: "out-1",
    businessId: "tenant-a",
    connectionId: "connection-a",
    remoteJid: "54911@s.whatsapp.net",
    text: "Respuesta",
    state: "generated",
  });
  const gateway = new DeterministicOutboundGateway(result);
  return {
    repository,
    gateway,
    dispatcher: new OutboundDispatcher(repository, gateway),
  };
}

describe("conservative outbound delivery", () => {
  test("uses the owning connection and confirms sent only after an ACK", async () => {
    const h = harness("ack");
    await h.dispatcher.dispatch("out-1", {
      connectionId: "connection-a",
      state: "CONNECTED",
      ownerId: "manager-1",
    });
    expect(h.gateway.calls).toEqual([
      {
        connectionId: "connection-a",
        outboundId: "out-1",
        remoteJid: "54911@s.whatsapp.net",
        text: "Respuesta",
      },
    ]);
    expect(h.repository.get("out-1")?.state).toBe("sent");
    expect(h.repository.auditEvents).toEqual([
      {
        businessId: "tenant-a",
        eventType: "whatsapp.outbound.sent",
        outcome: "success",
      },
    ]);
  });

  test("marks an ambiguous crash delivery_unknown and never retries it", async () => {
    const h = harness("crash");
    await h.dispatcher.dispatch("out-1", {
      connectionId: "connection-a",
      state: "CONNECTED",
      ownerId: "manager-1",
    });
    expect(h.repository.get("out-1")?.state).toBe("delivery_unknown");
    expect(h.gateway.calls).toHaveLength(1);
    await h.dispatcher.dispatch("out-1", {
      connectionId: "connection-a",
      state: "CONNECTED",
      ownerId: "manager-1",
    });
    expect(h.gateway.calls).toHaveLength(1);
  });

  test("records an unequivocal rejection as failed and does not send through an unready connection", async () => {
    const rejected = harness("rejected");
    await rejected.dispatcher.dispatch("out-1", {
      connectionId: "connection-a",
      state: "CONNECTED",
      ownerId: "manager-1",
    });
    expect(rejected.repository.get("out-1")?.state).toBe("failed");
    const disconnected = harness("ack");
    await disconnected.dispatcher.dispatch("out-1", {
      connectionId: "connection-a",
      state: "DISCONNECTED",
      ownerId: "manager-1",
    });
    expect(disconnected.gateway.calls).toHaveLength(0);
    expect(disconnected.repository.get("out-1")?.state).toBe("generated");
    expect(disconnected.repository.technicalEvents[0]?.code).toBe(
      "whatsapp.connection_not_ready",
    );
  });

  test("allows only the manager that owns the exact connection to claim delivery", async () => {
    const h = harness("ack");
    const nonOwner = new OutboundDispatcher(
      h.repository,
      h.gateway,
      "manager-2",
    );
    await nonOwner.dispatch("out-1", {
      connectionId: "connection-a",
      state: "CONNECTED",
      ownerId: "manager-1",
    });
    expect(h.gateway.calls).toHaveLength(0);
    expect(h.repository.get("out-1")?.state).toBe("generated");
  });

  test("reconciles fromMe echo with the existing outbound and never schedules AI", () => {
    const h = harness("ack");
    h.repository.updateState("out-1", "sent");
    expect(h.dispatcher.reconcileFromMe("out-1", "provider-message-1")).toBe(
      true,
    );
    expect(h.repository.get("out-1")?.providerMessageId).toBe(
      "provider-message-1",
    );
    expect(h.repository.aiJobs).toHaveLength(0);
    expect(canTransitionDelivery("sending", "generated")).toBe(false);
    expect(() => transitionDelivery("delivery_unknown", "sending")).toThrow(
      "Invalid outbound delivery transition",
    );
  });
});

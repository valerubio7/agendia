export type OutboundDeliveryState = "pending" | "processing" | "generated" | "sending" | "sent" | "failed" | "delivery_unknown";

const DELIVERY_TRANSITIONS: Readonly<Record<OutboundDeliveryState, readonly OutboundDeliveryState[]>> = {
  pending: ["processing"],
  processing: ["generated", "failed"],
  generated: ["sending", "failed"],
  sending: ["sent", "failed", "delivery_unknown"],
  sent: [],
  failed: [],
  delivery_unknown: [],
};

export function canTransitionDelivery(from: OutboundDeliveryState, to: OutboundDeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function transitionDelivery(from: OutboundDeliveryState, to: OutboundDeliveryState): OutboundDeliveryState {
  if (!canTransitionDelivery(from, to)) throw new Error(`Invalid outbound delivery transition: ${from} -> ${to}`);
  return to;
}

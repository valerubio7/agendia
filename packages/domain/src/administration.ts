import { randomUUID } from "node:crypto";
import type { AuthService } from "@agendia/auth";
import type { AuditEvent } from "@agendia/contracts";
import { buildAuditEvent } from "@agendia/contracts";

export interface BusinessState { id: string; name: string; status: "active" | "suspended"; assistantActive: boolean; whatsappStatus: "link_required" | "connected" | "disconnected" | "error"; createdAt: string; lastTechnicalActivityAt: string | null; }
export class InMemoryAdministrationStore { businesses: BusinessState[] = []; audit: AuditEvent[] = []; outbox: string[] = []; }

export class AdministrationService {
  constructor(readonly store: InMemoryAdministrationStore, private readonly auth: AuthService) {}

  async createBusiness(input: { name: string; userEmail: string; initialPassword: string; requestId: string }): Promise<BusinessState> {
    const name = input.name.trim();
    if (!name) throw new Error("Business name is required");
    const business: BusinessState = { id: randomUUID(), name, status: "active", assistantActive: false, whatsappStatus: "link_required", createdAt: new Date().toISOString(), lastTechnicalActivityAt: null };
    await this.auth.createIdentity({ email: input.userEmail, password: input.initialPassword, role: "business_user", businessId: business.id });
    this.store.businesses.push(business);
    this.store.audit.push(
      buildAuditEvent({ businessId: business.id, actorId: "platform-admin", type: "business.created", outcome: "success", requestId: input.requestId }),
      buildAuditEvent({ businessId: business.id, actorId: "platform-admin", type: "business_user.created", outcome: "success", requestId: input.requestId }),
    );
    this.store.outbox.push(`business.created:${business.id}`);
    return business;
  }

  async replaceBusinessUser(businessId: string, email: string, password: string, requestId: string) {
    if (this.auth.store.identities.some((identity) => identity.businessId === businessId)) throw new Error("Business already has a user");
    return this.auth.createIdentity({ email, password, role: "business_user", businessId });
  }

  setBusinessStatus(businessId: string, status: BusinessState["status"], requestId: string, now = Date.now()): void {
    const business = this.store.businesses.find((item) => item.id === businessId);
    if (!business) throw new Error("Business not found");
    business.status = status;
    for (const identity of this.auth.store.identities.filter((item) => item.businessId === businessId)) {
      identity.active = status === "active";
      if (status === "suspended") this.auth.revokeIdentity(identity.id, now);
    }
    this.store.audit.push(buildAuditEvent({ businessId, actorId: "platform-admin", type: `business.${status}`, outcome: "success", requestId }));
    this.store.outbox.push(`business.${status}:${businessId}`);
  }

  project(businessId: string) {
    const business = this.store.businesses.find((item) => item.id === businessId);
    if (!business) return null;
    return { id: business.id, name: business.name, status: business.status, assistantStatus: business.assistantActive ? "active" as const : "inactive" as const, whatsappStatus: business.whatsappStatus, createdAt: business.createdAt, lastTechnicalActivityAt: business.lastTechnicalActivityAt };
  }

  listProjections() { return this.store.businesses.map((business) => this.project(business.id)); }
}

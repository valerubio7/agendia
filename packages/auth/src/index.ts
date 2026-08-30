import { Algorithm, hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type IdentityRole = "platform_admin" | "business_user";
export interface Identity { id: string; email: string; passwordHash: string; role: IdentityRole; businessId: string | null; active: boolean; }
export interface StoredSession { tokenHash: string; identityId: string; createdAt: number; lastSeenAt: number; absoluteExpiresAt: number; idleExpiresAt: number; revokedAt: number | null; csrfToken: string; }
export class InMemoryAuthStore {
  identities: Identity[] = [];
  sessions: StoredSession[] = [];
  bootstrapUsed = false;
}

export const digestOpaqueToken = (token: string) => createHash("sha256").update(token).digest("hex");
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const DEFAULTS = { absoluteTtlMs: 8 * 60 * 60_000, idleTtlMs: 30 * 60_000 };

export class AuthService {
  private readonly options: typeof DEFAULTS;
  constructor(readonly store: InMemoryAuthStore, options: Partial<typeof DEFAULTS> = {}) { this.options = { ...DEFAULTS, ...options }; }

  async createIdentity(input: { email: string; password: string; role: IdentityRole; businessId: string | null }): Promise<Identity> {
    if (input.password.length < 16 || /^(password|contraseña|123456)/i.test(input.password)) throw new Error("Password does not meet policy");
    const email = normalizeEmail(input.email);
    if (this.store.identities.some((item) => item.email === email)) throw new Error("Identity already exists");
    if (input.role === "business_user" && !input.businessId) throw new Error("Business user requires tenant");
    const identity: Identity = { id: randomUUID(), email, passwordHash: await hash(input.password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }), role: input.role, businessId: input.businessId, active: true };
    this.store.identities.push(identity);
    return identity;
  }

  async bootstrapAdmin(email: string, password: string): Promise<Identity> {
    if (this.store.bootstrapUsed || this.store.identities.some((item) => item.role === "platform_admin")) throw new Error("Bootstrap already consumed");
    const admin = await this.createIdentity({ email, password, role: "platform_admin", businessId: null });
    this.store.bootstrapUsed = true;
    return admin;
  }

  async login(email: string, password: string, now = Date.now()) {
    const identity = this.store.identities.find((item) => item.email === normalizeEmail(email));
    if (!identity?.active || !(await verify(identity.passwordHash, password))) throw new Error("Invalid credentials");
    const token = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    this.store.sessions.push({ tokenHash: digestOpaqueToken(token), identityId: identity.id, createdAt: now, lastSeenAt: now, absoluteExpiresAt: now + this.options.absoluteTtlMs, idleExpiresAt: now + this.options.idleTtlMs, revokedAt: null, csrfToken });
    return { token, csrfToken, identity };
  }

  async authenticate(token: string, now = Date.now()) {
    const session = this.store.sessions.find((item) => item.tokenHash === digestOpaqueToken(token));
    if (!session || session.revokedAt || session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) return null;
    const identity = this.store.identities.find((item) => item.id === session.identityId);
    if (!identity?.active) return null;
    session.lastSeenAt = now;
    session.idleExpiresAt = Math.min(session.absoluteExpiresAt, now + this.options.idleTtlMs);
    return { identityId: identity.id, role: identity.role, businessId: identity.businessId, csrfToken: session.csrfToken };
  }

  async logout(token: string, now = Date.now()) { const session = this.store.sessions.find((item) => item.tokenHash === digestOpaqueToken(token)); if (session) session.revokedAt = now; }
  revokeIdentity(identityId: string, now = Date.now()) { for (const session of this.store.sessions) if (session.identityId === identityId) session.revokedAt = now; }
}

export function sessionCookie(value: string) { return { name: "__Host-agendia_session", value, secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" }; }
export function validateMutationRequest(input: { origin?: string; expectedOrigin: string; csrfHeader?: string; csrfSession?: string }): boolean {
  return input.origin === input.expectedOrigin && Boolean(input.csrfHeader) && input.csrfHeader === input.csrfSession;
}

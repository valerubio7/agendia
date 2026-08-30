import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { RolePool, TenantContext } from "@agendia/db";

interface WrappedKey {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  kekVersion: string;
}

interface ConnectionKey extends WrappedKey {
  businessId: string;
}

export interface KmsPort {
  currentVersion: string;
  wrapKey(connectionId: string, key: Buffer): Promise<WrappedKey>;
  unwrapKey(connectionId: string, wrapped: WrappedKey): Promise<Buffer>;
}

export interface AuthRecord {
  businessId: string;
  connectionId: string;
  name: string;
  version: number;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function encrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, value: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, value.iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}

function recordAad(businessId: string, connectionId: string, name: string, version: number): string {
  return `${businessId}:${connectionId}:${name}:${version}`;
}

export class InMemoryKms implements KmsPort {
  constructor(private readonly keys: Record<string, Buffer>, public currentVersion: string) {}

  async wrapKey(connectionId: string, key: Buffer): Promise<WrappedKey> {
    const kek = this.keys[this.currentVersion];
    if (!kek) throw new Error("KMS key unavailable");
    return { ...encrypt(kek, key, `agendia-dek:${connectionId}`), kekVersion: this.currentVersion };
  }

  async unwrapKey(connectionId: string, wrapped: WrappedKey): Promise<Buffer> {
    const kek = this.keys[wrapped.kekVersion];
    if (!kek) throw new Error("historical KMS key unavailable");
    return decrypt(kek, wrapped, `agendia-dek:${connectionId}`);
  }
}

export class InMemoryAuthRecordRepository {
  readonly connections = new Map<string, ConnectionKey>();
  readonly records = new Map<string, AuthRecord>();
}

export class BaileysAuthStore {
  constructor(private readonly repository: InMemoryAuthRecordRepository, private readonly kms: KmsPort) {}

  private async dek(businessId: string, connectionId: string): Promise<Buffer> {
    const current = this.repository.connections.get(connectionId);
    if (current) {
      if (current.businessId !== businessId) throw new Error("authentication record corrupt");
      return this.kms.unwrapKey(connectionId, current);
    }
    const dek = randomBytes(32);
    const wrapped = await this.kms.wrapKey(connectionId, dek);
    this.repository.connections.set(connectionId, { ...wrapped, businessId });
    return dek;
  }

  async write(businessId: string, connectionId: string, name: string, value: unknown, expectedVersion: number): Promise<AuthRecord> {
    const key = `${connectionId}:${name}`;
    const current = this.repository.records.get(key);
    if ((current?.version ?? 0) !== expectedVersion) throw new Error("authentication record version conflict");
    const version = expectedVersion + 1;
    const encrypted = encrypt(await this.dek(businessId, connectionId), Buffer.from(JSON.stringify(value)), recordAad(businessId, connectionId, name, version));
    const record = { businessId, connectionId, name, version, ...encrypted };
    this.repository.records.set(key, record);
    return record;
  }

  async read(businessId: string, connectionId: string, name: string): Promise<unknown | null> {
    const record = this.repository.records.get(`${connectionId}:${name}`);
    if (!record) return null;
    try {
      const plaintext = decrypt(await this.dek(businessId, connectionId), record, recordAad(businessId, connectionId, name, record.version));
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("authentication record corrupt");
    }
  }

  async version(connectionId: string, name: string): Promise<number> { return this.repository.records.get(`${connectionId}:${name}`)?.version ?? 0; }

  async rotateKek(connectionId: string): Promise<void> {
    const current = this.repository.connections.get(connectionId);
    if (!current) return;
    const dek = await this.kms.unwrapKey(connectionId, current);
    this.repository.connections.set(connectionId, { ...(await this.kms.wrapKey(connectionId, dek)), businessId: current.businessId });
  }
}

export class EnvironmentKms extends InMemoryKms {
  static fromEnv(env: Record<string, string | undefined>): EnvironmentKms {
    const version = env.BAILEYS_KMS_VERSION, encoded = env.BAILEYS_KMS_KEY;
    if (!version || !encoded) throw new Error("Baileys KMS configuration unavailable");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("Baileys KMS key must contain 32 bytes");
    return new EnvironmentKms({ [version]: key }, version);
  }
}

export class PostgresBaileysAuthStore {
  constructor(private readonly pool: RolePool, private readonly context: TenantContext, private readonly kms: KmsPort) {}
  private async memory(connectionId: string, name: string) {
    const repository = new InMemoryAuthRecordRepository();
    const [connection, record] = await Promise.all([
      this.pool.run(this.context, (repo) => repo.authEnvelope(connectionId)),
      this.pool.run(this.context, (repo) => repo.authRecord(connectionId, name)),
    ]);
    if (connection) repository.connections.set(connectionId, connection);
    if (record) repository.records.set(`${connectionId}:${name}`, record);
    return { repository, store: new BaileysAuthStore(repository, this.kms) };
  }
  async write(businessId: string, connectionId: string, name: string, value: unknown, expectedVersion: number) {
    const { repository, store } = await this.memory(connectionId, name), record = await store.write(businessId, connectionId, name, value, expectedVersion);
    await this.pool.run(this.context, async (repo) => { await repo.saveAuthEnvelope(connectionId, repository.connections.get(connectionId)!); await repo.saveAuthRecord(record); });
    return record;
  }
  async read(businessId: string, connectionId: string, name: string) { return (await this.memory(connectionId, name)).store.read(businessId, connectionId, name); }
  async version(connectionId: string, name: string) { return (await this.pool.run(this.context, (repo) => repo.authRecord(connectionId, name)))?.version ?? 0; }
}

export class ExclusiveSessionLocks {
  private readonly owners = new Map<string, string>();
  tryAcquire(connectionId: string, ownerId: string): boolean {
    const owner = this.owners.get(connectionId);
    if (owner && owner !== ownerId) return false;
    this.owners.set(connectionId, ownerId);
    return true;
  }
  release(connectionId: string, ownerId: string): void {
    if (this.owners.get(connectionId) === ownerId) this.owners.delete(connectionId);
  }
}

const SECRET_FIELD = /(qr|credential|key|token|jid|session|ciphertext)/i;
export function redactBaileysDetails(details: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, SECRET_FIELD.test(key) ? "[REDACTED]" : String(value)]));
}

import { describe, expect, test } from "bun:test";
import {
  BaileysAuthStore,
  ExclusiveSessionLocks,
  InMemoryAuthRecordRepository,
  InMemoryKms,
  redactBaileysDetails,
} from "../../packages/whatsapp-baileys/src/auth-store.ts";

describe("encrypted Baileys authentication custody", () => {
  test("round-trips AES-256-GCM records and enforces optimistic versions", async () => {
    const kms = new InMemoryKms({ current: Buffer.alloc(32, 1) }, "current");
    const repository = new InMemoryAuthRecordRepository();
    const store = new BaileysAuthStore(repository, kms);
    const written = await store.write("tenant-a", "connection-a", "creds", { token: "sensitive" }, 0);
    expect(written.version).toBe(1);
    expect(JSON.stringify(repository.records.get("connection-a:creds"))).not.toContain("sensitive");
    expect(await store.read("tenant-a", "connection-a", "creds")).toEqual({ token: "sensitive" });
    await expect(store.write("tenant-a", "connection-a", "creds", { token: "stale" }, 0)).rejects.toThrow("version conflict");
  });

  test("rejects another tenant AAD and corrupted ciphertext", async () => {
    const repository = new InMemoryAuthRecordRepository();
    const store = new BaileysAuthStore(repository, new InMemoryKms({ current: Buffer.alloc(32, 2) }, "current"));
    await store.write("tenant-a", "connection-a", "signal-key", { key: "abc" }, 0);
    await expect(store.read("tenant-b", "connection-a", "signal-key")).rejects.toThrow("authentication record corrupt");
    const corrupt = repository.records.get("connection-a:signal-key")!.ciphertext;
    corrupt[0] = corrupt[0]! ^ 1;
    await expect(store.read("tenant-a", "connection-a", "signal-key")).rejects.toThrow("authentication record corrupt");
  });

  test("rewraps the DEK under a historical KEK without rewriting ciphertext", async () => {
    const kms = new InMemoryKms({ old: Buffer.alloc(32, 3), next: Buffer.alloc(32, 4) }, "old");
    const repository = new InMemoryAuthRecordRepository();
    const store = new BaileysAuthStore(repository, kms);
    await store.write("tenant-a", "connection-a", "creds", { registered: true }, 0);
    const ciphertext = Buffer.from(repository.records.get("connection-a:creds")!.ciphertext);
    kms.currentVersion = "next";
    await store.rotateKek("connection-a");
    expect(repository.connections.get("connection-a")?.kekVersion).toBe("next");
    expect(repository.records.get("connection-a:creds")!.ciphertext).toEqual(ciphertext);
    expect(await store.read("tenant-a", "connection-a", "creds")).toEqual({ registered: true });
  });

  test("allows exactly one session owner and redacts credentials, QR and identifiers", () => {
    const locks = new ExclusiveSessionLocks();
    expect(locks.tryAcquire("connection-a", "manager-1")).toBe(true);
    expect(locks.tryAcquire("connection-a", "manager-2")).toBe(false);
    locks.release("connection-a", "manager-1");
    expect(locks.tryAcquire("connection-a", "manager-2")).toBe(true);
    expect(redactBaileysDetails({ qr: "secret", credential: "secret", jid: "549111@s.whatsapp.net", code: "closed" })).toEqual({
      qr: "[REDACTED]", credential: "[REDACTED]", jid: "[REDACTED]", code: "closed",
    });
  });
});

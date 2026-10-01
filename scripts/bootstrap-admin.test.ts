import { describe, expect, test } from "bun:test";
import {
  provisionAdmin,
  validateAdminInput,
  type AdminIdentity,
  type AdminStore,
} from "./bootstrap-admin.ts";

class FakeStore implements AdminStore {
  identities: AdminIdentity[] = [];
  async findByEmail(email: string) {
    return this.identities.find((row) => row.normalizedEmail === email) ?? null;
  }
  async findPlatformAdmin() {
    return this.identities.find((row) => row.role === "platform_admin") ?? null;
  }
  async insertPlatformAdmin(email: string, passwordPhc: string) {
    const identity = {
      normalizedEmail: email,
      passwordPhc,
      role: "platform_admin" as const,
      businessId: null,
    };
    this.identities.push(identity);
    return identity;
  }
  async close() {}
}

const password = "correct horse battery staple";

describe("admin bootstrap", () => {
  test("normalizes input and enforces the established password policy", () => {
    expect(validateAdminInput(" Owner@Example.COM ", password)).toEqual({
      email: "owner@example.com",
      password,
    });
    expect(() =>
      validateAdminInput("owner@example.com", "password-short"),
    ).toThrow("Password does not meet policy");
  });

  test("provisions exactly once with the established Argon2id parameters", async () => {
    const store = new FakeStore();
    const hashes: unknown[] = [];
    const first = await provisionAdmin(
      { email: " Owner@Example.COM ", password },
      store,
      async (value, options) => {
        hashes.push({ value, options });
        return "$argon2id$test";
      },
    );
    const second = await provisionAdmin(
      { email: "owner@example.com", password },
      store,
      async () => "unexpected",
    );
    expect(first).toEqual({ outcome: "created" });
    expect(second).toEqual({ outcome: "existing" });
    expect(store.identities).toHaveLength(1);
    expect(hashes).toEqual([
      {
        value: password,
        options: {
          algorithm: 2,
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
        },
      },
    ]);
  });

  test("refuses conflicting identities or a different existing platform administrator", async () => {
    const store = new FakeStore();
    store.identities.push({
      normalizedEmail: "owner@example.com",
      passwordPhc: "x",
      role: "business_user",
      businessId: "tenant",
    });
    await expect(
      provisionAdmin({ email: "owner@example.com", password }, store),
    ).rejects.toThrow("role conflict");
    store.identities = [
      {
        normalizedEmail: "other@example.com",
        passwordPhc: "x",
        role: "platform_admin",
        businessId: null,
      },
    ];
    await expect(
      provisionAdmin({ email: "owner@example.com", password }, store),
    ).rejects.toThrow("different platform administrator");
  });
});

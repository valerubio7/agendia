import { Algorithm, hash } from "@node-rs/argon2";
import postgres, { type Sql } from "postgres";

export type AdminIdentity = {
  normalizedEmail: string;
  passwordPhc: string;
  role: "platform_admin" | "business_user";
  businessId: string | null;
};
export interface AdminStore {
  findByEmail(email: string): Promise<AdminIdentity | null>;
  findPlatformAdmin(): Promise<AdminIdentity | null>;
  insertPlatformAdmin(
    email: string,
    passwordPhc: string,
  ): Promise<AdminIdentity>;
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
type PasswordHasher = (
  password: string,
  options: {
    algorithm: Algorithm;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  },
) => Promise<string>;

export function validateAdminInput(
  email: string | undefined,
  password: string | undefined,
) {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized))
    throw new Error("AGENDIA_ADMIN_EMAIL is invalid");
  if (
    !password ||
    password.length < 16 ||
    /^(password|contraseña|123456)/i.test(password)
  )
    throw new Error("Password does not meet policy");
  return { email: normalized, password };
}

export async function provisionAdmin(
  input: { email: string; password: string },
  store: AdminStore,
  hasher: PasswordHasher = hash,
) {
  const { email, password } = validateAdminInput(input.email, input.password);
  const work = async () => {
    const sameIdentity = await store.findByEmail(email);
    if (sameIdentity) {
      if (
        sameIdentity.role !== "platform_admin" ||
        sameIdentity.businessId !== null
      )
        throw new Error("Administrator identity role conflict");
      return { outcome: "existing" as const };
    }
    const currentAdmin = await store.findPlatformAdmin();
    if (currentAdmin)
      throw new Error("A different platform administrator already exists");
    const passwordPhc = await hasher(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    await store.insertPlatformAdmin(email, passwordPhc);
    return { outcome: "created" as const };
  };
  return store.exclusive ? store.exclusive(work) : work();
}

class PostgresAdminStore implements AdminStore {
  private current: Sql;
  constructor(private readonly sql: Sql) {
    this.current = sql;
  }
  private map(
    row:
      | {
          normalized_email: string;
          password_phc: string;
          role: AdminIdentity["role"];
          business_id: string | null;
        }
      | undefined,
  ) {
    return row
      ? {
          normalizedEmail: row.normalized_email,
          passwordPhc: row.password_phc,
          role: row.role,
          businessId: row.business_id,
        }
      : null;
  }
  async findByEmail(email: string) {
    return this.map(
      (
        await this
          .current`select normalized_email,password_phc,role,business_id from auth_identities where normalized_email=${email} limit 1`
      )[0] as never,
    );
  }
  async findPlatformAdmin() {
    return this.map(
      (
        await this
          .current`select normalized_email,password_phc,role,business_id from auth_identities where role='platform_admin' limit 1`
      )[0] as never,
    );
  }
  async insertPlatformAdmin(email: string, passwordPhc: string) {
    const row = (
      await this
        .current`insert into auth_identities(normalized_email,password_phc,role,business_id) values(${email},${passwordPhc},'platform_admin',null) returning normalized_email,password_phc,role,business_id`
    )[0];
    return this.map(row as never)!;
  }
  async exclusive<T>(work: () => Promise<T>) {
    return this.sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('agendia:bootstrap-admin'))`;
      // SAFETY: postgres.js transactions preserve the Sql tagged-template contract for this callback's lifetime.
      this.current = transaction as unknown as Sql;
      try {
        return await work();
      } finally {
        this.current = this.sql;
      }
    }) as Promise<T>;
  }
  async close() {
    await this.sql.end();
  }
}

export async function bootstrapAdminFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  const input = validateAdminInput(
    env.AGENDIA_ADMIN_EMAIL,
    env.AGENDIA_ADMIN_PASSWORD,
  );
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const store = new PostgresAdminStore(postgres(env.DATABASE_URL, { max: 1 }));
  try {
    return await provisionAdmin(input, store);
  } finally {
    await store.close();
  }
}

if (import.meta.main) {
  try {
    const result = await bootstrapAdminFromEnvironment();
    console.log(
      JSON.stringify({ event: "admin.bootstrap", outcome: result.outcome }),
    );
  } catch {
    console.error(
      JSON.stringify({ event: "admin.bootstrap", outcome: "failure" }),
    );
    process.exitCode = 1;
  }
}

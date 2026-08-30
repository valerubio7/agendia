/** Public boundary for @agendia/test-support. */
export const packageName = "@agendia/test-support" as const;
export * from "./postgres.ts";
export * from "./tdd-evidence.ts";
export * from "./v1-acceptance.ts";
export * from "./baileys.ts";
export * from "./worker-fixtures.ts";

export function assertNonEmptyTenantRows(rows: { business_id: string }[], tenantId: string): void {
  if (rows.length === 0) throw new Error("Tenant isolation requires a non-empty collection");
  if (!rows.every((row) => row.business_id === tenantId)) {
    throw new Error(`Tenant isolation returned a row outside ${tenantId}`);
  }
}

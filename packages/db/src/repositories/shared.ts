import type { Row } from "postgres";
import { DrizzleQueryError, is, sql, type SQL } from "drizzle-orm";
import { PostgresJsTransaction, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

export type Db = PostgresJsDatabase<Record<string, unknown>>;
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const isTransaction = (db: Db): db is Transaction => is(db, PostgresJsTransaction);

// Keep native SQLSTATE/constraint and safe native messages at every repository catch boundary.
export async function result<T>(query: PromiseLike<T>): Promise<T> {
  try { return await query; }
  catch (error) {
    while (error instanceof DrizzleQueryError && error.cause) error = error.cause;
    throw error;
  }
}

/** Raw execute has no column codecs. Restore only the driver's timestamp contract,
 * in place so RowList count, command and column metadata survive (including UPDATE without RETURNING).
 */
export async function execute<T extends Row = Row>(db: Db, query: SQL) {
  const rows = await result(db.execute<T>(query));
  for (const column of rows.columns ?? []) {
    if (![1082, 1114, 1184].includes(column.type)) continue;
    for (const row of rows as Row[]) {
      const value = row[column.name];
      if (value !== null && value !== undefined && !(value instanceof Date)) row[column.name] = new Date(value);
    }
  }
  return rows;
}

export const appointmentId = z.uuid().transform(id => id.toLowerCase());

// Preserve postgres.js JSON parameter semantics: normalized top-level null binds SQL NULL.
export function asDbJson(value: unknown): SQL {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON serializable");
    const normalized = JSON.parse(encoded);
    return sql`${normalized === null ? null : JSON.stringify(normalized)}::jsonb`;
  } catch {
    throw new Error("Value must be JSON serializable");
  }
}

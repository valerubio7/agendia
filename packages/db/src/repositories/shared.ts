import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

export type Db = Sql | TransactionSql;

export const appointmentId = z.uuid().transform(id => id.toLowerCase());

type DbJson = Parameters<Sql["json"]>[0];
export function asDbJson(value: unknown): DbJson {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON serializable");
    return JSON.parse(encoded) as DbJson;
  } catch {
    throw new Error("Value must be JSON serializable");
  }
}

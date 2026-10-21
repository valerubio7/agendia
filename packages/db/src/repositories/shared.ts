import type { Sql, TransactionSql } from "postgres";

export type Db = Sql | TransactionSql;

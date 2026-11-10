import { is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { Sql, TransactionSql } from "postgres";

const dialect = new PgDialect();
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const render = (expression: SQL) => dialect.sqlToQuery(expression.inlineParams()).sql;

// Test-only materialization of public Drizzle metadata, NOT a migration generator.
// PostgreSQL canonicalizes expressions on both sides; no SQL-string normalization parser.
export async function materializeTables(db: Sql, tables: PgTable[], schema: string) {
  const qualified = (name: string) => `${identifier(schema)}.${identifier(name)}`;
  await db.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
  for (const table of tables) {
    const config = getTableConfig(table);
    const columns = config.columns.map(column => {
      let definition = `${identifier(column.name)} ${column.getSQLType()}`;
      // Drizzle 0.45.2 has no column COLLATE API. These two clauses remain SQL-only.
      if (["services", "resources"].includes(config.name) && column.name === "normalized_name") definition += ' COLLATE "C"';
      if (column.generated) {
        const expression = typeof column.generated.as === "function" ? column.generated.as() : column.generated.as;
        definition += ` GENERATED ALWAYS AS (${is(expression, SQL) ? render(expression) : String(expression)}) STORED`;
      } else if (column.default !== undefined) {
        definition += ` DEFAULT ${is(column.default, SQL) ? render(column.default) : render(sql`${column.default}`)}`;
      }
      if (column.notNull) definition += " NOT NULL";
      if (column.primary) definition += " PRIMARY KEY";
      if (column.isUnique) definition += ` CONSTRAINT ${identifier(column.uniqueName!)} UNIQUE${column.uniqueType === "not distinct" ? " NULLS NOT DISTINCT" : ""}`;
      return definition;
    });
    const names = (columns: { name: string }[]) => columns.map(c => identifier(c.name)).join(", ");
    for (const key of config.primaryKeys) columns.push(`CONSTRAINT ${identifier(key.getName())} PRIMARY KEY (${names(key.columns)})`);
    for (const key of config.uniqueConstraints) {
      const name = key.getName();
      if (!name) throw new Error("Missing unique constraint name in parity metadata");
      columns.push(`CONSTRAINT ${identifier(name)} UNIQUE${key.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} (${names(key.columns)})`);
    }
    for (const key of config.checks) columns.push(`CONSTRAINT ${identifier(key.name)} CHECK (${render(key.value)})`);
    await db.unsafe(`CREATE TABLE ${qualified(config.name)} (${columns.join(",\n")})`);
  }
  for (const table of tables) {
    const config = getTableConfig(table);
    for (const key of config.foreignKeys) {
      const ref = key.reference();
      await db.unsafe(`ALTER TABLE ${qualified(config.name)} ADD CONSTRAINT ${identifier(key.getName())}
        FOREIGN KEY (${ref.columns.map(c => identifier(c.name)).join(", ")})
        REFERENCES ${qualified(getTableConfig(ref.foreignTable).name)} (${ref.foreignColumns.map(c => identifier(c.name)).join(", ")})
        ON UPDATE ${key.onUpdate ?? "no action"} ON DELETE ${key.onDelete ?? "no action"}`);
    }
    for (const { config: index } of config.indexes) {
      if (!index.name || index.concurrently || index.with) throw new Error("Unsupported index metadata in parity materializer");
      const columns = index.columns.map(column => {
        if (is(column, SQL)) return `(${render(column)})`;
        if (!("name" in column) || !column.name) throw new Error("Missing indexed column name");
        const options = column.indexConfig;
        return `${identifier(column.name)}${options?.opClass ? ` ${options.opClass}` : ""}${options?.order ? ` ${options.order}` : ""}${options?.nulls ? ` NULLS ${options.nulls}` : ""}`;
      });
      await db.unsafe(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${identifier(index.name)} ON ${index.only ? "ONLY " : ""}${qualified(config.name)}
        USING ${index.method ?? "btree"} (${columns.join(", ")})${index.where ? ` WHERE ${render(index.where)}` : ""}`);
    }
    if (config.enableRLS) await db.unsafe(`ALTER TABLE ${qualified(config.name)} ENABLE ROW LEVEL SECURITY`);
    for (const policy of config.policies) {
      const roles = policy.to === undefined ? ["public"] : Array.isArray(policy.to) ? policy.to : [policy.to];
      if (!roles.every(role => typeof role === "string")) throw new Error("Parity requires explicit policy role names");
      await db.unsafe(`CREATE POLICY ${identifier(policy.name)} ON ${qualified(config.name)} AS ${policy.as ?? "permissive"}
        FOR ${policy.for ?? "all"} TO ${roles.map(role => identifier(String(role))).join(", ")}
        ${policy.using ? `USING (${render(policy.using)})` : ""}
        ${policy.withCheck ? `WITH CHECK (${render(policy.withCheck)})` : ""}`);
    }
  }
}

export async function tableCatalog(db: Sql | TransactionSql, schema: string, table: string) {
  const relation = `${schema}.${table}`;
  const columns = await db`select a.attname as name, format_type(a.atttypid,a.atttypmod) as type,
    a.attnotnull as not_null, a.attgenerated as generated, pg_get_expr(d.adbin,d.adrelid) as expression,
    case when a.attcollation=0 then null else c.collname end as collation
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    left join pg_collation c on c.oid=a.attcollation
    where a.attrelid=to_regclass(${relation}) and a.attnum>0 and not a.attisdropped order by a.attnum`;
  const constraints = await db`select conname as name, contype::text as type,
    replace(pg_get_constraintdef(oid), ${schema + "."}, '') as definition,
    condeferrable, condeferred, convalidated from pg_constraint
    where conrelid=to_regclass(${relation}) and contype<>'x' order by conname`;
  const indexes = await db`select ci.relname as name, am.amname as method, i.indisunique as unique,
    i.indisvalid as valid, i.indisready as ready, i.indnkeyatts as key_count,
    i.indoption::text as ordering,
    array(select n.nspname || '.' || o.opcname from unnest(i.indclass) with ordinality k(oid,ord)
      join pg_opclass o on o.oid=k.oid join pg_namespace n on n.oid=o.opcnamespace order by k.ord) as operator_classes,
    array(select c.collname from unnest(i.indcollation) with ordinality k(oid,ord)
      left join pg_collation c on c.oid=k.oid order by k.ord) as collations,
    array(select pg_get_indexdef(i.indexrelid,k,true) from generate_series(1,i.indnatts) k) as columns,
    pg_get_expr(i.indpred,i.indrelid) as predicate
    from pg_index i join pg_class ci on ci.oid=i.indexrelid join pg_am am on am.oid=ci.relam
    where i.indrelid=to_regclass(${relation}) and not exists
      (select 1 from pg_constraint c where c.conindid=i.indexrelid) order by ci.relname`;
  const policies = await db`select policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname=${schema} and tablename=${table} order by policyname`;
  const flags = await db`select relrowsecurity from pg_class where oid=to_regclass(${relation})`;
  return { columns: [...columns], constraints: [...constraints], indexes: [...indexes], policies: [...policies], flags: [...flags] };
}

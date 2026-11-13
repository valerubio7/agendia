import postgres, { type Sql } from "postgres";
import { migrateDatabase } from "./db-migrate.ts";
import { quoteIdentifier } from "./provision-production-db.ts";

// Dokploy restores with `pg_restore -O --clean --if-exists`, so the archive's
// owners and ACLs are absent. This repair rebuilds the intended state from a
// disposable reference database created with the current migrations, then
// replays only owners and privileges onto the restored database.
const APPLICATION_NAME = "agendia-restore-repair";
const LOCK_KEY = "agendia:restore-repair";
export const REFERENCE_PREFIX = "agendia_repair_reference_";
const PGBOSS_OWNER = "agendia_worker";

export class RestoreRepairError extends Error {}

interface Grant {
  grantee: string;
  privilege: string;
  grantable: boolean;
  column?: string;
}

interface RelationSnapshot {
  schema: string;
  name: string;
  kind: string;
  owner: string;
  grants: Grant[];
}

interface RoutineSnapshot {
  schema: string;
  name: string;
  identityArguments: string;
  owner: string;
  grants: Grant[];
}

interface TypeSnapshot {
  schema: string;
  name: string;
  typeKind: string;
  owner: string;
  grants: Grant[];
}

interface SchemaSnapshot {
  name: string;
  owner: string;
  grants: Grant[];
}

interface CollationSnapshot {
  schema: string;
  name: string;
  owner: string;
}

interface DatabaseSnapshot {
  relations: RelationSnapshot[];
  routines: RoutineSnapshot[];
  types: TypeSnapshot[];
  schemas: SchemaSnapshot[];
  collations: CollationSnapshot[];
}

interface PgbossSnapshot {
  relations: Omit<RelationSnapshot, "schema" | "grants">[];
  routines: Omit<RoutineSnapshot, "schema" | "grants">[];
  types: Omit<TypeSnapshot, "schema" | "grants">[];
}

interface SnapshotIndex {
  relations: Map<string, RelationSnapshot>;
  routines: Map<string, RoutineSnapshot>;
  types: Map<string, TypeSnapshot>;
  schemas: Map<string, SchemaSnapshot>;
  collations: Map<string, CollationSnapshot>;
}

export interface RepairResult {
  referenceDatabase: string;
  ownersRepaired: number;
  grantsRepaired: number;
  outboxCancelled: number;
  commandsCancelled: number;
  jobsCancelled: number;
}

const capabilities = [
  "agendia_runtime",
  "agendia_admin_runtime",
  "agendia_whatsapp_runtime",
  "agendia_worker_runtime",
  "agendia_business_purge",
] as const;

const logins = [
  { name: "agendia_api", roles: ["agendia_runtime"] },
  { name: "agendia_admin", roles: ["agendia_admin_runtime"] },
  { name: "agendia_worker", roles: ["agendia_worker_runtime"] },
  { name: "agendia_manager", roles: ["agendia_whatsapp_runtime", "agendia_worker_runtime"] },
] as const;

const grantablePrivileges = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
  "EXECUTE", "USAGE", "CREATE", "CONNECT", "TEMPORARY",
]);

function identity(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function routineIdentity(routine: { schema: string; name: string; identityArguments: string }): string {
  return `${identity(routine.schema, routine.name)}(${routine.identityArguments})`;
}

function relationOwnerStatement(relation: { schema: string; name: string; kind: string }, owner: string): string {
  const target = identity(relation.schema, relation.name);
  const quotedOwner = quoteIdentifier(owner);
  switch (relation.kind) {
    case "S": return `ALTER SEQUENCE ${target} OWNER TO ${quotedOwner}`;
    case "v": return `ALTER VIEW ${target} OWNER TO ${quotedOwner}`;
    case "m": return `ALTER MATERIALIZED VIEW ${target} OWNER TO ${quotedOwner}`;
    case "f": return `ALTER FOREIGN TABLE ${target} OWNER TO ${quotedOwner}`;
    case "i":
    case "I": return `ALTER INDEX ${target} OWNER TO ${quotedOwner}`;
    default: return `ALTER TABLE ${target} OWNER TO ${quotedOwner}`;
  }
}

function routineOwnerStatement(routine: { schema: string; name: string; identityArguments: string }, owner: string): string {
  return `ALTER ROUTINE ${routineIdentity(routine)} OWNER TO ${quoteIdentifier(owner)}`;
}

function typeOwnerStatement(type: { schema: string; name: string; typeKind: string }, owner: string): string {
  const target = identity(type.schema, type.name);
  return type.typeKind === "d"
    ? `ALTER DOMAIN ${target} OWNER TO ${quoteIdentifier(owner)}`
    : `ALTER TYPE ${target} OWNER TO ${quoteIdentifier(owner)}`;
}

function collationOwnerStatement(collation: CollationSnapshot, owner: string): string {
  return `ALTER COLLATION ${identity(collation.schema, collation.name)} OWNER TO ${quoteIdentifier(owner)}`;
}

function schemaOwnerStatement(schema: SchemaSnapshot, owner: string): string {
  return `ALTER SCHEMA ${quoteIdentifier(schema.name)} OWNER TO ${quoteIdentifier(owner)}`;
}

function aclTarget(object: SchemaSnapshot | RelationSnapshot | RoutineSnapshot | TypeSnapshot): { kind: string; identity: string } {
  if ("identityArguments" in object)
    return { kind: "ROUTINE", identity: routineIdentity(object) };
  if ("typeKind" in object)
    return { kind: object.typeKind === "d" ? "DOMAIN" : "TYPE", identity: identity(object.schema, object.name) };
  if ("kind" in object)
    return { kind: object.kind === "S" ? "SEQUENCE" : "TABLE", identity: identity(object.schema, object.name) };
  return { kind: "SCHEMA", identity: quoteIdentifier(object.name) };
}

function grantee(value: string): string {
  return value === "PUBLIC" ? "PUBLIC" : quoteIdentifier(value);
}

function grantKey(grant: Grant): string {
  return `${grant.grantee}\0${grant.privilege}\0${grant.column ?? ""}`;
}

function indexSnapshot(snapshot: DatabaseSnapshot): SnapshotIndex {
  return {
    relations: new Map(snapshot.relations.map((relation) => [`${relation.schema}.${relation.name}`, relation])),
    routines: new Map(snapshot.routines.map((routine) => [`${routine.schema}.${routine.name}(${routine.identityArguments})`, routine])),
    types: new Map(snapshot.types.map((type) => [`${type.schema}.${type.name}`, type])),
    schemas: new Map(snapshot.schemas.map((schema) => [schema.name, schema])),
    collations: new Map(snapshot.collations.map((collation) => [`${collation.schema}.${collation.name}`, collation])),
  };
}

function assertSameObjects(expected: SnapshotIndex, actual: SnapshotIndex): void {
  for (const [key, expectedObject] of expected.relations) {
    const actualObject = actual.relations.get(key);
    if (!actualObject) throw new RestoreRepairError(`Restored database is missing relation ${key}`);
    if (actualObject.kind !== expectedObject.kind)
      throw new RestoreRepairError(`Restored database has a different relation kind for ${key}`);
  }
  for (const key of actual.relations.keys())
    if (!expected.relations.has(key)) throw new RestoreRepairError(`Restored database has an unexpected relation ${key}`);
  for (const [key, expectedObject] of expected.routines) {
    const actualObject = actual.routines.get(key);
    if (!actualObject) throw new RestoreRepairError(`Restored database is missing routine ${key}`);
  }
  for (const key of actual.routines.keys())
    if (!expected.routines.has(key)) throw new RestoreRepairError(`Restored database has an unexpected routine ${key}`);
  for (const [key, expectedObject] of expected.types) {
    const actualObject = actual.types.get(key);
    if (!actualObject) throw new RestoreRepairError(`Restored database is missing type ${key}`);
    if (actualObject.typeKind !== expectedObject.typeKind)
      throw new RestoreRepairError(`Restored database has a different type kind for ${key}`);
  }
  for (const key of actual.types.keys())
    if (!expected.types.has(key)) throw new RestoreRepairError(`Restored database has an unexpected type ${key}`);
  for (const key of expected.schemas.keys())
    if (!actual.schemas.has(key)) throw new RestoreRepairError(`Restored database is missing schema ${key}`);
  for (const key of actual.schemas.keys())
    if (!expected.schemas.has(key)) throw new RestoreRepairError(`Restored database has an unexpected schema ${key}`);
  for (const key of expected.collations.keys())
    if (!actual.collations.has(key)) throw new RestoreRepairError(`Restored database is missing collation ${key}`);
  for (const key of actual.collations.keys())
    if (!expected.collations.has(key)) throw new RestoreRepairError(`Restored database has an unexpected collation ${key}`);
}

function ownerStatements(expected: SnapshotIndex, actual: SnapshotIndex): string[] {
  const statements: string[] = [];
  for (const [key, expectedObject] of expected.schemas) {
    const actualObject = actual.schemas.get(key);
    if (actualObject && actualObject.owner !== expectedObject.owner)
      statements.push(schemaOwnerStatement(expectedObject, expectedObject.owner));
  }
  for (const [key, expectedObject] of expected.relations) {
    // An index always follows its table; PostgreSQL rejects ALTER INDEX OWNER.
    if (expectedObject.kind === "i" || expectedObject.kind === "I") continue;
    const actualObject = actual.relations.get(key);
    if (actualObject && actualObject.owner !== expectedObject.owner)
      statements.push(relationOwnerStatement(expectedObject, expectedObject.owner));
  }
  for (const [key, expectedObject] of expected.routines) {
    const actualObject = actual.routines.get(key);
    if (actualObject && actualObject.owner !== expectedObject.owner)
      statements.push(routineOwnerStatement(expectedObject, expectedObject.owner));
  }
  for (const [key, expectedObject] of expected.types) {
    const actualObject = actual.types.get(key);
    if (actualObject && actualObject.owner !== expectedObject.owner)
      statements.push(typeOwnerStatement(expectedObject, expectedObject.owner));
  }
  for (const [key, expectedObject] of expected.collations) {
    const actualObject = actual.collations.get(key);
    if (actualObject && actualObject.owner !== expectedObject.owner)
      statements.push(collationOwnerStatement(expectedObject, expectedObject.owner));
  }
  return statements;
}

function indexOwnerDifferences(expected: SnapshotIndex, actual: SnapshotIndex): string[] {
  const differences: string[] = [];
  for (const [key, expectedObject] of expected.relations) {
    if (expectedObject.kind !== "i" && expectedObject.kind !== "I") continue;
    const actualObject = actual.relations.get(key);
    if (actualObject && actualObject.owner !== expectedObject.owner) differences.push(key);
  }
  return differences;
}

function aclStatements(expected: SnapshotIndex, actual: SnapshotIndex): string[] {
  const statements: string[] = [];
  const objects: Array<SchemaSnapshot | RelationSnapshot | RoutineSnapshot | TypeSnapshot> = [
    ...expected.schemas.values(),
    ...[...expected.relations.values()].filter((relation) => relation.kind !== "i" && relation.kind !== "I"),
    ...expected.routines.values(),
    ...expected.types.values(),
  ];
  for (const expectedObject of objects) {
    const { kind, identity: target } = aclTarget(expectedObject);
    const actualObject = "identityArguments" in expectedObject
      ? actual.routines.get(`${expectedObject.schema}.${expectedObject.name}(${expectedObject.identityArguments})`)
      : "typeKind" in expectedObject
        ? actual.types.get(`${expectedObject.schema}.${expectedObject.name}`)
        : "kind" in expectedObject
          ? actual.relations.get(`${expectedObject.schema}.${expectedObject.name}`)
          : actual.schemas.get(expectedObject.name);
    if (!actualObject) continue;
    const expectedGrants = new Map(expectedObject.grants.map((grant) => [grantKey(grant), grant]));
    const actualGrants = new Map(actualObject.grants.map((grant) => [grantKey(grant), grant]));
    for (const [key, actualGrant] of actualGrants) {
      if (!grantablePrivileges.has(actualGrant.privilege))
        throw new RestoreRepairError(`Restored database has an unsupported privilege ${actualGrant.privilege}`);
      const privilege = actualGrant.column
        ? `${actualGrant.privilege} (${quoteIdentifier(actualGrant.column)})` : actualGrant.privilege;
      const expectedGrant = expectedGrants.get(key);
      if (!expectedGrant) {
        statements.push(`REVOKE ${privilege} ON ${kind} ${target} FROM ${grantee(actualGrant.grantee)}`);
      } else if (expectedGrant.grantable !== actualGrant.grantable) {
        statements.push(expectedGrant.grantable
          ? `GRANT ${privilege} ON ${kind} ${target} TO ${grantee(actualGrant.grantee)} WITH GRANT OPTION`
          : `REVOKE GRANT OPTION FOR ${privilege} ON ${kind} ${target} FROM ${grantee(actualGrant.grantee)}`);
      }
    }
    for (const [key, expectedGrant] of expectedGrants) {
      if (actualGrants.has(key)) continue;
      if (!grantablePrivileges.has(expectedGrant.privilege))
        throw new RestoreRepairError(`Reference database has an unsupported privilege ${expectedGrant.privilege}`);
      const privilege = expectedGrant.column
        ? `${expectedGrant.privilege} (${quoteIdentifier(expectedGrant.column)})` : expectedGrant.privilege;
      statements.push(`GRANT ${privilege} ON ${kind} ${target} TO ${grantee(expectedGrant.grantee)}${expectedGrant.grantable ? " WITH GRANT OPTION" : ""}`);
    }
  }
  return statements;
}

async function snapshotPublic(sql: Sql): Promise<DatabaseSnapshot> {
  const relations = await sql<RelationSnapshot[]>`
    select n.nspname as schema, c.relname as name, c.relkind::text as kind,
      pg_get_userbyid(c.relowner) as owner,
      coalesce((select jsonb_agg(jsonb_build_object(
          'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          'privilege', a.privilege_type,
          'grantable', a.is_grantable))
        from aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
        where a.grantee <> c.relowner), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object(
          'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          'privilege', a.privilege_type,
          'grantable', a.is_grantable,
          'column', attribute.attname))
        from pg_attribute attribute cross join lateral aclexplode(attribute.attacl) a
        where attribute.attrelid = c.oid and attribute.attnum > 0
          and not attribute.attisdropped and a.grantee <> c.relowner), '[]'::jsonb) as grants
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r','p','v','m','S','f','i','I')
      and not exists (select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by c.relname`;
  const routines = await sql<RoutineSnapshot[]>`
    select n.nspname as schema, p.proname as name,
      pg_get_function_identity_arguments(p.oid) as "identityArguments",
      pg_get_userbyid(p.proowner) as owner,
      coalesce((select jsonb_agg(jsonb_build_object(
          'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          'privilege', a.privilege_type,
          'grantable', a.is_grantable))
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee <> p.proowner), '[]'::jsonb) as grants
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    order by p.proname, p.oid`;
  const types = await sql<TypeSnapshot[]>`
    select n.nspname as schema, t.typname as name, t.typtype::text as "typeKind",
      pg_get_userbyid(t.typowner) as owner,
      coalesce((select jsonb_agg(jsonb_build_object(
          'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          'privilege', a.privilege_type,
          'grantable', a.is_grantable))
        from aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) a
        where a.grantee <> t.typowner), '[]'::jsonb) as grants
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typrelid = 0
      and not (t.typelem <> 0 and t.typarray = 0)
      and not exists (select 1 from pg_depend d
        where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
    order by t.typname`;
  const schemas = await sql<SchemaSnapshot[]>`
    select nspname as name, pg_get_userbyid(nspowner) as owner,
      coalesce((select jsonb_agg(jsonb_build_object(
          'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          'privilege', a.privilege_type,
          'grantable', a.is_grantable))
        from aclexplode(coalesce(nspacl, acldefault('n', nspowner))) a
        where a.grantee <> nspowner), '[]'::jsonb) as grants
    from pg_namespace
    where nspname in ('public', 'pgboss')
    order by nspname`;
  const collations = await sql<CollationSnapshot[]>`
    select n.nspname as schema, c.collname as name, pg_get_userbyid(c.collowner) as owner
    from pg_collation c
    join pg_namespace n on n.oid = c.collnamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d
        where d.classid = 'pg_collation'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by c.collname`;
  return { relations, routines, types, schemas, collations };
}

async function snapshotPgboss(sql: Sql): Promise<PgbossSnapshot> {
  const relations = await sql<PgbossSnapshot["relations"]>`
    select c.relname as name, c.relkind::text as kind, pg_get_userbyid(c.relowner) as owner
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pgboss'
      and c.relkind in ('r','p','v','m','S','f','i','I')
      and not exists (select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by c.relname`;
  const routines = await sql<PgbossSnapshot["routines"]>`
    select p.proname as name, pg_get_function_identity_arguments(p.oid) as "identityArguments",
      pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pgboss'
    order by p.proname, p.oid`;
  const types = await sql<PgbossSnapshot["types"]>`
    select t.typname as name, t.typtype::text as "typeKind", pg_get_userbyid(t.typowner) as owner
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'pgboss'
      and t.typrelid = 0
      and not (t.typelem <> 0 and t.typarray = 0)
    order by t.typname`;
  return { relations, routines, types };
}

async function apply(sql: Sql, statements: string[]): Promise<number> {
  if (!statements.length) return 0;
  await sql.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
  return statements.length;
}

async function assertRoles(sql: Sql): Promise<void> {
  const [current] = await sql<{ rolsuper: boolean }[]>`
    select rolsuper from pg_roles where rolname = current_user`;
  if (!current?.rolsuper)
    throw new RestoreRepairError("The repair requires a superuser migration role");
  for (const role of capabilities) {
    const [row] = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = ${role}`;
    if (!row) throw new RestoreRepairError(`Required capability role ${role} does not exist`);
    if (row.rolcanlogin || row.rolsuper || row.rolbypassrls)
      throw new RestoreRepairError(`Capability role ${role} has unsafe attributes`);
  }
  const memberships = await sql<{ role: string; member: string }[]>`
    select granted.rolname as role, member.rolname as member
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    where member.rolname like 'agendia_%'`;
  const granted = new Set(memberships.map((row) => `${row.member}\0${row.role}`));
  for (const login of logins) {
    const [row] = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = ${login.name}`;
    if (!row) throw new RestoreRepairError(`Required login role ${login.name} does not exist`);
    if (!row.rolcanlogin || row.rolsuper || row.rolbypassrls)
      throw new RestoreRepairError(`Login role ${login.name} has unsafe attributes`);
    for (const role of login.roles)
      if (!granted.has(`${login.name}\0${role}`))
        throw new RestoreRepairError(`Login role ${login.name} is missing membership in ${role}`);
  }
}

async function cancelPendingWork(sql: Sql): Promise<{ outbox: number; commands: number; jobs: number }> {
  const outbox = await sql`
    update public.outbox_events
    set published_at = now(), claim_token = null, claimed_at = null
    where published_at is null`;
  const commands = await sql`
    update public.outbound_commands
    set state = 'failed', failure_code = 'restore_cancelled', updated_at = now(),
      claimed_by = null, claimed_at = null, ownership_token = null
    where state in ('pending', 'processing', 'generated')`;
  const sending = await sql`
    update public.outbound_commands
    set state = 'delivery_unknown', failure_code = 'restore_cancelled', updated_at = now(),
      claimed_by = null, claimed_at = null, ownership_token = null
    where state = 'sending'`;
  const [job] = await sql<{ relation: string | null }[]>`
    select to_regclass('pgboss.job')::text as relation`;
  let jobs = 0;
  if (job?.relation) {
    const [count] = await sql<{ count: number }[]>`select count(*)::int as count from pgboss.job`;
    jobs = count?.count ?? 0;
    await sql`truncate pgboss.job`;
  }
  return { outbox: outbox.count, commands: commands.count + sending.count, jobs };
}

async function verify(sql: Sql, expectedSnapshot: DatabaseSnapshot): Promise<void> {
  const expected = indexSnapshot(expectedSnapshot);
  const actual = indexSnapshot(await snapshotPublic(sql));
  assertSameObjects(expected, actual);
  const owners = ownerStatements(expected, actual);
  if (owners.length)
    throw new RestoreRepairError(`Restored database still has ${owners.length} ownership differences`);
  const indexes = indexOwnerDifferences(expected, actual);
  if (indexes.length)
    throw new RestoreRepairError(`Restored database still has ${indexes.length} index ownership differences`);
  const grants = aclStatements(expected, actual);
  if (grants.length)
    throw new RestoreRepairError(`Restored database still has ${grants.length} privilege differences`);
  const pgboss = await snapshotPgboss(sql);
  for (const relation of pgboss.relations)
    if (relation.owner !== PGBOSS_OWNER)
      throw new RestoreRepairError(`pgboss relation ${relation.name} is owned by ${relation.owner}`);
  for (const routine of pgboss.routines)
    if (routine.owner !== PGBOSS_OWNER)
      throw new RestoreRepairError(`pgboss routine ${routine.name} is owned by ${routine.owner}`);
  for (const type of pgboss.types)
    if (type.owner !== PGBOSS_OWNER)
      throw new RestoreRepairError(`pgboss type ${type.name} is owned by ${type.owner}`);
  const [outbox] = await sql<{ count: number }[]>`
    select count(*)::int as count from public.outbox_events where published_at is null`;
  if (outbox?.count !== 0)
    throw new RestoreRepairError(`Restored database still has ${outbox?.count ?? "unknown"} unpublished outbox events`);
  const [commands] = await sql<{ count: number }[]>`
    select count(*)::int as count from public.outbound_commands
    where state in ('pending', 'processing', 'generated', 'sending')`;
  if (commands?.count !== 0)
    throw new RestoreRepairError(`Restored database still has ${commands?.count ?? "unknown"} pending outbound commands`);
  const [job] = await sql<{ relation: string | null }[]>`
    select to_regclass('pgboss.job')::text as relation`;
  if (job?.relation) {
    const [jobs] = await sql<{ count: number }[]>`select count(*)::int as count from pgboss.job`;
    if (jobs?.count !== 0)
      throw new RestoreRepairError(`Restored database still has ${jobs?.count ?? "unknown"} queued jobs`);
  }
}

async function dropReference(sql: Sql, name: string): Promise<void> {
  try {
    await sql.unsafe(`drop database if exists ${quoteIdentifier(name)}`);
  } catch {
    console.error(`Restore repair warning: could not drop temporary database ${name}`);
  }
}

export async function repairRestoredDatabase(
  url: string | undefined = process.env.DATABASE_URL,
): Promise<RepairResult> {
  if (!url?.trim()) throw new RestoreRepairError("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RestoreRepairError("DATABASE_URL must be a PostgreSQL URL");
  }
  if (!parsed.hostname) throw new RestoreRepairError("DATABASE_URL must include a host");
  const sql = postgres(url, { max: 1, connection: { application_name: APPLICATION_NAME } });
  let reference: Sql | undefined;
  let referenceName: string | undefined;
  try {
    await sql`select pg_advisory_lock(hashtext(${LOCK_KEY}))`;
    await assertRoles(sql);
    const name = `${REFERENCE_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await sql.unsafe(`create database ${quoteIdentifier(name)} template template0`);
    referenceName = name;
    const referenceUrl = new URL(url);
    referenceUrl.pathname = `/${referenceName}`;
    reference = postgres(referenceUrl.toString(), {
      max: 1,
      connection: { application_name: `${APPLICATION_NAME}-reference` },
    });
    await migrateDatabase(reference);
    const expected = await snapshotPublic(reference);
    const restored = await snapshotPublic(sql);
    const expectedIndex = indexSnapshot(expected);
    const restoredIndex = indexSnapshot(restored);
    assertSameObjects(expectedIndex, restoredIndex);
    const ownersRepaired = await apply(sql, ownerStatements(expectedIndex, restoredIndex));
    const afterOwners = indexSnapshot(await snapshotPublic(sql));
    const grantsRepaired = await apply(sql, aclStatements(expectedIndex, afterOwners));
    const pgboss = await snapshotPgboss(sql);
    const pgbossStatements = [
      ...pgboss.relations.map((relation) => ({ ...relation, schema: "pgboss" }))
        .filter((relation) => relation.owner !== PGBOSS_OWNER && relation.kind !== "i" && relation.kind !== "I")
        .map((relation) => relationOwnerStatement(relation, PGBOSS_OWNER)),
      ...pgboss.routines.map((routine) => ({ ...routine, schema: "pgboss" }))
        .filter((routine) => routine.owner !== PGBOSS_OWNER)
        .map((routine) => routineOwnerStatement(routine, PGBOSS_OWNER)),
      ...pgboss.types.map((type) => ({ ...type, schema: "pgboss" }))
        .filter((type) => type.owner !== PGBOSS_OWNER)
        .map((type) => typeOwnerStatement(type, PGBOSS_OWNER)),
    ];
    const pgbossRepaired = await apply(sql, pgbossStatements);
    const cancelled = await cancelPendingWork(sql);
    await verify(sql, expected);
    return {
      referenceDatabase: referenceName,
      ownersRepaired: ownersRepaired + pgbossRepaired,
      grantsRepaired,
      outboxCancelled: cancelled.outbox,
      commandsCancelled: cancelled.commands,
      jobsCancelled: cancelled.jobs,
    };
  } finally {
    if (reference) await reference.end();
    if (referenceName) await dropReference(sql, referenceName);
    try {
      await sql`select pg_advisory_unlock(hashtext(${LOCK_KEY}))`;
    } catch {
      // The session lock is released when the connection closes.
    }
    await sql.end();
  }
}

if (import.meta.main) {
  try {
    const result = await repairRestoredDatabase();
    console.log(
      `Restore repair completed: ${result.ownersRepaired} owners, ${result.grantsRepaired} grants, ` +
      `${result.outboxCancelled} outbox events, ${result.commandsCancelled} outbound commands, ` +
      `${result.jobsCancelled} queued jobs.`,
    );
  } catch (error) {
    console.error(error instanceof RestoreRepairError
      ? `Restore repair failed: ${error.message}`
      : "Restore repair failed; database details withheld.");
    process.exitCode = 1;
  }
}

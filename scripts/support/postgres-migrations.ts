import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseManifest } from "@agendia/release-manifest";
import { validateReleaseManifest } from "@agendia/release-manifest";
import type { Sql } from "postgres";
import { postgresImage } from "./locked-images.ts";

const schemaQuery = `
  select kind, identity, definition from (
    select 'relation' as kind, n.nspname || '.' || c.relname as identity,
      concat(c.relkind, ':rls=', c.relrowsecurity, ':force=', c.relforcerowsecurity) as definition
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and c.relname not in ('agendia_schema_migrations')
    union all
    select 'column', n.nspname || '.' || c.relname || '.' || a.attname,
      format_type(a.atttypid, a.atttypmod) || ':notnull=' || a.attnotnull || ':default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and a.attnum > 0 and not a.attisdropped
      and c.relname not in ('agendia_schema_migrations')
    union all
    select 'constraint', n.nspname || '.' || c.relname || '.' || x.conname, pg_get_constraintdef(x.oid, true)
    from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname not in ('agendia_schema_migrations')
    union all
    select 'index', schemaname || '.' || tablename || '.' || indexname, indexdef
    from pg_indexes where schemaname = 'public' and tablename <> 'agendia_schema_migrations'
    union all
    select 'policy', schemaname || '.' || tablename || '.' || policyname,
      concat(cmd, ':', permissive, ':', coalesce(qual, ''), ':', coalesce(with_check, ''))
    from pg_policies where schemaname = 'public' and tablename <> 'agendia_schema_migrations'
    union all
    select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid, true)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal and c.relname <> 'agendia_schema_migrations'
    union all
    select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all
    select 'role', rolname, concat('bypassrls=', rolbypassrls, ':super=', rolsuper, ':login=', rolcanlogin)
    from pg_roles where rolname like 'agendia_%'
  ) schema_objects order by kind, identity, definition`;

export async function schemaObjects(sql: Sql) {
	return sql.unsafe<{ kind: string; identity: string; definition: string }[]>(
		schemaQuery,
	);
}

export async function schemaFingerprint(sql: Sql): Promise<string> {
	return createHash("sha256")
		.update(JSON.stringify(await schemaObjects(sql)))
		.digest("hex");
}

export interface MigrationVerificationOptions {
	migrationDirectory: string;
	mutateActual?: (sql: Sql) => Promise<unknown> | unknown;
}

async function startVerificationPostgres() {
	// Keep the verification-only Testcontainers dependency out of the packaged migrator.
	const testcontainersModule = "@testcontainers/postgresql";
	const postgresModule = "postgres";
	const { PostgreSqlContainer } = await import(testcontainersModule);
	const postgres = (await import(postgresModule)).default;
	const container = await new PostgreSqlContainer(postgresImage).start();
	const sql = postgres(container.getConnectionUri(), { max: 4 });
	return {
		sql,
		async stop() {
			await sql.end();
			await container.stop();
		},
	};
}

async function applyMigrationFiles(
	sql: Sql,
	directory: string,
): Promise<number> {
	const files = migrationFiles(directory);
	for (const file of files) await sql.unsafe(file.sql);
	return files.length;
}

export async function verifyPostgresMigrations(
	options: MigrationVerificationOptions,
) {
	const expected = await startVerificationPostgres();
	let migrationCount: number;
	let expectedFingerprint: string;
	try {
		migrationCount = await applyMigrationFiles(
			expected.sql,
			options.migrationDirectory,
		);
		expectedFingerprint = await schemaFingerprint(expected.sql);
	} finally {
		await expected.stop();
	}
	const actual = await startVerificationPostgres();
	try {
		await applyMigrationFiles(actual.sql, options.migrationDirectory);
		await options.mutateActual?.(actual.sql);
		const actualFingerprint = await schemaFingerprint(actual.sql);
		if (actualFingerprint !== expectedFingerprint)
			throw new Error(
				`Schema drift detected: expected ${expectedFingerprint}, received ${actualFingerprint}`,
			);
		return { migrationCount, schemaFingerprint: actualFingerprint };
	} finally {
		await actual.stop();
	}
}

export interface MigrationEvidence {
	backup?: {
		schemaVersion: 1;
		operation: "backup";
		environment: string;
		releaseDigest: string;
		finishedAt: string;
		result: "pass" | "fail";
	};
	host: {
		maintenanceWindow: boolean;
		appsStopped: boolean;
		workersStopped: boolean;
		stagingStopped: boolean;
		automationPaused: boolean;
	};
	previousReleaseDigest: string;
	cleanSchemaFingerprint?: string;
}

export interface GovernedMigrationOptions {
	sql: Sql;
	migrationDirectory: string;
	manifest: ReleaseManifest | unknown;
	evidence: MigrationEvidence;
	environment?: string;
	releaseDigest?: string;
	now?: Date;
}

interface MigrationFile {
	filename: string;
	sha256: string;
	sql: string;
}
const ledgerBootstrap = `create table if not exists agendia_schema_migrations (
  filename text primary key,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now(),
  release_digest text not null,
  execution text not null check (execution in ('migrated', 'baseline'))
)`;

function migrationFiles(directory: string): MigrationFile[] {
	return readdirSync(directory)
		.filter((filename) => filename.endsWith(".sql"))
		.sort()
		.map((filename) => {
			const sql = readFileSync(join(directory, filename), "utf8");
			if (
				/\b(?:create\s+index\s+concurrently|vacuum|alter\s+system)\b/i.test(sql)
			)
				throw new Error(`migration.non_transactional:${filename}`);
			return {
				filename,
				sql,
				sha256: createHash("sha256").update(sql).digest("hex"),
			};
		});
}

async function hasApplicationSchema(sql: Sql): Promise<boolean> {
	const [row] = await sql.unsafe<{ exists: boolean }[]>(`select exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and c.relname <> 'agendia_schema_migrations'
  ) as exists`);
	return row?.exists ?? false;
}

async function baselineMatches(
	sql: Sql,
	evidence: MigrationEvidence,
): Promise<boolean> {
	return (
		Boolean(evidence.cleanSchemaFingerprint?.match(/^[a-f0-9]{64}$/)) &&
		(await schemaFingerprint(sql)) === evidence.cleanSchemaFingerprint
	);
}

function validateEvidence(
	manifest: ReleaseManifest,
	evidence: MigrationEvidence,
	environment: string,
	now: Date,
): "rollback-permitted" | "not-promised" {
	const backup = evidence.backup;
	const finishedAt = backup ? Date.parse(backup.finishedAt) : Number.NaN;
	if (
		!backup ||
		backup.schemaVersion !== 1 ||
		backup.operation !== "backup" ||
		backup.result !== "pass" ||
		backup.environment !== environment ||
		backup.releaseDigest !== manifest.releaseDigest ||
		Number.isNaN(finishedAt) ||
		finishedAt > now.getTime() ||
		now.getTime() - finishedAt > 24 * 60 * 60 * 1000
	)
		throw new Error("migration.backup_evidence_invalid");
	if (manifest.database.compatibility === "expand-compatible") {
		if (
			evidence.previousReleaseDigest !== manifest.database.previousReleaseDigest
		)
			throw new Error("migration.previous_digest_mismatch");
		return "rollback-permitted";
	}
	if (
		!evidence.host.maintenanceWindow ||
		!evidence.host.appsStopped ||
		!evidence.host.workersStopped ||
		!evidence.host.stagingStopped ||
		!evidence.host.automationPaused
	)
		throw new Error("migration.maintenance_evidence_invalid");
	return "not-promised";
}

export async function runGovernedMigrations(options: GovernedMigrationOptions) {
	const manifest = validateReleaseManifest(options.manifest);
	const environment =
		options.environment ?? options.evidence.backup?.environment ?? "staging";
	const releaseDigest = options.releaseDigest ?? manifest.releaseDigest;
	if (releaseDigest !== manifest.releaseDigest)
		throw new Error("migration.release_digest_mismatch");
	const rollback = validateEvidence(
		manifest,
		options.evidence,
		environment,
		options.now ?? new Date(),
	);
	const [lock] = await options.sql.unsafe<{ acquired: boolean }[]>(
		"select pg_try_advisory_lock(hashtextextended('agendia:migrations', 0)) as acquired",
	);
	if (!lock?.acquired) throw new Error("migration.lock_unavailable");
	try {
		const files = migrationFiles(options.migrationDirectory);
		if (
			!files.some((file) => file.filename === manifest.database.minimumLedger)
		)
			throw new Error("migration.minimum_ledger_missing");
		const existingSchema = await hasApplicationSchema(options.sql);
		await options.sql.unsafe(ledgerBootstrap);
		const ledger = await options.sql.unsafe<
			{ filename: string; sha256: string }[]
		>(
			"select filename, sha256 from agendia_schema_migrations order by filename",
		);
		const byName = new Map(
			ledger.map((entry) => [entry.filename, entry.sha256]),
		);
		for (const file of files)
			if (
				byName.has(file.filename) &&
				byName.get(file.filename) !== file.sha256
			)
				throw new Error("migration.checksum_mismatch");
		const pending = files.filter((file) => !byName.has(file.filename));
		if (ledger.length === 0 && existingSchema) {
			if (!(await baselineMatches(options.sql, options.evidence)))
				throw new Error("migration.unledgered_drift");
			await options.sql.begin(async (tx) => {
				for (const file of files)
					await tx`insert into agendia_schema_migrations (filename, sha256, release_digest, execution) values (${file.filename}, ${file.sha256}, ${releaseDigest}, 'baseline')`;
			});
			return {
				schemaVersion: 1,
				execution: "baseline" as const,
				rollback,
				applied: files.map((file) => file.filename),
			};
		}
		for (const file of pending)
			await options.sql.begin(async (tx) => {
				await tx.unsafe(file.sql);
				await tx`insert into agendia_schema_migrations (filename, sha256, release_digest, execution) values (${file.filename}, ${file.sha256}, ${releaseDigest}, 'migrated')`;
			});
		return {
			schemaVersion: 1,
			execution: "migrated" as const,
			rollback,
			applied: pending.map((file) => file.filename),
		};
	} finally {
		await options.sql.unsafe(
			"select pg_advisory_unlock(hashtextextended('agendia:migrations', 0))",
		);
	}
}

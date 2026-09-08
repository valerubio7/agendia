import { readFileSync } from "node:fs";
import postgres from "postgres";
import { z } from "zod";

export const runtimeProcesses = [
	"web",
	"api",
	"whatsapp-manager",
	"message-worker",
	"migrate",
	"queue-init",
	"bootstrap-admin",
	"verify-config",
] as const;
export type RuntimeProcess = (typeof runtimeProcesses)[number];

type RuntimeEnvironment = Record<string, string | undefined>;

const identity = z.object({
	AGENDIA_ENVIRONMENT: z.enum(["development", "test", "staging", "production"]),
	AGENDIA_ENVIRONMENT_ID: z.string().uuid(),
	AGENDIA_SECRET_SET_ID: z.string().uuid(),
	AGENDIA_RELEASE_DIGEST: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const databaseVariable = (process: RuntimeProcess) =>
	`${process.toUpperCase().replaceAll("-", "_")}_DATABASE_URL_FILE`;

const fail = (
	name: string,
	reason: "is required" | "is invalid" | "is unavailable",
): never => {
	throw new Error(`${name} ${reason}`);
};

function readSecretFile(env: RuntimeEnvironment, name: string): string {
	if (Object.hasOwn(env, name.slice(0, -5))) fail(name, "is required");
	const path = env[name];
	if (!path) return fail(name, "is required");
	try {
		const value = readFileSync(path, "utf8").trim();
		if (!value) fail(name, "is unavailable");
		return value;
	} catch (error) {
		if (error instanceof Error && error.message === `${name} is unavailable`)
			throw error;
		return fail(name, "is unavailable");
	}
}

function validateDatabaseUrl(value: string, name: string): string {
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
			!url.hostname ||
			url.pathname === "/"
		)
			throw new Error();
		return value;
	} catch {
		return fail(name, "is invalid");
	}
}

function validateOrigin(value: string | undefined, environment: string) {
	if (!value) {
		if (environment === "staging" || environment === "production")
			fail("APP_ORIGIN", "is required");
		return undefined;
	}
	try {
		const origin = new URL(value);
		const isLocalDevelopmentOrigin =
			origin.protocol === "http:" &&
			["localhost", "127.0.0.1", "::1", "[::1]"].includes(origin.hostname);
		if (
			origin.origin !== value ||
			(environment === "development"
				? !isLocalDevelopmentOrigin
				: origin.protocol !== "https:")
		)
			throw new Error();
		return origin.origin;
	} catch {
		fail("APP_ORIGIN", "is invalid");
	}
}

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const environmentIdentity = z
	.object({
		environmentId: z.string().uuid(),
		secretSetId: z.string().uuid(),
		database: z
			.object({
				host: z.literal("postgres"),
				name: z.enum(["agendia_stg", "agendia_prod"]),
				loginPrefix: z.enum(["agendia_stg_", "agendia_prod_"]),
			})
			.strict(),
		criticalSecretHashes: z
			.object({
				databasePassword: fingerprint,
				providerKey: fingerprint,
				tunnelCredential: fingerprint,
				baileysKek: fingerprint,
				linkOrQrKey: fingerprint,
			})
			.strict(),
		whatsapp: z
			.object({
				identity: z.string(),
				allowlist: z.array(z.string()),
			})
			.strict(),
	})
	.strict();
const isolationManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		environments: z
			.object({
				staging: environmentIdentity,
				production: environmentIdentity,
			})
			.strict(),
	})
	.strict();

export type IsolationManifest = z.infer<typeof isolationManifestSchema>;
export interface EnvironmentMarker {
	environment: string;
	environmentId: string;
	secretSetId: string;
}
export class EnvironmentPreflightError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "EnvironmentPreflightError";
	}
}

const preflightFail = (code: string): never => {
	throw new EnvironmentPreflightError(code);
};

function expectedDatabaseIdentity(config: RuntimeConfig) {
	if (config.environment === "staging")
		return { name: "agendia_stg", loginPrefix: "agendia_stg_" } as const;
	if (config.environment === "production")
		return { name: "agendia_prod", loginPrefix: "agendia_prod_" } as const;
	return undefined;
}

function validateDatabaseIdentity(config: RuntimeConfig): void {
	const expected = expectedDatabaseIdentity(config);
	if (!expected) return;
	try {
		const url = new URL(config.databaseUrl);
		if (
			url.hostname !== "postgres" ||
			url.pathname !== `/${expected.name}` ||
			!url.username.startsWith(expected.loginPrefix)
		)
			preflightFail("environment.database_identity_invalid");
	} catch (error) {
		if (error instanceof EnvironmentPreflightError) throw error;
		preflightFail("environment.database_identity_invalid");
	}
}

function validateManifest(
	manifest: IsolationManifest,
	config: RuntimeConfig,
): void {
	const parsed = isolationManifestSchema.safeParse(manifest);
	if (!parsed.success)
		throw new EnvironmentPreflightError("environment.manifest_invalid");
	const environments = parsed.data.environments;
	if (
		environments.staging.environmentId ===
			environments.production.environmentId ||
		environments.staging.secretSetId === environments.production.secretSetId
	)
		preflightFail("environment.identity_reused");
	for (const key of Object.keys(
		environments.staging.criticalSecretHashes,
	) as Array<keyof typeof environments.staging.criticalSecretHashes>)
		if (
			environments.staging.criticalSecretHashes[key] ===
			environments.production.criticalSecretHashes[key]
		)
			preflightFail("environment.critical_hash_reused");
	if (
		environments.staging.database.name !== "agendia_stg" ||
		environments.staging.database.loginPrefix !== "agendia_stg_" ||
		environments.production.database.name !== "agendia_prod" ||
		environments.production.database.loginPrefix !== "agendia_prod_"
	)
		preflightFail("environment.manifest_invalid");
	const e164 = /^\+[1-9]\d{7,14}$/;
	if (
		!e164.test(environments.staging.whatsapp.identity) ||
		environments.staging.whatsapp.allowlist.some(
			(identity) => !e164.test(identity),
		)
	)
		preflightFail("environment.staging_whatsapp_invalid");
	if (
		environments.staging.whatsapp.identity ===
			environments.production.whatsapp.identity ||
		environments.staging.whatsapp.allowlist.includes(
			environments.production.whatsapp.identity,
		)
	)
		preflightFail("environment.staging_whatsapp_production_identity");
	const manifestEnvironment =
		environments[config.environment as "staging" | "production"];
	if (
		!manifestEnvironment ||
		manifestEnvironment.environmentId !== config.environmentId ||
		manifestEnvironment.secretSetId !== config.secretSetId
	)
		preflightFail("environment.runtime_identity_mismatch");
}

export async function preflightEnvironment(options: {
	config: RuntimeConfig;
	manifest: IsolationManifest;
	queryMarker: () => Promise<EnvironmentMarker | EnvironmentMarker[]>;
	afterPreflight?: () => void | Promise<void>;
}): Promise<void> {
	if (
		options.config.environment !== "staging" &&
		options.config.environment !== "production"
	) {
		await options.afterPreflight?.();
		return;
	}
	validateDatabaseIdentity(options.config);
	validateManifest(options.manifest, options.config);
	const result = await options.queryMarker();
	const markers = Array.isArray(result) ? result : [result];
	if (markers.length === 0) preflightFail("environment.marker_missing");
	if (markers.length !== 1) preflightFail("environment.marker_duplicate");
	const marker = markers[0]!;
	if (
		marker.environment !== options.config.environment ||
		marker.environmentId !== options.config.environmentId ||
		marker.secretSetId !== options.config.secretSetId
	)
		preflightFail("environment.marker_mismatch");
	await options.afterPreflight?.();
}

export async function runPreflightBeforeActivity<T>(
	preflight: () => Promise<void>,
	activity: () => T | Promise<T>,
): Promise<T> {
	await preflight();
	return activity();
}

export async function preflightReleaseEnvironment(
	config: RuntimeConfig,
	env: RuntimeEnvironment = process.env,
): Promise<void> {
	if (config.environment !== "staging" && config.environment !== "production")
		return;
	const manifestFile = env.AGENDIA_ISOLATION_MANIFEST_FILE;
	if (!manifestFile)
		throw new EnvironmentPreflightError("environment.manifest_unavailable");
	let manifest!: IsolationManifest;
	try {
		manifest = JSON.parse(
			readFileSync(manifestFile, "utf8"),
		) as IsolationManifest;
	} catch {
		preflightFail("environment.manifest_unavailable");
	}
	const sql = postgres(config.databaseUrl, { max: 1 });
	try {
		await preflightEnvironment({
			config,
			manifest,
			queryMarker: async () =>
				(await sql<
					EnvironmentMarker[]
				>`select environment, environment_id as "environmentId", secret_set_id as "secretSetId" from agendia_environment`) as EnvironmentMarker[],
		});
	} catch (error) {
		if (error instanceof EnvironmentPreflightError) throw error;
		preflightFail("environment.marker_unavailable");
	} finally {
		await sql.end({ timeout: 1 });
	}
}

export interface RuntimeConfig {
	process: RuntimeProcess;
	environment: "development" | "test" | "staging" | "production";
	environmentId: string;
	secretSetId: string;
	releaseDigest: string;
	databaseUrl: string;
	appOrigin?: string;
}

export function loadRuntimeConfig(
	runtimeProcess: RuntimeProcess,
	env: RuntimeEnvironment = process.env,
): RuntimeConfig {
	if (Object.hasOwn(env, "DATABASE_URL"))
		throw new Error("DATABASE_URL is forbidden");
	if (env.AGENDIA_PROCESS !== runtimeProcess)
		fail("AGENDIA_PROCESS", "is invalid");
	const parsed = identity.safeParse(env);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const name = String(issue?.path[0] ?? "runtime configuration");
		return fail(name, env[name] ? "is invalid" : "is required");
	}
	const values = parsed.data;
	const databaseUrl = validateDatabaseUrl(
		readSecretFile(env, databaseVariable(runtimeProcess)),
		databaseVariable(runtimeProcess),
	);
	const appOrigin = validateOrigin(env.APP_ORIGIN, values.AGENDIA_ENVIRONMENT);
	return {
		process: runtimeProcess,
		environment: values.AGENDIA_ENVIRONMENT,
		environmentId: values.AGENDIA_ENVIRONMENT_ID,
		secretSetId: values.AGENDIA_SECRET_SET_ID,
		releaseDigest: values.AGENDIA_RELEASE_DIGEST,
		databaseUrl,
		...(appOrigin ? { appOrigin } : {}),
	};
}

/** The release dispatcher calls this for every long-running and one-shot command. */
export function validateReleaseCommand(
	runtimeProcess: RuntimeProcess,
	env: RuntimeEnvironment = process.env,
): RuntimeConfig {
	return loadRuntimeConfig(runtimeProcess, env);
}

export * from "./operations.ts";

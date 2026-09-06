import { readFileSync } from "node:fs";
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

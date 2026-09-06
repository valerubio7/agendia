import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadRuntimeConfig,
	validateReleaseCommand,
} from "../../packages/runtime-config/src/index.ts";

const digest = `sha256:${"a".repeat(64)}`;
const environmentId = "11111111-1111-4111-8111-111111111111";
const secretSetId = "22222222-2222-4222-8222-222222222222";

function validEnvironment(directory: string, process: string) {
	const database = join(directory, `${process}-database-url`);
	writeFileSync(
		database,
		`postgres://agendia_stg_${process}:safe@postgres/agendia_stg`,
	);
	return {
		AGENDIA_PROCESS: process,
		AGENDIA_ENVIRONMENT: "staging",
		AGENDIA_ENVIRONMENT_ID: environmentId,
		AGENDIA_SECRET_SET_ID: secretSetId,
		AGENDIA_RELEASE_DIGEST: digest,
		APP_ORIGIN: "https://staging.example",
		[`${process.toUpperCase().replaceAll("-", "_")}_DATABASE_URL_FILE`]:
			database,
	};
}

describe("runtime configuration", () => {
	test("rejects generic database URLs, inline secrets, absent files, malformed identity, and secret-bearing errors", () => {
		const directory = mkdtempSync(join(tmpdir(), "agendia-runtime-config-"));
		try {
			const env = validEnvironment(directory, "api");
			expect(() =>
				loadRuntimeConfig("api", { ...env, DATABASE_URL: "postgres://leak" }),
			).toThrow("DATABASE_URL is forbidden");
			expect(() =>
				loadRuntimeConfig("api", {
					...env,
					API_DATABASE_URL: "postgres://leak",
				}),
			).toThrow("API_DATABASE_URL_FILE is required");
			expect(() =>
				loadRuntimeConfig("api", {
					...env,
					API_DATABASE_URL_FILE: join(directory, "missing"),
				}),
			).toThrow("API_DATABASE_URL_FILE is unavailable");
			expect(() =>
				loadRuntimeConfig("api", {
					...env,
					AGENDIA_RELEASE_DIGEST: "tag:latest",
				}),
			).toThrow("AGENDIA_RELEASE_DIGEST is invalid");
			try {
				loadRuntimeConfig("api", {
					...env,
					API_DATABASE_URL_FILE: join(directory, "missing"),
				});
			} catch (error) {
				expect(String(error)).not.toContain("postgres://");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("validates every supported release command through the centralized loader", () => {
		const directory = mkdtempSync(join(tmpdir(), "agendia-runtime-config-"));
		try {
			for (const process of [
				"api",
				"whatsapp-manager",
				"message-worker",
				"web",
				"migrate",
				"queue-init",
				"bootstrap-admin",
				"verify-config",
			] as const)
				expect(validateReleaseCommand(process, validEnvironment(directory, process)).process).toBe(process);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("loads file-backed configuration for API, manager, worker, web, and one-shot variants", () => {
		const directory = mkdtempSync(join(tmpdir(), "agendia-runtime-config-"));
		try {
			for (const process of [
				"api",
				"whatsapp-manager",
				"message-worker",
				"web",
				"migrate",
				"queue-init",
			] as const) {
				const config = loadRuntimeConfig(
					process,
					validEnvironment(directory, process),
				);
				expect(config.process).toBe(process);
				expect(config.databaseUrl).not.toContain("undefined");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("requires a canonical HTTPS origin for staging and redacts invalid file values", () => {
		const directory = mkdtempSync(join(tmpdir(), "agendia-runtime-config-"));
		try {
			const env = validEnvironment(directory, "web");
			const { APP_ORIGIN: _origin, ...withoutOrigin } = env;
			expect(() => loadRuntimeConfig("web", withoutOrigin)).toThrow(
				"APP_ORIGIN is required",
			);
			expect(() =>
				loadRuntimeConfig("web", { ...env, APP_ORIGIN: "https://app.example/" }),
			).toThrow("APP_ORIGIN is invalid");
			const secret = "must-not-appear";
			writeFileSync(env.WEB_DATABASE_URL_FILE!, `not-a-url:${secret}`);
			try {
				loadRuntimeConfig("web", env);
			} catch (error) {
				expect(String(error)).toContain("WEB_DATABASE_URL_FILE is invalid");
				expect(String(error)).not.toContain(secret);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects malformed PostgreSQL URLs and accepts only host and database-bearing PostgreSQL URLs", () => {
		const directory = mkdtempSync(join(tmpdir(), "agendia-runtime-config-"));
		try {
			const env = validEnvironment(directory, "api");
			for (const value of [
				"postgres:///agendia_stg",
				"postgres://agendia_stg_api:safe@/agendia_stg",
			]) {
				writeFileSync(env.API_DATABASE_URL_FILE!, value);
				expect(() => loadRuntimeConfig("api", env)).toThrow(
					"API_DATABASE_URL_FILE is invalid",
				);
			}
			writeFileSync(
				env.API_DATABASE_URL_FILE!,
				"postgresql://agendia_stg_api:safe@postgres/agendia_stg",
			);
			expect(loadRuntimeConfig("api", env).databaseUrl).toBe(
				"postgresql://agendia_stg_api:safe@postgres/agendia_stg",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("limits development origins to local HTTP and rejects defined empty database variables", () => {
		const directory = mkdtempSync(join(tmpdir(), "agendia-runtime-config-"));
		try {
			const env = {
				...validEnvironment(directory, "api"),
				AGENDIA_ENVIRONMENT: "development",
				APP_ORIGIN: "http://localhost:3000",
			};
			expect(loadRuntimeConfig("api", env).appOrigin).toBe("http://localhost:3000");
			for (const origin of ["ftp://localhost:3000", "http://example.test"]) {
				expect(() => loadRuntimeConfig("api", { ...env, APP_ORIGIN: origin })).toThrow(
					"APP_ORIGIN is invalid",
				);
			}
			expect(() => loadRuntimeConfig("api", { ...env, DATABASE_URL: "" })).toThrow(
				"DATABASE_URL is forbidden",
			);
			expect(() =>
				loadRuntimeConfig("api", { ...env, API_DATABASE_URL: "" }),
			).toThrow("API_DATABASE_URL_FILE is required");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("ships a release example with non-usable placeholders and no inline database URL", () => {
		const example = readFileSync("deploy/config/release.example.env", "utf8");
		expect(example).not.toContain("DATABASE_URL=");
		for (const line of example.split("\n")) {
			if (!line || line.startsWith("#")) continue;
			const [, value] = line.split("=", 2);
			expect(value).toMatch(/^(?:__[A-Z0-9_]+__|\/run\/secrets\/[\w-]+\.invalid)$/);
		}
	});
});

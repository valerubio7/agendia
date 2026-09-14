import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import * as runtimeConfig from "@agendia/runtime-config";
import type { IsolationManifest, RuntimeConfig } from "@agendia/runtime-config";
import { renderCompose } from "../../scripts/render-compose.ts";
import { runOrderedDeployment } from "../../scripts/host-deployment-runtime.ts";
import { validateGenesisInput } from "../../scripts/support/postgres-migrations.ts";
import { postgresImage } from "../../scripts/support/locked-images.ts";

const { preflightStaticEnvironment } = runtimeConfig as typeof runtimeConfig & {
	preflightStaticEnvironment(options: {
		config: RuntimeConfig;
		manifest: IsolationManifest;
	}): void;
};

const digest = `sha256:${"a".repeat(64)}`;
const ids = {
	staging: "11111111-1111-4111-8111-111111111111",
	production: "22222222-2222-4222-8222-222222222222",
	stagingSecrets: "33333333-3333-4333-8333-333333333333",
	productionSecrets: "44444444-4444-4444-8444-444444444444",
};
const manifest: IsolationManifest = {
	schemaVersion: 1,
	environments: {
		staging: {
			environmentId: ids.staging,
			secretSetId: ids.stagingSecrets,
			database: {
				host: "postgres",
				name: "agendia_stg",
				loginPrefix: "agendia_stg_",
			},
			criticalSecretHashes: {
				databasePassword: "a".repeat(64),
				providerKey: "b".repeat(64),
				tunnelCredential: "c".repeat(64),
				baileysKek: "d".repeat(64),
				linkOrQrKey: "e".repeat(64),
			},
			whatsapp: { identity: "+15550000001", allowlist: ["+15550000002"] },
		},
		production: {
			environmentId: ids.production,
			secretSetId: ids.productionSecrets,
			database: {
				host: "postgres",
				name: "agendia_prod",
				loginPrefix: "agendia_prod_",
			},
			criticalSecretHashes: {
				databasePassword: "f".repeat(64),
				providerKey: "0".repeat(64),
				tunnelCredential: "1".repeat(64),
				baileysKek: "2".repeat(64),
				linkOrQrKey: "3".repeat(64),
			},
			whatsapp: { identity: "+15550000003", allowlist: ["+15550000004"] },
		},
	},
};
const config: RuntimeConfig = {
	process: "migrate",
	environment: "staging",
	environmentId: ids.staging,
	secretSetId: ids.stagingSecrets,
	releaseDigest: digest,
	databaseUrl: "postgresql://agendia_stg_migrator:secret@postgres/agendia_stg",
};
const images = {
	app: `ghcr.io/valerubio7/agendia@${digest}`,
	postgres: postgresImage,
	cloudflared: `cloudflare/cloudflared@${digest}`,
};
type OneShot = "provision-roles" | "migrate" | "queue-init";

describe("Slice 4 host configuration and governed genesis", () => {
	test("RED: renders required raw per-process configuration and individual secret mounts without normal DATABASE_URL", () => {
		const rendered = renderCompose({
			environment: "staging",
			images,
			capacity: { clearance: true, windowApproved: true },
		});
		for (const service of [
			"api",
			"web",
			"whatsapp-manager",
			"message-worker",
			"provision-roles",
			"migrate",
			"queue-init",
			"cloudflared",
		]) {
			expect(rendered).toContain(
				`env_file:\n      - path: "/etc/agendia/staging/config/${service}.env"\n        required: true\n        format: raw`,
			);
			expect(rendered).toContain(`AGENDIA_PROCESS: "${service}"`);
		}
		expect(rendered).toContain(`AGENDIA_ENVIRONMENT: "staging"`);
		expect(rendered).toContain(`AGENDIA_RELEASE_DIGEST: "${digest}"`);
		expect(rendered).toContain("/run/secrets/api-database-url:ro");
		for (const required of [
			'AGENDIA_RELEASE_MANIFEST_FILE: "/run/agendia/config/release-manifest.json"',
			'AGENDIA_MIGRATION_EVIDENCE_FILE: "/run/agendia/config/migration-evidence.json"',
			"/run/agendia/config/release-manifest.json:ro",
			"/run/agendia/config/migration-evidence.json:ro",
		])
			expect(rendered).toContain(required);
		expect(rendered).not.toContain("/run/secrets:/run/secrets:ro");
		expect(rendered).not.toMatch(/^\s+DATABASE_URL:/m);
	});

	test("RED: rejects crossed static identity before PostgreSQL or marker activity without exposing a database URL", () => {
		expect(() =>
			preflightStaticEnvironment({ config, manifest }),
		).not.toThrow();
		try {
			preflightStaticEnvironment({
				config: { ...config, environmentId: ids.production },
				manifest,
			});
		} catch (error) {
			expect(String(error)).toBe(
				"EnvironmentPreflightError: environment.runtime_identity_mismatch",
			);
		}
		expect(() =>
			validateGenesisInput({
				environment: "staging",
				environmentId: ids.staging,
				secretSetId: ids.stagingSecrets,
				releaseDigest: digest,
				expected: config,
			}),
		).not.toThrow();
		expect(() =>
			validateGenesisInput({
				environment: "staging",
				environmentId: ids.production,
				secretSetId: ids.stagingSecrets,
				releaseDigest: digest,
				expected: config,
			}),
		).toThrow("migration.genesis_identity_invalid");
	});

	test("RED: runs only the non-bootstrap predecessor order and stops before apps for required bootstrap or a failed predecessor", async () => {
		const events: string[] = [];
		const runtime = {
			startPostgres: async () => {
				events.push("postgres");
			},
			runOneShot: async (service: OneShot) => {
				events.push(service);
			},
			converge: async () => {
				events.push("apps");
			},
			checks: async () => {
				events.push("checks");
			},
		};
		await runOrderedDeployment({ runtime, bootstrapRequired: false });
		expect(events).toEqual([
			"postgres",
			"provision-roles",
			"migrate",
			"queue-init",
			"apps",
			"checks",
		]);
		events.length = 0;
		await expect(
			runOrderedDeployment({ runtime, bootstrapRequired: true }),
		).rejects.toThrow("host.bootstrap_required");
		expect(events).toEqual([
			"postgres",
			"provision-roles",
			"migrate",
			"queue-init",
		]);
		await expect(
			runOrderedDeployment({
				runtime: {
					...runtime,
					runOneShot: async (service: OneShot) => {
						events.push(service);
						if (service === "migrate") throw new Error("failed");
					},
				},
				bootstrapRequired: false,
			}),
		).rejects.toThrow("failed");
		expect(events).not.toContain("apps");
	});

	test("RED: retains historical migrations and makes pgboss before its ownership handoff", () => {
		const roles = readFileSync(
			"scripts/support/database-role-provisioning.ts",
			"utf8",
		);
		expect(roles.indexOf("create schema if not exists pgboss")).toBeGreaterThan(
			-1,
		);
		expect(roles.indexOf("create schema if not exists pgboss")).toBeLessThan(
			roles.indexOf("alter schema pgboss owner"),
		);
	});
});

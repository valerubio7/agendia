import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	preflightEnvironment,
	runPreflightBeforeActivity,
	type EnvironmentMarker,
	type IsolationManifest,
	type RuntimeConfig,
} from "@agendia/runtime-config";
import {
	applyPostgresMigrations,
	startTestPostgres,
	type TestPostgres,
} from "../support/postgres.ts";

const fingerprint = (letter: string) => letter.repeat(64);
const stagingId = randomUUID();
const productionId = randomUUID();
const stagingSecretSetId = randomUUID();
const productionSecretSetId = randomUUID();

function manifest(
	overrides: Partial<IsolationManifest> = {},
): IsolationManifest {
	return {
		schemaVersion: 1,
		environments: {
			staging: {
				environmentId: stagingId,
				secretSetId: stagingSecretSetId,
				database: {
					host: "postgres",
					name: "agendia_stg",
					loginPrefix: "agendia_stg_",
				},
				criticalSecretHashes: {
					databasePassword: fingerprint("a"),
					providerKey: fingerprint("b"),
					tunnelCredential: fingerprint("c"),
					baileysKek: fingerprint("d"),
					linkOrQrKey: fingerprint("e"),
				},
				whatsapp: { identity: "+15550000001", allowlist: ["+15550000002"] },
			},
			production: {
				environmentId: productionId,
				secretSetId: productionSecretSetId,
				database: {
					host: "postgres",
					name: "agendia_prod",
					loginPrefix: "agendia_prod_",
				},
				criticalSecretHashes: {
					databasePassword: fingerprint("f"),
					providerKey: fingerprint("0"),
					tunnelCredential: fingerprint("1"),
					baileysKek: fingerprint("2"),
					linkOrQrKey: fingerprint("3"),
				},
				whatsapp: { identity: "+15550000003", allowlist: ["+15550000004"] },
			},
		},
		...overrides,
	};
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return {
		process: "api",
		environment: "staging",
		environmentId: stagingId,
		secretSetId: stagingSecretSetId,
		releaseDigest: `sha256:${fingerprint("4")}`,
		databaseUrl: "postgresql://agendia_stg_api@postgres/agendia_stg",
		...overrides,
	};
}

async function expectCode(action: () => Promise<unknown>, code: string) {
	await expect(action()).rejects.toMatchObject({ code });
	await expect(action()).rejects.not.toThrow(
		/postgres|agendia_|\+1555|[a-f0-9]{64}/i,
	);
}

describe("cross-environment release preflight", () => {
	let database: TestPostgres;

	beforeAll(async () => {
		database = await startTestPostgres();
		await applyPostgresMigrations(
			database.sql,
			join(process.cwd(), "packages/db/migrations"),
		);
	});
	afterAll(() => database.stop());
	test("RED: fails closed for a crossed database URL before querying the marker", async () => {
		await expectCode(
			() =>
				preflightEnvironment({
					config: config({
						databaseUrl: "postgresql://agendia_prod_api@postgres/agendia_prod",
					}),
					manifest: manifest(),
					queryMarker: async () => ({
						environment: "staging",
						environmentId: stagingId,
						secretSetId: stagingSecretSetId,
					}),
				}),
			"environment.database_identity_invalid",
		);
	});

	test("RED: rejects unknown secret-bearing manifest keys without disclosing their values", async () => {
		const unknownTopLevelSecret =
			"postgresql://agendia_prod_api:top-secret@prod-db/agendia_prod";
		const unknownNestedSecret = "+15559999999";
		const unsafe = {
			...manifest(),
			productionCredential: unknownTopLevelSecret,
			environments: {
				...manifest().environments,
				staging: {
					...manifest().environments.staging,
					whatsapp: {
						...manifest().environments.staging.whatsapp,
						providerToken: unknownNestedSecret,
					},
				},
			},
		} as unknown as IsolationManifest;
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: unsafe,
					queryMarker: async () => ({
						environment: "staging",
						environmentId: stagingId,
						secretSetId: stagingSecretSetId,
					}),
				}),
			"environment.manifest_invalid",
		);
	});

	test("RED: rejects a critical fingerprint reused across environments", async () => {
		const reused = manifest();
		reused.environments.production.criticalSecretHashes.providerKey =
			reused.environments.staging.criticalSecretHashes.providerKey;
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: reused,
					queryMarker: async () => ({
						environment: "staging",
						environmentId: stagingId,
						secretSetId: stagingSecretSetId,
					}),
				}),
			"environment.critical_hash_reused",
		);
	});

	test("RED: rejects a production WhatsApp identity in the staging allowlist", async () => {
		const unsafe = manifest();
		unsafe.environments.staging.whatsapp.allowlist.push(
			unsafe.environments.production.whatsapp.identity,
		);
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: unsafe,
					queryMarker: async () => ({
						environment: "staging",
						environmentId: stagingId,
						secretSetId: stagingSecretSetId,
					}),
				}),
			"environment.staging_whatsapp_production_identity",
		);
	});

	test("RED: rejects a connected marker that does not match the runtime identity", async () => {
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: manifest(),
					queryMarker: async () => ({
						environment: "production",
						environmentId: productionId,
						secretSetId: productionSecretSetId,
					}),
				}),
			"environment.marker_mismatch",
		);
	});

	test("RED: reads exactly one connected marker and rejects a stored mismatch", async () => {
		await database.sql`
      insert into agendia_environment (environment, environment_id, secret_set_id)
      values ('production', ${productionId}, ${productionSecretSetId})
    `;
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: manifest(),
					queryMarker: () =>
						database.sql<EnvironmentMarker[]>`
              select environment, environment_id as "environmentId", secret_set_id as "secretSetId"
              from agendia_environment
            `,
				}),
			"environment.marker_mismatch",
		);
		let duplicateCode: string | undefined;
		try {
			await database.sql`
        insert into agendia_environment (environment, environment_id, secret_set_id)
        values ('staging', ${stagingId}, ${stagingSecretSetId})
      `;
		} catch (error) {
			duplicateCode = (error as { code?: string }).code;
		}
		expect(duplicateCode).toBe("23505");
		await database.sql`
      update agendia_environment
      set environment = 'staging', environment_id = ${stagingId}, secret_set_id = ${stagingSecretSetId}
    `;
	});

	test("TRIANGULATE: missing and duplicate marker results fail closed", async () => {
		const valid = {
			environment: "staging",
			environmentId: stagingId,
			secretSetId: stagingSecretSetId,
		};
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: manifest(),
					queryMarker: async () => [],
				}),
			"environment.marker_missing",
		);
		await expectCode(
			() =>
				preflightEnvironment({
					config: config(),
					manifest: manifest(),
					queryMarker: async () => [valid, valid],
				}),
			"environment.marker_duplicate",
		);
	});

	test("TRIANGULATE: starts API, manager, and worker activity only after preflight", async () => {
		const activity: string[] = [];
		for (const process of [
			"api",
			"whatsapp-manager",
			"message-worker",
		] as const) {
			await runPreflightBeforeActivity(
				async () => {
					await preflightEnvironment({
						config: config({ process }),
						manifest: manifest(),
						queryMarker: async () => ({
							environment: "staging",
							environmentId: stagingId,
							secretSetId: stagingSecretSetId,
						}),
					});
					activity.push(`preflight:${process}`);
				},
				() => {
					activity.push(`activity:${process}`);
				},
			);
		}
		expect(activity).toEqual([
			"preflight:api",
			"activity:api",
			"preflight:whatsapp-manager",
			"activity:whatsapp-manager",
			"preflight:message-worker",
			"activity:message-worker",
		]);
	});
});

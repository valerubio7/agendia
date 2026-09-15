import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyDeployment,
	planDeployment,
	rollbackDeployment,
	type DeploymentAdapter,
} from "../../../scripts/deployctl.ts";
import {
	canonicalize,
	finalizePromotionAuthorization,
	preparePromotionAuthorization,
} from "../../../scripts/promotion-authorization.ts";
import {
	provisionRoles,
	roleNamesForEnvironment,
} from "../../../scripts/support/database-role-provisioning.ts";
import { initializeQueues } from "../../../scripts/support/queue-initialization.ts";
import postgres from "postgres";
import { postgresImage } from "../../../scripts/support/locked-images.ts";
import {
	applyPostgresMigrations,
	startTestPostgres,
} from "../../support/postgres.ts";

const processes = ["web", "api", "whatsapp-manager", "message-worker"] as const;
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const hash = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const repository = "agendia/agendia";
const imageRepository = `ghcr.io/${repository}`;
const commit = "a".repeat(40);
const checks = [
	"quality",
	"unit",
	"postgres",
	"browser",
	"aggregate-contract",
	"source-build",
].map((name) => ({
	name,
	status: "completed" as const,
	conclusion: "success" as const,
}));
const matrix = {
	schemaVersion: 1,
	mode: "SOLO_PILOT",
	controls: [
		["pr-entry", "required", "available", "policy-and-release-verifier"],
		[
			"squash-integration",
			"required",
			"unconfirmed",
			"policy-and-release-verifier",
		],
		["main-integrity", "desired", "unconfirmed", "policy-and-release-verifier"],
		["ci", "required", "available", "required-checks"],
		["codeowners", "advisory", "available", "advisory"],
		[
			"github-environments",
			"desired",
			"unconfirmed",
			"workflow-dispatch-fallback",
		],
		["promotion", "required", "available", "two-manual-workflow-dispatches"],
		["independent-reviewer", "desired", "unavailable", "inactive"],
		["self-review-prevention", "desired", "unavailable", "inactive"],
	].map(([control, desired, availability, effective]) => ({
		control,
		desired,
		availability,
		effective,
		evidence: "ephemeral-fixture",
	})),
};

type ArtifactKind = "universal-image" | "release-set";
type Environment = "staging" | "production";
type PromotionInput = {
	artifactKind?: ArtifactKind;
	productionDigest?: string;
	productionResources?: Partial<EnvironmentResources>;
};
type EnvironmentResources = {
	environment: Environment;
	id: string;
	config: string;
	secretSetHash: string;
	roles: string;
	volume: string;
};
type Runtime = DeploymentAdapter & { events: string[] };

function environmentResources(environment: Environment): EnvironmentResources {
	return environment === "staging"
		? {
				environment,
				id: "11111111-1111-4111-8111-111111111111",
				config: "stg-config",
				secretSetHash: hash("stg-secret-set"),
				roles: "agendia_stg_",
				volume: "agendia-stg-postgres",
			}
		: {
				environment,
				id: "22222222-2222-4222-8222-222222222222",
				config: "prod-config",
				secretSetHash: hash("prod-secret-set"),
				roles: "agendia_prod_",
				volume: "agendia-prod-postgres",
			};
}
function assertIsolated(
	staging: EnvironmentResources,
	production: EnvironmentResources,
) {
	for (const key of [
		"id",
		"config",
		"secretSetHash",
		"roles",
		"volume",
	] as const)
		if (staging[key] === production[key])
			throw new Error("promotion.cross_environment_resource");
}
function runtime(): Runtime {
	let state: ReturnType<DeploymentAdapter["readState"]>;
	let compose: string | undefined;
	const events: string[] = [];
	const converge = async (rendered: string) => {
		if (!rendered.includes("ports:")) events.push("converge:private");
		else throw new Error("promotion.public_port");
	};
	return {
		events,
		readState: () => state,
		readCompose: () => compose,
		writeStateAtomic: (next) => {
			state = next;
			events.push("state");
		},
		stageComposeAtomic: (next) => {
			compose = next;
			events.push("compose");
		},
		pull: async (reference) => {
			events.push(`pull:${reference}`);
		},
		inspect: async (reference) => ({ reference, platform: "linux/amd64" }),
		converge,
		runOrdered: async () => converge(compose!),
	};
}
function gates(currentReleaseDigest = digest("0")) {
	return {
		capacity: { clearance: true, activeConflicts: [] },
		migration: {
			lockAvailable: true,
			backupVerified: true,
			minimumLedgerPresent: true,
			currentReleaseDigest,
		},
		restore: { active: false, verified: true },
		backlog: { oldestSeconds: 0 },
	};
}
function deploymentFixture(
	kind: ArtifactKind,
	target: Environment,
	letter = "a",
	previousReleaseDigest = digest("0"),
) {
	const releaseDigest = digest(letter);
	const images = Object.fromEntries(
		processes.map((process, index) => [
			process,
			`${imageRepository}@${digest(kind === "universal-image" ? letter : String.fromCharCode(letter.charCodeAt(0) + index))}`,
		]),
	);
	const manifest = {
		schemaVersion: 1,
		artifactKind: kind,
		commit,
		releaseDigest,
		platform: "linux/amd64" as const,
		images,
		database: {
			compatibility: "expand-compatible" as const,
			previousReleaseDigest,
			minimumLedger: "0022_service_heartbeats.sql",
		},
	};
	const evidence = {
		schemaVersion: 1,
		sourceRepository: repository,
		imageRepository,
		workflowRunId: 19,
		mergedPullRequest: 12,
		actor: "simulation",
		timestamp: "2026-04-01T00:00:00Z",
		commit,
		checks,
		artifactKind: kind,
		platform: "linux/amd64" as const,
		releaseDigest,
		images,
		database: {
			schemaVersion: 1,
			...manifest.database,
			previousReleaseDigestMeaning:
				previousReleaseDigest === digest("0")
					? "The zero digest is a genesis sentinel for the first release and is not observed deployment history."
					: "",
		},
		generatedCommands: {
			web: ["bun", "/opt/agendia/web/server.js"],
			api: ["bun", "/opt/agendia/api/index.js"],
			"whatsapp-manager": ["bun", "/opt/agendia/whatsapp-manager/index.js"],
			"message-worker": ["bun", "/opt/agendia/message-worker/index.js"],
		},
		sbom: {
			path: "sbom.spdx.json",
			format: "spdx-json" as const,
			digest: digest("d"),
		},
		sbomAttestation: { id: "sbom", url: "https://example.test/sbom" },
		provenanceAttestation: {
			id: "provenance",
			url: "https://example.test/provenance",
		},
		manifest,
	};
	const context = {
		sourceRepository: repository,
		imageRepository,
		actor: evidence.actor,
		commit,
		mergedPullRequest: 12,
		checks,
		workflowRunId: 19,
	};
	const releaseRun = {
		workflowRunId: 41,
		name: "Release evidence" as const,
		event: "workflow_run" as const,
		headSha: commit,
		artifactName: `release-evidence-${commit}`,
		sourceRepository: repository,
		conclusion: "success" as const,
	};
	const stagingDraft = preparePromotionAuthorization({
		target: "staging",
		releaseDigest,
		releaseEvidence: evidence,
		releaseManifest: manifest,
		releaseContext: context,
		sbomDigest: evidence.sbom.digest,
		matrix,
		releaseRun,
	});
	const stagingAuthorization = finalizePromotionAuthorization({
		draft: stagingDraft,
		actor: "simulation",
		authorizedAt: "2026-04-01T01:00:00Z",
		authorizationWorkflowRunId: 51,
		sourceCommit: "c".repeat(40),
	});
	const draft = preparePromotionAuthorization({
		target,
		releaseDigest,
		releaseEvidence: evidence,
		releaseManifest: manifest,
		releaseContext: context,
		sbomDigest: evidence.sbom.digest,
		matrix,
		releaseRun,
		...(target === "production"
			? {
					stagingAuthorization,
					stagingRun: {
						workflowRunId: 51,
						name: "Authorize promotion" as const,
						event: "workflow_dispatch" as const,
						artifactName: "promotion-authorization-51",
						sourceRepository: repository,
						conclusion: "success" as const,
					},
				}
			: {}),
	});
	const authorization = finalizePromotionAuthorization({
		draft,
		actor: "simulation",
		authorizedAt: "2026-04-01T02:00:00Z",
		authorizationWorkflowRunId: target === "production" ? 52 : 51,
		sourceCommit: "c".repeat(40),
	});
	const authorizationBytes = canonicalize(authorization);
	return {
		authorization,
		authorizationProof: {
			verified: true,
			workflowName: "Authorize promotion",
			workflowEvent: "workflow_dispatch",
			conclusion: "success",
			workflowRunId: authorization.authorizationWorkflowRunId,
			sourceRepository: repository,
			headCommit: authorization.authorizationSourceCommit,
			target,
			artifactName: `promotion-authorization-${authorization.authorizationWorkflowRunId}`,
			authorizationId: authorization.authorizationId,
			artifactSha256: hash(authorizationBytes),
			authorizationBytes,
		},
		manifest,
		evidence,
		sbom: { verified: true, digest: evidence.sbom.digest, format: "spdx-json" },
		provenance: {
			verified: true,
			subjectDigest: releaseDigest,
			repository,
			commit,
			attestationId: "provenance",
		},
		environment: target,
		composeImages: {
			postgres: postgresImage,
			cloudflared: `cloudflare/cloudflared@${digest("e")}`,
		},
		gates: gates(previousReleaseDigest),
	};
}

export async function runReleasePromotionSimulation(
	input: PromotionInput = {},
) {
	const kind = input.artifactKind ?? "universal-image";
	const stagingResources = environmentResources("staging");
	const productionResources = {
		...environmentResources("production"),
		...input.productionResources,
		environment: "production" as const,
	};
	assertIsolated(stagingResources, productionResources);
	const initialProduction = deploymentFixture(kind, "production", "c");
	const initialStaging = deploymentFixture(kind, "staging", "c");
	const stagingInput = deploymentFixture(
		kind,
		"staging",
		"a",
		initialStaging.manifest.releaseDigest,
	);
	const productionInput = deploymentFixture(
		kind,
		"production",
		"a",
		initialProduction.manifest.releaseDigest,
	);
	if (
		input.productionDigest &&
		input.productionDigest !== stagingInput.manifest.releaseDigest
	)
		throw new Error("promotion.digest_mismatch");
	if (
		productionInput.manifest.releaseDigest !==
		stagingInput.manifest.releaseDigest
	)
		throw new Error("promotion.digest_mismatch");
	const root = await mkdtemp(join(tmpdir(), "agendia-promotion-"));
	const log = console.log;
	console.log = (...values) => {
		if (
			values.length === 1 &&
			typeof values[0] === "object" &&
			values[0] !== null &&
			(values[0] as { code?: unknown; severity?: unknown }).code === "42P06" &&
			(values[0] as { severity?: unknown }).severity === "NOTICE"
		)
			return;
		log(...values);
	};
	let database: Awaited<ReturnType<typeof startTestPostgres>> | undefined;
	try {
		database = await startTestPostgres();
		const events: string[] = [];
		const staging = runtime(),
			production = runtime();
		await applyDeployment(planDeployment(initialProduction), production);
		await applyDeployment(planDeployment(initialStaging), staging);
		await applyDeployment(planDeployment(stagingInput), staging);
		events.push(...staging.events, "migrate");
		await applyPostgresMigrations(
			database.sql,
			join(process.cwd(), "packages/db/migrations"),
		);
		const roles = roleNamesForEnvironment("staging");
		const credentials = Object.fromEntries(
			Object.values(roles).map((name, index) => [
				name,
				`simulation-password-${index}`,
			]),
		);
		await database.sql`insert into agendia_environment(environment,environment_id,secret_set_id) values ('staging',${stagingResources.id},'33333333-3333-4333-8333-333333333333')`;
		await provisionRoles(database.sql, {
			environment: "staging",
			databaseName: "postgres",
			credentials,
			manageDatabaseOwnership: false,
		});
		events.push("queue-init");
		const queueUrl = new URL(database.container.getConnectionUri());
		queueUrl.username = roles.queueOwner;
		queueUrl.password = credentials[roles.queueOwner]!;
		const queueOwner = postgres(queueUrl.toString(), { max: 1 });
		try {
			await initializeQueues({
				sql: queueOwner,
				connectionString: queueUrl.toString(),
			});
		} finally {
			await queueOwner.end();
		}
		await database.sql`insert into agendia_service_heartbeats(service,instance_id,release_digest,state,started_at,last_seen_at) values ('whatsapp-manager','stg-manager',${stagingInput.manifest.releaseDigest},'ready',now(),now()),('message-worker','stg-worker',${stagingInput.manifest.releaseDigest},'ready',now(),now())`;
		const marker = await database.sql<
			{ ready: boolean }[]
		>`select exists(select 1 from agendia_environment) ready`;
		const heartbeats = await database.sql<
			{ service: string; ready: boolean }[]
		>`select service,state='ready' ready from agendia_service_heartbeats order by service`;
		const readiness = {
			web: staging.events.includes("converge:private"),
			api: marker[0]?.ready === true,
			manager: heartbeats.some(
				(row) => row.service === "whatsapp-manager" && row.ready,
			),
			worker: heartbeats.some(
				(row) => row.service === "message-worker" && row.ready,
			),
		};
		if (Object.values(readiness).some((ready) => !ready))
			throw new Error("promotion.readiness_failed");
		const smoke = await database.sql<
			{ initialized: boolean }[]
		>`select exists(select 1 from pgboss.version) initialized`;
		if (!smoke[0]?.initialized)
			throw new Error("promotion.private_smoke_failed");
		await applyDeployment(planDeployment(productionInput), production);
		const productionBefore = {
			id: productionResources.volume,
			checksum: hash(productionResources.volume),
		};
		const evidence = {
			schemaVersion: 1,
			operation: "release-promotion",
			artifactKind: kind,
			releaseDigest: stagingInput.manifest.releaseDigest,
			readiness,
			privateSmoke: true,
			order: events.filter(
				(event) => event === "migrate" || event === "queue-init",
			),
			stagingResources,
			productionResources,
		};
		await rollbackDeployment(planDeployment(productionInput), production).catch(
			(error: unknown) => {
				throw error;
			},
		);
		const productionAfter = {
			id: productionResources.volume,
			checksum: hash(productionResources.volume),
		};
		if (canonicalize(productionBefore) !== canonicalize(productionAfter))
			throw new Error("promotion.production_identity_changed");
		return {
			evidence,
			stagingEvents: staging.events,
			productionEvents: production.events,
			productionBefore,
			productionAfter,
		};
	} finally {
		console.log = log;
		const databaseToStop = database;
		const stop = databaseToStop
			? Promise.resolve().then(() => databaseToStop.stop())
			: Promise.resolve();
		await Promise.all([stop, rm(root, { recursive: true, force: true })]);
	}
}

if (import.meta.main) {
	const mode = Bun.argv[2] ?? "success";
	try {
		const result = await runReleasePromotionSimulation(
			mode === "changed-digest"
				? { productionDigest: digest("b") }
				: mode === "cross-resource"
					? { productionResources: { volume: "agendia-stg-postgres" } }
					: mode === "release-set"
						? { artifactKind: "release-set" }
						: {},
		);
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	applyDeployment,
	createFilesystemDeploymentAdapter,
	planDeployment,
	rollbackDeployment,
	type DeploymentAdapter,
} from "../../scripts/deployctl.ts";
import {
	canonicalize,
	finalizePromotionAuthorization,
	preparePromotionAuthorization,
} from "../../scripts/promotion-authorization.ts";
import { postgresImage } from "../../scripts/support/locked-images.ts";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const hash = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const commit = "b".repeat(40);
const repository = "valerubio7/agendia";
const imageRepository = `ghcr.io/${repository}`;
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
		evidence: "fixture",
	})),
};

function fixture(
	kind: "universal-image" | "release-set" = "universal-image",
	target: "staging" | "production" = "staging",
	letter = "a",
	previousReleaseDigest = digest("0"),
	compatibility:
		| "expand-compatible"
		| "contract-maintenance" = "expand-compatible",
) {
	const releaseDigest = digest(kind === "universal-image" ? letter : "f");
	const images = Object.fromEntries(
		["web", "api", "whatsapp-manager", "message-worker"].map(
			(process, index) => [
				process,
				`${imageRepository}@${digest(kind === "universal-image" ? letter : String.fromCharCode(letter.charCodeAt(0) + index))}`,
			],
		),
	);
	const manifest = {
		schemaVersion: 1,
		artifactKind: kind,
		commit,
		releaseDigest,
		platform: "linux/amd64",
		images,
		database: {
			compatibility,
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
		actor: "operator",
		timestamp: "2026-04-01T00:00:00Z",
		commit,
		checks,
		artifactKind: kind,
		platform: "linux/amd64",
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
		sbom: { path: "sbom.spdx.json", format: "spdx-json", digest: digest("d") },
		sbomAttestation: { id: "sbom-1", url: "https://example.test/sbom" },
		provenanceAttestation: {
			id: "provenance-1",
			url: "https://example.test/provenance",
		},
		manifest,
	};
	const releaseContext = {
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
		name: "Release evidence",
		event: "workflow_run",
		headSha: commit,
		artifactName: `release-evidence-${commit}`,
		sourceRepository: repository,
		conclusion: "success",
	};
	const draft = preparePromotionAuthorization({
		target,
		releaseDigest,
		releaseEvidence: evidence,
		releaseManifest: manifest,
		releaseContext,
		sbomDigest: evidence.sbom.digest,
		matrix,
		releaseRun,
		...(target === "production"
			? (() => {
					const stagingDraft = preparePromotionAuthorization({
						target: "staging",
						releaseDigest,
						releaseEvidence: evidence,
						releaseManifest: manifest,
						releaseContext,
						sbomDigest: evidence.sbom.digest,
						matrix,
						releaseRun,
					});
					const stagingAuthorization = finalizePromotionAuthorization({
						draft: stagingDraft,
						actor: "operator",
						authorizedAt: "2026-04-01T01:00:00Z",
						authorizationWorkflowRunId: 51,
						sourceCommit: "c".repeat(40),
					});
					return {
						stagingAuthorization,
						stagingRun: {
							workflowRunId: 51,
							name: "Authorize promotion",
							event: "workflow_dispatch",
							artifactName: "promotion-authorization-51",
							sourceRepository: repository,
							conclusion: "success",
						},
					};
				})()
			: {}),
	});
	const authorization = finalizePromotionAuthorization({
		draft,
		actor: "operator",
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
			attestationId: "provenance-1",
		},
		environment: target,
		composeImages: {
			postgres: postgresImage,
			cloudflared: `cloudflare/cloudflared@${digest("e")}`,
		},
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
		backlog: { oldestSeconds: 60 },
	};
}
function fake(): DeploymentAdapter & {
	events: string[];
	state?: ReturnType<DeploymentAdapter["readState"]>;
	compose?: string;
} {
	const events: string[] = [];
	let state: ReturnType<DeploymentAdapter["readState"]>;
	let compose: string | undefined;
	return {
		events,
		readState: () => state,
		writeStateAtomic: (next) => {
			events.push("state");
			state = next;
		},
		readCompose: () => compose,
		stageComposeAtomic: (next) => {
			events.push("compose");
			compose = next;
		},
		pull: async (reference) => {
			events.push(`pull:${reference}`);
		},
		inspect: async (reference) => {
			events.push(`inspect:${reference}`);
			return { reference, platform: "linux/amd64" };
		},
		converge: async () => {
			events.push("converge");
		},
	};
}

describe("pull-based deployctl", () => {
	test("RED: requires independent exact-artifact authorization proof and exact image repository binding", () => {
		const input = fixture();
		expect(() =>
			planDeployment({
				...input,
				gates: gates(),
				authorizationProof: { ...input.authorizationProof, verified: false },
			}),
		).toThrow("deploy.authorization_proof_invalid");
		expect(() =>
			planDeployment({
				...input,
				gates: gates(),
				authorizationProof: {
					...input.authorizationProof,
					artifactSha256: digest("9"),
				},
			}),
		).toThrow("deploy.authorization_proof_invalid");
		expect(() =>
			planDeployment({
				...input,
				gates: gates(),
				manifest: {
					...input.manifest,
					images: {
						...input.manifest.images,
						api: `${imageRepository}-evil/api@${digest("a")}`,
					},
				},
			}),
		).toThrow();
	});
	test("GREEN/TRIANGULATE: pulls and inspects every unique rendered digest including infrastructure", async () => {
		const input = fixture("release-set", "production");
		const plan = planDeployment({ ...input, gates: gates() });
		const adapter = fake();
		await applyDeployment(plan, adapter);
		expect(adapter.events.filter((event) => event.startsWith("pull:"))).toEqual(
			plan.imageReferences.map((reference) => `pull:${reference}`),
		);
		expect(plan.imageReferences).toContain(input.composeImages.postgres);
		expect(plan.imageReferences).toContain(input.composeImages.cloudflared);
		expect(plan.snapshot.audit.authorizationId).toBe(
			input.authorization.authorizationId,
		);
	});
	test("uses persisted Compose bytes and restores exact absent state and Compose after failed convergence", async () => {
		const input = fixture();
		const plan = planDeployment({ ...input, gates: gates() });
		const adapter = fake();
		adapter.converge = async () => {
			throw new Error("convergence failed");
		};
		await expect(applyDeployment(plan, adapter)).rejects.toThrow(
			"convergence failed",
		);
		expect(adapter.readState()).toBeUndefined();
		expect(adapter.readCompose()).toBeUndefined();
		const tampered = fake();
		tampered.stageComposeAtomic = () => {
			tampered.compose = "tampered";
		};
		tampered.converge = async () => {};
		await expect(applyDeployment(plan, tampered)).rejects.toThrow(
			"deploy.compose_hash_invalid",
		);
	});
	test("RED: accepts the actual PR11 repository boundary, rejects siblings and official-cloudflared substitution", () => {
		const input = fixture("release-set");
		const valid = planDeployment({ ...input, gates: gates() });
		expect(valid.imageReferences).toContain(
			`${imageRepository}@${digest("a")}`,
		);
		expect(() =>
			planDeployment({
				...input,
				gates: gates(),
				evidence: {
					...input.evidence,
					imageRepository: `${imageRepository}/web`,
				},
			}),
		).toThrow("deploy.release_evidence_invalid");
		expect(() =>
			planDeployment({
				...input,
				gates: gates(),
				composeImages: {
					...input.composeImages,
					cloudflared: `${imageRepository}@${digest("e")}`,
				},
			}),
		).toThrow("deploy.compose_images_invalid");
	});
	test("RED: rejects forged or changed plans before adapters observe them", async () => {
		const plan = planDeployment({ ...fixture(), gates: gates() });
		const forged = { ...plan };
		const adapter = fake();
		await expect(applyDeployment(forged, adapter)).rejects.toThrow(
			"deploy.plan_invalid",
		);
		expect(adapter.events).toEqual([]);
		const changed = structuredClone(plan) as typeof plan;
		changed.imageReferences = [];
		await expect(applyDeployment(changed, adapter)).rejects.toThrow(
			"deploy.plan_invalid",
		);
		expect(adapter.events).toEqual([]);
	});
	test("RED: rejects cross-environment state before staging Compose or image work", async () => {
		const first = planDeployment({ ...fixture(), gates: gates() });
		const adapter = fake();
		adapter.writeStateAtomic({
			schemaVersion: 1,
			current: first.snapshot,
			previous: null,
		});
		adapter.events.length = 0;
		const production = planDeployment({
			...fixture(
				"universal-image",
				"production",
				"c",
				first.manifest.releaseDigest,
			),
			gates: gates(first.manifest.releaseDigest),
		});
		await expect(applyDeployment(production, adapter)).rejects.toThrow(
			"deploy.current_state_invalid",
		);
		expect(adapter.events).toEqual([]);
	});
	test("RED: rolls back only coherent expand-compatible snapshots and restores exact bytes when convergence fails", async () => {
		const adapter = fake();
		const first = planDeployment({ ...fixture(), gates: gates() });
		await applyDeployment(first, adapter);
		const second = planDeployment({
			...fixture(
				"universal-image",
				"staging",
				"c",
				first.manifest.releaseDigest,
			),
			gates: gates(first.manifest.releaseDigest),
		});
		await applyDeployment(second, adapter);
		adapter.events.length = 0;
		await rollbackDeployment(second, adapter);
		expect(adapter.readState()?.current?.releaseDigest).toBe(
			first.manifest.releaseDigest,
		);
		expect(adapter.readCompose()).toBe(first.compose);
		expect(adapter.events).toContain(`pull:${first.imageReferences[0]}`);
		const noPrevious = fake();
		noPrevious.writeStateAtomic({
			schemaVersion: 1,
			current: second.snapshot,
			previous: null,
		});
		await expect(rollbackDeployment(second, noPrevious)).rejects.toThrow(
			"deploy.rollback_invalid",
		);
		const maintenance = planDeployment({
			...fixture(
				"universal-image",
				"staging",
				"d",
				first.manifest.releaseDigest,
				"contract-maintenance",
			),
			gates: gates(first.manifest.releaseDigest),
		});
		const maintenanceAdapter = fake();
		maintenanceAdapter.writeStateAtomic({
			schemaVersion: 1,
			current: maintenance.snapshot,
			previous: first.snapshot,
		});
		await expect(
			rollbackDeployment(maintenance, maintenanceAdapter),
		).rejects.toThrow("deploy.rollback_invalid");
		const failing = fake();
		failing.writeStateAtomic({
			schemaVersion: 1,
			current: second.snapshot,
			previous: first.snapshot,
		});
		failing.stageComposeAtomic(second.compose);
		const beforeState = failing.readState();
		failing.converge = async () => {
			throw new Error("rollback convergence failed");
		};
		await expect(rollbackDeployment(second, failing)).rejects.toThrow(
			"rollback convergence failed",
		);
		expect(failing.readState()).toEqual(beforeState);
		expect(failing.readCompose()).toBe(second.compose);
	});
	test("filesystem store atomically persists a single envelope and generated Compose then restores bytes", async () => {
		const root = await mkdtemp(join(tmpdir(), "agendia-deployctl-"));
		try {
			const runtime = fake();
			const store = createFilesystemDeploymentAdapter(root, runtime);
			const input = fixture();
			const plan = planDeployment({ ...input, gates: gates() });
			await applyDeployment(plan, store);
			const before = await readFile(join(root, "state.json"), "utf8");
			await writeFile(join(root, "compose.yml"), "old-compose-bytes");
			store.converge = async () => {
				throw new Error("convergence failed");
			};
			const candidate = fixture(
				"universal-image",
				"staging",
				"c",
				input.manifest.releaseDigest,
			);
			await expect(
				applyDeployment(
					planDeployment({
						...candidate,
						gates: gates(input.manifest.releaseDigest),
					}),
					store,
				),
			).rejects.toThrow("convergence failed");
			expect(await readFile(join(root, "state.json"), "utf8")).toBe(before);
			expect(await readFile(join(root, "compose.yml"), "utf8")).toBe(
				"old-compose-bytes",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

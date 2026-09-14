import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	applyDeployment,
	createFilesystemDeploymentAdapter,
	parseHostCommand,
	planDeployment,
	rollbackDeployment,
	runApprovedHostCommand,
	withEnvironmentLock,
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
function fake(ordered = true): DeploymentAdapter & {
	events: string[];
	state?: ReturnType<DeploymentAdapter["readState"]>;
	compose?: string;
	evidence?: string;
} {
	const events: string[] = [];
	let state: ReturnType<DeploymentAdapter["readState"]>;
	let compose: string | undefined;
	let evidence: string | undefined;
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
		readEvidence: () => evidence,
		writeEvidenceAtomic: (next) => {
			events.push("evidence");
			evidence = next;
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
		...(ordered
			? {
					async runOrdered(bootstrapRequired: boolean) {
						events.push(`ordered:${bootstrapRequired}`);
						await this.converge("");
					},
				}
			: {}),
	};
}

describe("pull-based deployctl", () => {
	test("RED: accepts only the fixed direct-source grammar", () => {
		const command = parseHostCommand([
			"apply",
			"staging",
			"--commit",
			commit,
			"--digest",
			digest("a"),
		]);
		expect(command).toEqual({
			operation: "apply",
			environment: "staging",
			commit,
			digest: digest("a"),
		});
		for (const argv of [
			["apply", "staging", "--digest", digest("a"), "--commit", commit],
			["build", "staging", "--commit", commit, "--digest", digest("a")],
			["apply", "staging", "--commit", `${commit};sh`, "--digest", digest("a")],
			["apply", "staging", "--commit", commit, "--digest", "latest"],
		])
			expect(() => parseHostCommand(argv)).toThrow("deploy.command_invalid");
	});
	test("RED: dispatches only approved plan, apply, and compatible rollback inputs", async () => {
		const plan = planDeployment({ ...fixture(), gates: gates() });
		const adapter = fake();
		await runApprovedHostCommand(
			{
				operation: "plan",
				environment: "staging",
				commit,
				digest: plan.snapshot.releaseDigest,
			},
			plan,
			adapter,
		);
		expect(adapter.events).toEqual([]);
		await expect(
			runApprovedHostCommand(
				{
					operation: "status",
					environment: "staging",
					commit,
					digest: plan.snapshot.releaseDigest,
				},
				plan,
				adapter,
			),
		).resolves.toBeUndefined();
		expect(adapter.events).toEqual([]);
		adapter.writeStateAtomic({
			schemaVersion: 1,
			current: plan.snapshot,
			previous: null,
		});
		adapter.stageComposeAtomic("tampered");
		adapter.events.length = 0;
		await expect(
			runApprovedHostCommand(
				{
					operation: "status",
					environment: "staging",
					commit,
					digest: plan.snapshot.releaseDigest,
				},
				plan,
				adapter,
			),
		).rejects.toThrow("deploy.status_invalid");
		expect(adapter.events).toEqual([]);
		await expect(
			runApprovedHostCommand(
				{
					...parseHostCommand([
						"apply",
						"staging",
						"--commit",
						commit,
						"--digest",
						digest("c"),
					]),
				},
				plan,
				adapter,
			),
		).rejects.toThrow("deploy.approved_input_invalid");
	});

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
		expect(adapter.events).toContain("ordered:false");
	});

	test("RED: requires an ordered runtime before apply effects and excludes it from rollback", async () => {
		const first = planDeployment({ ...fixture(), gates: gates() });
		const adapter = fake(false);
		await expect(applyDeployment(first, adapter)).rejects.toThrow(
			"deploy.ordered_runtime_required",
		);
		expect(adapter.events).toEqual([]);
		const ordered = fake();
		await applyDeployment(first, ordered);
		const second = planDeployment({
			...fixture(
				"universal-image",
				"staging",
				"c",
				first.manifest.releaseDigest,
			),
			gates: gates(first.manifest.releaseDigest),
		});
		await applyDeployment(second, ordered);
		ordered.events.length = 0;
		await rollbackDeployment(second, ordered);
		expect(ordered.events).not.toContain("ordered:false");
		expect(ordered.events).toContain("converge");
	});
	test("uses persisted Compose bytes and restores exact absent state and Compose after failed convergence", async () => {
		const input = fixture();
		const plan = planDeployment({ ...input, gates: gates() });
		const adapter = fake();
		adapter.converge = async () => {
			throw new Error("convergence failed");
		};
		await expect(applyDeployment(plan, adapter)).rejects.toThrow(
			"deploy.operation_failed",
		);
		expect(adapter.readState()).toBeUndefined();
		expect(adapter.readCompose()).toBe(plan.compose);
		const tampered = fake();
		tampered.stageComposeAtomic = () => {
			tampered.compose = "tampered";
		};
		tampered.converge = async () => {};
		await expect(applyDeployment(plan, tampered)).rejects.toThrow(
			"deploy.operation_failed",
		);
	});
	test("RED: does not publish state when closed evidence persistence fails before convergence", async () => {
		const adapter = fake();
		adapter.writeEvidenceAtomic = () => {
			throw new Error("evidence failure");
		};
		const plan = planDeployment({ ...fixture(), gates: gates() });
		await expect(applyDeployment(plan, adapter)).rejects.toThrow(
			"evidence failure",
		);
		expect(adapter.readState()).toBeUndefined();
		expect(adapter.readCompose()).toBe(plan.compose);
		expect(adapter.readEvidence?.()).toBeUndefined();
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
			failing.events.push("converge");
			throw new Error("rollback convergence failed");
		};
		await expect(rollbackDeployment(second, failing)).rejects.toThrow(
			"deploy.operation_failed",
		);
		expect(failing.readState()).toEqual(beforeState);
		expect(failing.readCompose()).toBe(first.compose);
		expect(failing.events.filter((event) => event === "converge")).toHaveLength(
			1,
		);
	});
	test("RED: records the executing tooling commit rather than the rollback snapshot commit", async () => {
		const first = planDeployment({ ...fixture(), gates: gates() });
		const second = planDeployment({
			...fixture(
				"universal-image",
				"staging",
				"c",
				first.manifest.releaseDigest,
			),
			gates: gates(first.manifest.releaseDigest),
		});
		const previous = structuredClone(first.snapshot);
		const priorCommit = "d".repeat(40);
		previous.manifest.commit = priorCommit;
		previous.audit.commit = priorCommit;
		previous.audit.manifest = previous.manifest;
		const adapter = fake();
		adapter.writeStateAtomic({
			schemaVersion: 1,
			current: second.snapshot,
			previous,
		});
		adapter.stageComposeAtomic(second.compose);
		await rollbackDeployment(second, adapter);
		expect(adapter.readEvidence?.()).toContain(`"toolingCommit":"${commit}"`);
	});

	test("RED: reports persistence uncertainty when it cannot record a failed unsafe effect", async () => {
		const adapter = fake();
		let writes = 0;
		adapter.writeEvidenceAtomic = () => {
			if (++writes > 1) throw new Error("fault evidence unavailable");
		};
		adapter.converge = async () => {
			throw new Error("unsafe effect failed");
		};
		const plan = planDeployment({ ...fixture(), gates: gates() });
		await expect(applyDeployment(plan, adapter)).rejects.toThrow(
			"deploy.persistence_unknown",
		);
		expect(adapter.readState()).toBeUndefined();
	});

	test("TRIANGULATE: retains staged Compose and closed failed evidence after an unsafe effect without reconverging", async () => {
		const adapter = fake();
		const plan = planDeployment({ ...fixture(), gates: gates() });
		adapter.converge = async () => {
			adapter.events.push("converge");
			throw new Error("postgres://operator:secret@example.test failed");
		};
		await expect(applyDeployment(plan, adapter)).rejects.toThrow(
			"deploy.operation_failed",
		);
		expect(adapter.readState()).toBeUndefined();
		expect(adapter.readCompose()).toBe(plan.compose);
		expect(adapter.events.filter((event) => event === "converge")).toHaveLength(
			1,
		);
		const evidence = adapter.readEvidence?.() ?? "";
		expect(evidence).toContain('"result":"fail"');
		expect(evidence).not.toContain("secret");
		expect(evidence).not.toContain("postgres:");
	});

	test("TRIANGULATE: holds a per-environment lock and preserves prior bytes before a durability fault", async () => {
		const root = await mkdtemp(join(tmpdir(), "agendia-deployctl-"));
		try {
			await writeFile(join(root, "compose.yml"), "old-compose-bytes");
			await withEnvironmentLock(root, async () => {
				await expect(withEnvironmentLock(root, async () => {})).rejects.toThrow(
					"deploy.operation_locked",
				);
			});
			const runtime = fake();
			const store = createFilesystemDeploymentAdapter(root, runtime, {
				beforeAtomicStep: (step) => {
					if (step === "file-sync")
						throw new Error("injected durability fault");
				},
			});
			expect(() => store.stageComposeAtomic("new-compose-bytes")).toThrow(
				"injected durability fault",
			);
			expect(await readFile(join(root, "compose.yml"), "utf8")).toBe(
				"old-compose-bytes",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("TRIANGULATE: reports post-rename durability uncertainty without restoring partial state", async () => {
		const root = await mkdtemp(join(tmpdir(), "agendia-deployctl-"));
		try {
			const store = createFilesystemDeploymentAdapter(root, fake(), {
				beforeAtomicStep: (step) => {
					if (step === "parent-sync")
						throw new Error("injected parent sync fault");
				},
			});
			expect(() => store.writeEvidenceAtomic?.('{"result":"pass"}')).toThrow(
				"deploy.persistence_unknown",
			);
			expect(await readFile(join(root, "evidence.json"), "utf8")).toBe(
				'{"result":"pass"}',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

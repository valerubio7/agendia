import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	authorizationPathForMatrix,
	finalizePromotionAuthorization,
	preparePromotionAuthorization,
} from "../../scripts/promotion-authorization.ts";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "b".repeat(40);
const authorizationSourceCommit = "c".repeat(40);
const repository = "valerubio7/agendia";
const releaseRun = {
	workflowRunId: 41,
	name: "Release evidence",
	event: "workflow_run",
	headSha: commit,
	artifactName: `release-evidence-${commit}`,
	sourceRepository: repository,
	conclusion: "success",
};
const requiredChecks = [
	"quality",
	"unit",
	"postgres",
	"browser",
	"aggregate-contract",
	"source-build",
];
const matrix = (environmentAvailability = "unconfirmed") => ({
	schemaVersion: 1,
	mode: "SOLO_PILOT",
	controls: [
		[
			"pr-entry",
			"required",
			"available",
			"policy-and-release-verifier",
			"pull-request-history",
		],
		[
			"squash-integration",
			"required",
			"unconfirmed",
			"policy-and-release-verifier",
			"release-evidence",
		],
		[
			"main-integrity",
			"desired",
			"unconfirmed",
			"policy-and-release-verifier",
			"release-evidence",
		],
		["ci", "required", "available", "required-checks", "release-evidence"],
		["codeowners", "advisory", "available", "advisory", "CODEOWNERS"],
		[
			"github-environments",
			"desired",
			environmentAvailability,
			environmentAvailability === "available"
				? "github-environment"
				: "workflow-dispatch-fallback",
			"github-plan-unconfirmed",
		],
		[
			"promotion",
			"required",
			"available",
			"two-manual-workflow-dispatches",
			"promotion-authorization",
		],
		[
			"independent-reviewer",
			"desired",
			"unavailable",
			"inactive",
			"multi-maintainer-transition",
		],
		[
			"self-review-prevention",
			"desired",
			"unavailable",
			"inactive",
			"multi-maintainer-transition",
		],
	].map(([control, desired, availability, effective, evidence]) => ({
		control,
		desired,
		availability,
		effective,
		evidence,
	})),
});
const read = (path: string) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function releaseEvidence(
	kind: "universal-image" | "release-set" = "universal-image",
) {
	const image = `ghcr.io/${repository}@${digest}`;
	const images =
		kind === "universal-image"
			? {
					web: image,
					api: image,
					"whatsapp-manager": image,
					"message-worker": image,
				}
			: {
					web: image.replace("agendia@", "agendia-web@"),
					api: image.replace("agendia@", "agendia-api@"),
					"whatsapp-manager": image.replace("agendia@", "agendia-manager@"),
					"message-worker": image.replace("agendia@", "agendia-worker@"),
				};
	const manifestDatabase = {
		compatibility: "expand-compatible",
		previousReleaseDigest: `sha256:${"0".repeat(64)}`,
		minimumLedger: "0022_service_heartbeats.sql",
	};
	return {
		schemaVersion: 1,
		sourceRepository: repository,
		imageRepository: `ghcr.io/${repository}`,
		workflowRunId: 19,
		mergedPullRequest: 12,
		actor: "valerubio7",
		timestamp: "2026-04-01T00:00:00Z",
		commit,
		checks: requiredChecks.map((name) => ({
			name,
			status: "completed",
			conclusion: "success",
		})),
		artifactKind: kind,
		platform: "linux/amd64",
		releaseDigest: digest,
		images,
		database: {
			schemaVersion: 1,
			...manifestDatabase,
			previousReleaseDigestMeaning:
				"The zero digest is a genesis sentinel for the first release and is not observed deployment history.",
		},
		generatedCommands: {
			web: ["bun", "/opt/agendia/web/server.js"],
			api: ["bun", "/opt/agendia/api/index.js"],
			"whatsapp-manager": ["bun", "/opt/agendia/whatsapp-manager/index.js"],
			"message-worker": ["bun", "/opt/agendia/message-worker/index.js"],
		},
		sbom: {
			path: "sbom.spdx.json",
			format: "spdx-json",
			digest: `sha256:${"d".repeat(64)}`,
		},
		sbomAttestation: {
			id: "sbom-1",
			url: "https://example.test/attestations/sbom-1",
		},
		provenanceAttestation: {
			id: "provenance-1",
			url: "https://example.test/attestations/provenance-1",
		},
		manifest: {
			schemaVersion: 1,
			artifactKind: kind,
			commit,
			releaseDigest: digest,
			platform: "linux/amd64",
			images,
			database: manifestDatabase,
		},
	};
}

function releaseContext() {
	const evidence = releaseEvidence();
	return {
		sourceRepository: evidence.sourceRepository,
		imageRepository: evidence.imageRepository,
		actor: evidence.actor,
		commit: evidence.commit,
		mergedPullRequest: evidence.mergedPullRequest,
		checks: evidence.checks,
		workflowRunId: evidence.workflowRunId,
	};
}
function sbomDigest() {
	return `sha256:${createHash("sha256").update("fixture-sbom").digest("hex")}`;
}
function prepare(
	target: "staging" | "production",
	options: Record<string, unknown> = {},
) {
	const evidence = releaseEvidence();
	return preparePromotionAuthorization({
		target,
		releaseDigest: digest,
		releaseEvidence: evidence,
		releaseManifest: evidence.manifest,
		releaseContext: releaseContext(),
		sbomDigest: evidence.sbom.digest,
		matrix: matrix(),
		releaseRun,
		...options,
	} as never);
}
function finalize(
	draft: unknown,
	runId: number,
	sourceCommit = authorizationSourceCommit,
) {
	return finalizePromotionAuthorization({
		draft,
		actor: "valerubio7",
		authorizedAt: "2026-04-01T01:00:00Z",
		authorizationWorkflowRunId: runId,
		sourceCommit,
	});
}
function stagingRun(runId = 51) {
	return {
		workflowRunId: runId,
		name: "Authorize promotion",
		event: "workflow_dispatch",
		artifactName: `promotion-authorization-${runId}`,
		sourceRepository: repository,
		conclusion: "success",
	};
}

describe("SOLO PILOT promotion authorization", () => {
	test("selects the versioned environment path only for available environments", () => {
		expect(authorizationPathForMatrix(matrix("available"))).toBe(
			"github-environment",
		);
		for (const availability of ["unavailable", "unconfirmed"])
			expect(authorizationPathForMatrix(matrix(availability))).toBe(
				"workflow-dispatch-fallback",
			);
		expect(
			prepare("staging", { matrix: matrix("available") }).authorizationPath,
		).toBe("github-environment");
		expect(prepare("staging").authorizationPath).toBe(
			"workflow-dispatch-fallback",
		);
	});

	test("preserves strict PR11 root database evidence and permits an older release authorization source", () => {
		const draft = prepare("staging");
		const final = finalize(draft, 51);
		expect(final.authorizationSourceCommit).toBe(authorizationSourceCommit);
		expect(final.releaseEvidence.commit).toBe(commit);
		for (const evidence of [
			{
				...releaseEvidence(),
				database: {
					...releaseEvidence().database,
					previousReleaseDigestMeaning: "",
				},
			},
			{
				...releaseEvidence(),
				database: {
					compatibility: "expand-compatible",
					previousReleaseDigest: digest,
					minimumLedger: "0022_service_heartbeats.sql",
				},
			},
			{
				...releaseEvidence(),
				database: { ...releaseEvidence().database, extra: true },
			},
		])
			expect(() => prepare("staging", { releaseEvidence: evidence })).toThrow();
	});

	test("binds strict successful run contexts and exposes only the staging summary", () => {
		const staging = finalize(prepare("staging"), 51);
		const production = finalize(
			prepare("production", {
				stagingAuthorization: staging,
				stagingRun: stagingRun(),
			}),
			52,
		);
		expect(production.stagingAuthorization).toEqual({
			authorizationId: staging.authorizationId,
			authorizationWorkflowRunId: 51,
			sourceRepository: repository,
			releaseEvidenceHash: staging.releaseEvidence.hash,
			releaseCommit: commit,
			artifactKind: "universal-image",
			releaseDigest: digest,
			ciWorkflowRunId: 19,
			releaseWorkflowRunId: 41,
		});
		for (const options of [
			{ releaseRun: { ...releaseRun, conclusion: "failure" } },
			{ releaseRun: { ...releaseRun, sourceRepository: "other/repository" } },
			{
				stagingAuthorization: staging,
				stagingRun: { ...stagingRun(), conclusion: "failure" },
			},
			{
				stagingAuthorization: staging,
				stagingRun: { ...stagingRun(), sourceRepository: "other/repository" },
			},
			{
				stagingAuthorization: { ...staging, unknown: true },
				stagingRun: stagingRun(),
			},
		])
			expect(() =>
				prepare(
					options.stagingAuthorization ? "production" : "staging",
					options,
				),
			).toThrow();
	});

	test("rejects same-digest promotions that change canonical release evidence or activate MULTI controls", () => {
		const staging = finalize(prepare("staging"), 51);
		expect(() =>
			prepare("production", {
				stagingAuthorization: staging,
				stagingRun: stagingRun(),
				releaseEvidence: releaseEvidence("release-set"),
			}),
		).toThrow();
		const contradictory = matrix();
		contradictory.controls.find(
			(control) => control.control === "independent-reviewer",
		)!.effective = "required-checks";
		expect(() => authorizationPathForMatrix(contradictory)).toThrow();
		const duplicate = matrix();
		duplicate.controls.push({ ...duplicate.controls[0]! });
		expect(() => authorizationPathForMatrix(duplicate)).toThrow();
	});

	test("rejects downloaded manifests, SBOMs, and release contexts that do not bind to evidence", () => {
		const evidence = releaseEvidence();
		expect(() =>
			prepare("staging", {
				releaseManifest: {
					...evidence.manifest,
					commit: authorizationSourceCommit,
				},
			}),
		).toThrow("authorization.release_manifest_invalid");
		expect(() => prepare("staging", { sbomDigest: sbomDigest() })).toThrow(
			"authorization.sbom_digest_invalid",
		);
		expect(() =>
			prepare("staging", {
				releaseContext: { ...releaseContext(), actor: "other" },
			}),
		).toThrow("authorization.release_context_invalid");
	});

	test("workflow enforces exact flat downloaded artifact contents before parsing", () => {
		const workflow = read(".github/workflows/authorize-promotion.yml");
		expect(workflow).toContain("release-context.json");
		expect(workflow).toContain("release-manifest.json");
		expect(workflow).toContain("release-evidence.json");
		expect(workflow).toContain("sbom.spdx.json");
		expect(workflow).toContain("promotion-authorization.json");
		expect(workflow).toContain(
			"authorization.release_artifact_contents_invalid",
		);
		expect(workflow).toContain(
			"authorization.staging_artifact_contents_invalid",
		);
		expect(workflow).toContain("sbomDigest");
		expect(workflow).toContain("authorizationPathForMatrix");
		expect(workflow).not.toContain(
			"authorization_path=workflow-dispatch-fallback",
		);
		expect(workflow).toContain("sourceRepository");
		expect(workflow).toContain("conclusion");
		expect(read(".github/CODEOWNERS")).toContain(
			"/packages/db/migrations/ @valerubio7",
		);
	});
});

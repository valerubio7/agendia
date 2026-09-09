import { createHash } from "node:crypto";
import { validateReleaseManifest } from "@agendia/release-manifest";
import { requiredReleaseChecks } from "./release-verification.ts";
import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().datetime({ offset: true });
const repository = z.string().regex(/^[a-z0-9._-]+\/[a-z0-9._-]+$/);
const artifactKind = z.enum(["universal-image", "release-set"]);
const check = z
	.object({
		name: z.string(),
		status: z.literal("completed"),
		conclusion: z.literal("success"),
	})
	.strict();
const immutableImage = z
	.string()
	.regex(
		/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)+[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/,
	);
const images = z
	.object({
		web: immutableImage,
		api: immutableImage,
		"whatsapp-manager": immutableImage,
		"message-worker": immutableImage,
	})
	.strict();
const manifestDatabase = z
	.object({
		compatibility: z.enum(["expand-compatible", "contract-maintenance"]),
		previousReleaseDigest: digest,
		minimumLedger: z.string().min(1),
	})
	.strict();
const genesisDigest = `sha256:${"0".repeat(64)}`;
const genesisMeaning =
	"The zero digest is a genesis sentinel for the first release and is not observed deployment history.";
const evidenceDatabase = manifestDatabase
	.extend({
		schemaVersion: z.literal(1),
		previousReleaseDigestMeaning: z.string(),
	})
	.strict();
const commands = z
	.object({
		web: z.array(z.string().min(1)).min(1),
		api: z.array(z.string().min(1)).min(1),
		"whatsapp-manager": z.array(z.string().min(1)).min(1),
		"message-worker": z.array(z.string().min(1)).min(1),
	})
	.strict();
const releaseEvidenceSchema = z
	.object({
		schemaVersion: z.literal(1),
		sourceRepository: repository,
		imageRepository: z.string(),
		workflowRunId: z.number().int().positive(),
		mergedPullRequest: z.number().int().positive(),
		actor: z.string().min(1),
		timestamp,
		commit: sha,
		checks: z.array(check),
		artifactKind,
		platform: z.literal("linux/amd64"),
		releaseDigest: digest,
		images,
		database: evidenceDatabase,
		generatedCommands: commands,
		sbom: z
			.object({
				path: z.string().min(1),
				format: z.literal("spdx-json"),
				digest,
			})
			.strict(),
		sbomAttestation: z
			.object({ id: z.string().min(1), url: z.string().url() })
			.strict(),
		provenanceAttestation: z
			.object({ id: z.string().min(1), url: z.string().url() })
			.strict(),
		manifest: z.unknown(),
	})
	.strict();
const releaseContextSchema = z
	.object({
		sourceRepository: repository,
		imageRepository: z.string(),
		actor: z.string().min(1),
		commit: sha,
		mergedPullRequest: z.number().int().positive(),
		checks: z.array(check),
		workflowRunId: z.number().int().positive(),
	})
	.strict();
const releaseRunSchema = z
	.object({
		workflowRunId: z.number().int().positive(),
		name: z.literal("Release evidence"),
		event: z.literal("workflow_run"),
		headSha: sha,
		artifactName: z.string(),
		sourceRepository: repository,
		conclusion: z.literal("success"),
	})
	.strict();
const stagingRunSchema = z
	.object({
		workflowRunId: z.number().int().positive(),
		name: z.literal("Authorize promotion"),
		event: z.literal("workflow_dispatch"),
		artifactName: z.string(),
		sourceRepository: repository,
		conclusion: z.literal("success"),
	})
	.strict();
const controlName = z.enum([
	"pr-entry",
	"squash-integration",
	"main-integrity",
	"ci",
	"codeowners",
	"github-environments",
	"promotion",
	"independent-reviewer",
	"self-review-prevention",
]);
const control = z
	.object({
		control: controlName,
		desired: z.enum(["required", "desired", "advisory"]),
		availability: z.enum(["available", "unavailable", "unconfirmed"]),
		effective: z.enum([
			"policy-and-release-verifier",
			"required-checks",
			"advisory",
			"github-environment",
			"workflow-dispatch-fallback",
			"two-manual-workflow-dispatches",
			"inactive",
		]),
		evidence: z.string().min(1),
	})
	.strict();
const matrixSchema = z
	.object({
		schemaVersion: z.literal(1),
		mode: z.literal("SOLO_PILOT"),
		controls: z.array(control),
	})
	.strict();
const releaseSummary = z
	.object({
		ciWorkflowRunId: z.number().int().positive(),
		releaseWorkflowRunId: z.number().int().positive(),
		workflowName: z.literal("Release evidence"),
		workflowEvent: z.literal("workflow_run"),
		headSha: sha,
		artifactName: z.string(),
		sourceRepository: repository,
		commit: sha,
		artifactKind,
		releaseDigest: digest,
		hash: digest,
	})
	.strict();
const stagingSummary = z
	.object({
		authorizationId: digest,
		authorizationWorkflowRunId: z.number().int().positive(),
		sourceRepository: repository,
		releaseEvidenceHash: digest,
		releaseCommit: sha,
		artifactKind,
		releaseDigest: digest,
		ciWorkflowRunId: z.number().int().positive(),
		releaseWorkflowRunId: z.number().int().positive(),
	})
	.strict();
const draftSchema = z
	.object({
		schemaVersion: z.literal(1),
		mode: z.literal("SOLO_PILOT"),
		target: z.enum(["staging", "production"]),
		sourceRepository: repository,
		releaseDigest: digest,
		artifactKind,
		checks: z.array(check),
		authorizationPath: z.enum([
			"github-environment",
			"workflow-dispatch-fallback",
		]),
		stagingAuthorizationId: digest.nullable(),
		releaseEvidence: releaseSummary,
		stagingAuthorization: stagingSummary.nullable(),
	})
	.strict();
const finalSchema = draftSchema
	.extend({
		actor: z.string().min(1),
		authorizedAt: timestamp,
		authorizationWorkflowRunId: z.number().int().positive(),
		authorizationSourceCommit: sha,
		authorizationId: digest,
	})
	.strict();
export type PromotionAuthorization = z.infer<typeof finalSchema>;

/** Stable JSON serialization: object keys sort recursively and array order remains semantic. */
export function canonicalize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function hash(value: unknown) {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
function same(left: unknown, right: unknown) {
	return canonicalize(left) === canonicalize(right);
}

/** Resolves the only executable authorization path from the versioned SOLO matrix. */
export function authorizationPathForMatrix(value: unknown) {
	const parsed = matrixSchema.parse(value);
	const expected = new Set(controlName.options);
	if (
		parsed.controls.length !== expected.size ||
		new Set(parsed.controls.map((entry) => entry.control)).size !==
			expected.size ||
		parsed.controls.some((entry) => !expected.has(entry.control))
	)
		throw new Error("authorization.governance_controls_invalid");
	const controls = Object.fromEntries(
		parsed.controls.map((entry) => [entry.control, entry]),
	) as Record<z.infer<typeof controlName>, z.infer<typeof control>>;
	const environment = controls["github-environments"];
	if (
		!environment ||
		!["available", "unavailable", "unconfirmed"].includes(
			environment.availability,
		) ||
		(environment.availability === "available"
			? environment.effective !== "github-environment"
			: environment.effective !== "workflow-dispatch-fallback") ||
		controls["pr-entry"].effective !== "policy-and-release-verifier" ||
		controls["squash-integration"].effective !==
			"policy-and-release-verifier" ||
		controls["main-integrity"].effective !== "policy-and-release-verifier" ||
		controls.ci.effective !== "required-checks" ||
		controls.codeowners.effective !== "advisory" ||
		controls.promotion.effective !== "two-manual-workflow-dispatches" ||
		controls["independent-reviewer"].effective !== "inactive" ||
		controls["self-review-prevention"].effective !== "inactive"
	)
		throw new Error("authorization.governance_claim_invalid");
	return environment.availability === "available"
		? "github-environment"
		: ("workflow-dispatch-fallback" as const);
}
function validateRelease(input: {
	releaseEvidence: unknown;
	releaseManifest: unknown;
	releaseContext: unknown;
	sbomDigest: unknown;
	releaseDigest: string;
	releaseRun: unknown;
}) {
	const evidence = releaseEvidenceSchema.parse(input.releaseEvidence),
		context = releaseRunSchema.parse(input.releaseRun),
		releaseManifest = validateReleaseManifest(input.releaseManifest),
		manifest = validateReleaseManifest(evidence.manifest),
		releaseContext = releaseContextSchema.parse(input.releaseContext),
		sbomDigest = digest.parse(input.sbomDigest);
	if (!same(releaseManifest, manifest))
		throw new Error("authorization.release_manifest_invalid");
	if (sbomDigest !== evidence.sbom.digest)
		throw new Error("authorization.sbom_digest_invalid");
	if (
		releaseContext.sourceRepository !== evidence.sourceRepository ||
		releaseContext.imageRepository !== evidence.imageRepository ||
		releaseContext.actor !== evidence.actor ||
		releaseContext.commit !== evidence.commit ||
		releaseContext.mergedPullRequest !== evidence.mergedPullRequest ||
		releaseContext.workflowRunId !== evidence.workflowRunId ||
		!same(releaseContext.checks, evidence.checks) ||
		releaseContext.sourceRepository !== context.sourceRepository ||
		releaseContext.commit !== context.headSha
	)
		throw new Error("authorization.release_context_invalid");
	if (
		evidence.database.previousReleaseDigest === genesisDigest
			? evidence.database.previousReleaseDigestMeaning !== genesisMeaning
			: evidence.database.previousReleaseDigestMeaning !== ""
	)
		throw new Error("authorization.release_database_invalid");
	if (
		context.headSha !== evidence.commit ||
		context.sourceRepository !== evidence.sourceRepository ||
		context.artifactName !== `release-evidence-${context.headSha}` ||
		evidence.imageRepository !== `ghcr.io/${evidence.sourceRepository}` ||
		evidence.releaseDigest !== input.releaseDigest ||
		evidence.commit !== manifest.commit ||
		evidence.artifactKind !== manifest.artifactKind ||
		evidence.platform !== manifest.platform ||
		evidence.releaseDigest !== manifest.releaseDigest ||
		!same(evidence.images, manifest.images) ||
		!same(
			{
				compatibility: evidence.database.compatibility,
				previousReleaseDigest: evidence.database.previousReleaseDigest,
				minimumLedger: evidence.database.minimumLedger,
			},
			manifest.database,
		)
	)
		throw new Error("authorization.release_identity_invalid");
	if (
		new Set(evidence.checks.map((entry) => entry.name)).size !==
			requiredReleaseChecks.length ||
		evidence.checks.length !== requiredReleaseChecks.length ||
		requiredReleaseChecks.some(
			(name) => !evidence.checks.some((entry) => entry.name === name),
		)
	)
		throw new Error("authorization.required_checks_invalid");
	return { evidence, context, hash: hash(evidence) };
}
/** Validates the integrity-protected final authorization for local deploy consumers. */
export function validateFinalPromotionAuthorization(
	value: unknown,
): PromotionAuthorization {
	const authorization = finalSchema.parse(value);
	const { authorizationId: _authorizationId, ...withoutId } = authorization;
	if (authorization.authorizationId !== hash(withoutId))
		throw new Error("authorization.integrity_invalid");
	return authorization;
}
function summarizeStaging(authorization: PromotionAuthorization) {
	return stagingSummary.parse({
		authorizationId: authorization.authorizationId,
		authorizationWorkflowRunId: authorization.authorizationWorkflowRunId,
		sourceRepository: authorization.sourceRepository,
		releaseEvidenceHash: authorization.releaseEvidence.hash,
		releaseCommit: authorization.releaseEvidence.commit,
		artifactKind: authorization.releaseEvidence.artifactKind,
		releaseDigest: authorization.releaseEvidence.releaseDigest,
		ciWorkflowRunId: authorization.releaseEvidence.ciWorkflowRunId,
		releaseWorkflowRunId: authorization.releaseEvidence.releaseWorkflowRunId,
	});
}

export function preparePromotionAuthorization(input: {
	target: "staging" | "production";
	releaseDigest: string;
	releaseEvidence: unknown;
	releaseManifest: unknown;
	releaseContext: unknown;
	sbomDigest: unknown;
	matrix: unknown;
	releaseRun: unknown;
	stagingAuthorization?: unknown;
	stagingRun?: unknown;
}) {
	const requestedDigest = digest.parse(input.releaseDigest),
		authorizationPath = authorizationPathForMatrix(input.matrix),
		release = validateRelease({ ...input, releaseDigest: requestedDigest });
	if (
		input.target === "staging" &&
		(input.stagingAuthorization !== undefined || input.stagingRun !== undefined)
	)
		throw new Error("authorization.staging_evidence_forbidden");
	let stagingAuthorization: PromotionAuthorization | null = null;
	if (input.target === "production") {
		stagingAuthorization = validateFinalPromotionAuthorization(
			input.stagingAuthorization,
		);
		const stagingRun = stagingRunSchema.parse(input.stagingRun);
		const summary = summarizeStaging(stagingAuthorization);
		if (
			stagingRun.workflowRunId !== summary.authorizationWorkflowRunId ||
			stagingRun.sourceRepository !== release.evidence.sourceRepository ||
			stagingRun.artifactName !==
				`promotion-authorization-${stagingRun.workflowRunId}` ||
			stagingAuthorization.target !== "staging" ||
			summary.releaseEvidenceHash !== release.hash ||
			summary.sourceRepository !== release.evidence.sourceRepository ||
			summary.releaseCommit !== release.evidence.commit ||
			summary.artifactKind !== release.evidence.artifactKind ||
			summary.releaseDigest !== requestedDigest ||
			summary.ciWorkflowRunId !== release.evidence.workflowRunId ||
			summary.releaseWorkflowRunId !== release.context.workflowRunId
		)
			throw new Error("authorization.staging_evidence_invalid");
	}
	return draftSchema.parse({
		schemaVersion: 1,
		mode: "SOLO_PILOT",
		target: input.target,
		sourceRepository: release.evidence.sourceRepository,
		releaseDigest: requestedDigest,
		artifactKind: release.evidence.artifactKind,
		checks: release.evidence.checks,
		authorizationPath,
		stagingAuthorizationId: stagingAuthorization?.authorizationId ?? null,
		releaseEvidence: {
			ciWorkflowRunId: release.evidence.workflowRunId,
			releaseWorkflowRunId: release.context.workflowRunId,
			workflowName: release.context.name,
			workflowEvent: release.context.event,
			headSha: release.context.headSha,
			artifactName: release.context.artifactName,
			sourceRepository: release.evidence.sourceRepository,
			commit: release.evidence.commit,
			artifactKind: release.evidence.artifactKind,
			releaseDigest: requestedDigest,
			hash: release.hash,
		},
		stagingAuthorization: stagingAuthorization
			? summarizeStaging(stagingAuthorization)
			: null,
	});
}
export function finalizePromotionAuthorization(input: {
	draft: unknown;
	actor: string;
	authorizedAt: string;
	authorizationWorkflowRunId: number;
	sourceCommit: string;
}) {
	const draft = draftSchema.parse(input.draft);
	if (
		!input.actor.trim() ||
		!timestamp.safeParse(input.authorizedAt).success ||
		!Number.isSafeInteger(input.authorizationWorkflowRunId) ||
		input.authorizationWorkflowRunId < 1 ||
		!sha.safeParse(input.sourceCommit).success
	)
		throw new Error("authorization.identity_invalid");
	const unsigned = {
		...draft,
		actor: input.actor,
		authorizedAt: input.authorizedAt,
		authorizationWorkflowRunId: input.authorizationWorkflowRunId,
		authorizationSourceCommit: input.sourceCommit,
	};
	return finalSchema.parse({ ...unsigned, authorizationId: hash(unsigned) });
}

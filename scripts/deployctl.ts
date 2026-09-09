import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	validateReleaseManifest,
	type ReleaseManifest,
} from "@agendia/release-manifest";
import {
	canonicalize,
	validateFinalPromotionAuthorization,
} from "./promotion-authorization.ts";
import { renderCompose } from "./render-compose.ts";
import { postgresImage } from "./support/locked-images.ts";

const genesisDigest = `sha256:${"0".repeat(64)}`;
const processes = ["web", "api", "whatsapp-manager", "message-worker"] as const;
const cloudflaredRepository = "cloudflare/cloudflared";
type Environment = "staging" | "production";
type ImageMap = Record<(typeof processes)[number], string>;
type RecordValue = Record<string, unknown>;

interface StateEnvelope {
	schemaVersion: 1;
	current: ReleaseSnapshot | null;
	previous: ReleaseSnapshot | null;
}

export interface DeploymentRuntime {
	pull(reference: string): Promise<void>;
	inspect(reference: string): Promise<{ reference: string; platform: string }>;
	converge(compose: string): Promise<void>;
}
/** Bounded local adapter: state is one envelope and Compose is an independently staged byte file. */
export interface DeploymentAdapter extends DeploymentRuntime {
	readState(): StateEnvelope | undefined;
	writeStateAtomic(state: StateEnvelope | undefined): void;
	readCompose(): string | undefined;
	stageComposeAtomic(compose: string | undefined): void;
}
export interface ReleaseSnapshot {
	schemaVersion: 1;
	releaseDigest: string;
	compatibility: "expand-compatible" | "contract-maintenance";
	compose: string;
	composeHash: string;
	manifest: ReleaseManifest;
	imageReferences: string[];
	audit: {
		environment: Environment;
		authorizationId: string;
		authorizationArtifactSha256: string;
		authorizationProofRunId: number;
		releaseEvidenceHash: string;
		sourceRepository: string;
		commit: string;
		releaseDigest: string;
		manifest: ReleaseManifest;
		composeHash: string;
	};
}
export interface DeploymentPlan {
	environment: Environment;
	manifest: ReleaseManifest;
	compose: string;
	composeHash: string;
	imageReferences: string[];
	snapshot: ReleaseSnapshot;
}

function record(value: unknown, code: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(code);
	return value as RecordValue;
}
function exact(value: unknown, keys: string[], code: string): RecordValue {
	const parsed = record(value, code);
	if (Object.keys(parsed).sort().join(",") !== [...keys].sort().join(","))
		throw new Error(code);
	return parsed;
}
function equal(left: unknown, right: unknown) {
	return canonicalize(left) === canonicalize(right);
}
function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
function sha(value: string) {
	return `sha256:${hash(value)}`;
}
function environment(value: unknown): Environment {
	if (value !== "staging" && value !== "production")
		throw new Error("deploy.environment_invalid");
	return value;
}
function immutableAtRepository(reference: unknown, imageRepository: string) {
	return (
		typeof reference === "string" &&
		new RegExp(
			`^${imageRepository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[a-f0-9]{64}$`,
		).test(reference)
	);
}
function immutableCloudflared(reference: unknown) {
	return immutableAtRepository(reference, cloudflaredRepository);
}
function uniqueReferences(value: unknown, code: string) {
	if (
		!Array.isArray(value) ||
		!value.every((reference) => typeof reference === "string")
	)
		throw new Error(code);
	const references = [...new Set(value)].sort();
	if (references.length !== value.length) throw new Error(code);
	return references;
}
function validateSnapshotImages(
	references: unknown,
	manifest: ReleaseManifest,
	compose: string,
	code: string,
) {
	const actual = uniqueReferences(references, code);
	const cloudflared = actual.filter(immutableCloudflared);
	const expected = [
		...new Set([
			...Object.values(manifest.images),
			postgresImage,
			...cloudflared,
		]),
	].sort();
	if (
		cloudflared.length !== 1 ||
		canonicalize(actual) !== canonicalize(expected) ||
		actual.some((reference) => !compose.includes(reference))
	)
		throw new Error(code);
	return actual;
}
const planSeals = new WeakMap<object, string>();
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>))
			deepFreeze(child);
	}
	return value;
}
function sealPlan(plan: DeploymentPlan) {
	const sealed = deepFreeze(plan);
	planSeals.set(sealed, canonicalize(sealed));
	return sealed;
}
function assertCanonicalPlan(plan: DeploymentPlan) {
	const seal =
		plan && typeof plan === "object" ? planSeals.get(plan) : undefined;
	if (!seal || seal !== canonicalize(plan))
		throw new Error("deploy.plan_invalid");
}
function validateAuthorizationRelations(
	authorization: ReturnType<typeof validateFinalPromotionAuthorization>,
	target: Environment,
) {
	const release = authorization.releaseEvidence;
	if (target === "staging") {
		if (
			authorization.stagingAuthorizationId !== null ||
			authorization.stagingAuthorization !== null
		)
			throw new Error("deploy.authorization_binding_invalid");
		return;
	}
	const staging = authorization.stagingAuthorization;
	if (
		authorization.stagingAuthorizationId === null ||
		!staging ||
		authorization.stagingAuthorizationId !== staging.authorizationId ||
		staging.sourceRepository !== authorization.sourceRepository ||
		staging.releaseEvidenceHash !== release.hash ||
		staging.releaseCommit !== release.commit ||
		staging.artifactKind !== authorization.artifactKind ||
		staging.releaseDigest !== authorization.releaseDigest ||
		staging.ciWorkflowRunId !== release.ciWorkflowRunId ||
		staging.releaseWorkflowRunId !== release.releaseWorkflowRunId
	)
		throw new Error("deploy.authorization_binding_invalid");
}
function validateAuthorizationProof(
	value: unknown,
	authorization: ReturnType<typeof validateFinalPromotionAuthorization>,
	target: Environment,
) {
	const proof = exact(
		value,
		[
			"verified",
			"workflowName",
			"workflowEvent",
			"conclusion",
			"workflowRunId",
			"sourceRepository",
			"headCommit",
			"target",
			"artifactName",
			"authorizationId",
			"artifactSha256",
			"authorizationBytes",
		],
		"deploy.authorization_proof_invalid",
	);
	let rawAuthorization: unknown;
	try {
		rawAuthorization = JSON.parse(String(proof.authorizationBytes));
	} catch {
		throw new Error("deploy.authorization_proof_invalid");
	}
	if (
		proof.verified !== true ||
		proof.workflowName !== "Authorize promotion" ||
		proof.workflowEvent !== "workflow_dispatch" ||
		proof.conclusion !== "success" ||
		proof.workflowRunId !== authorization.authorizationWorkflowRunId ||
		proof.sourceRepository !== authorization.sourceRepository ||
		proof.headCommit !== authorization.authorizationSourceCommit ||
		proof.target !== target ||
		proof.artifactName !== `promotion-authorization-${proof.workflowRunId}` ||
		proof.authorizationId !== authorization.authorizationId ||
		proof.artifactSha256 !== sha(String(proof.authorizationBytes)) ||
		!equal(rawAuthorization, authorization)
	)
		throw new Error("deploy.authorization_proof_invalid");
	return proof as { artifactSha256: string; workflowRunId: number };
}
function validateEvidence(
	value: unknown,
	manifest: ReleaseManifest,
	authorization: ReturnType<typeof validateFinalPromotionAuthorization>,
) {
	const evidence = exact(
		value,
		[
			"schemaVersion",
			"sourceRepository",
			"imageRepository",
			"workflowRunId",
			"mergedPullRequest",
			"actor",
			"timestamp",
			"commit",
			"checks",
			"artifactKind",
			"platform",
			"releaseDigest",
			"images",
			"database",
			"generatedCommands",
			"sbom",
			"sbomAttestation",
			"provenanceAttestation",
			"manifest",
		],
		"deploy.release_evidence_invalid",
	);
	if (
		evidence.schemaVersion !== 1 ||
		evidence.sourceRepository !== authorization.sourceRepository ||
		evidence.imageRepository !== `ghcr.io/${evidence.sourceRepository}` ||
		evidence.commit !== manifest.commit ||
		evidence.artifactKind !== manifest.artifactKind ||
		evidence.platform !== "linux/amd64" ||
		evidence.releaseDigest !== manifest.releaseDigest ||
		!equal(evidence.images, manifest.images) ||
		!equal(evidence.manifest, manifest) ||
		sha(canonicalize(evidence)) !== authorization.releaseEvidence.hash ||
		!Array.isArray(evidence.checks) ||
		!equal(evidence.checks, authorization.checks)
	)
		throw new Error("deploy.release_evidence_invalid");
	return evidence;
}
function validateProofs(
	input: RecordValue,
	evidence: RecordValue,
	manifest: ReleaseManifest,
) {
	const sbom = exact(
		input.sbom,
		["verified", "digest", "format"],
		"deploy.sbom_invalid",
	);
	const provenance = exact(
		input.provenance,
		["verified", "subjectDigest", "repository", "commit", "attestationId"],
		"deploy.provenance_invalid",
	);
	const evidenceSbom = exact(
		evidence.sbom,
		["path", "format", "digest"],
		"deploy.sbom_invalid",
	);
	const evidenceProvenance = exact(
		evidence.provenanceAttestation,
		["id", "url"],
		"deploy.provenance_invalid",
	);
	if (
		sbom.verified !== true ||
		sbom.format !== "spdx-json" ||
		sbom.digest !== evidenceSbom.digest ||
		evidenceSbom.format !== "spdx-json"
	)
		throw new Error("deploy.sbom_invalid");
	if (
		provenance.verified !== true ||
		provenance.subjectDigest !== manifest.releaseDigest ||
		provenance.repository !== evidence.sourceRepository ||
		provenance.commit !== manifest.commit ||
		provenance.attestationId !== evidenceProvenance.id
	)
		throw new Error("deploy.provenance_invalid");
}
function validateGates(value: unknown, manifest: ReleaseManifest) {
	const gates = exact(
		value,
		["capacity", "migration", "restore", "backlog"],
		"deploy.gates_invalid",
	);
	const capacity = exact(
		gates.capacity,
		["clearance", "activeConflicts"],
		"deploy.capacity_invalid",
	);
	const migration = exact(
		gates.migration,
		[
			"lockAvailable",
			"backupVerified",
			"minimumLedgerPresent",
			"currentReleaseDigest",
		],
		"deploy.migration_invalid",
	);
	const restore = exact(
		gates.restore,
		["active", "verified"],
		"deploy.restore_invalid",
	);
	const backlog = exact(
		gates.backlog,
		["oldestSeconds"],
		"deploy.backlog_invalid",
	);
	if (
		capacity.clearance !== true ||
		!Array.isArray(capacity.activeConflicts) ||
		capacity.activeConflicts.length ||
		migration.lockAvailable !== true ||
		migration.backupVerified !== true ||
		migration.minimumLedgerPresent !== true ||
		migration.currentReleaseDigest !==
			manifest.database.previousReleaseDigest ||
		restore.active !== false ||
		(manifest.database.compatibility === "contract-maintenance" &&
			restore.verified !== true) ||
		typeof backlog.oldestSeconds !== "number" ||
		backlog.oldestSeconds < 0 ||
		backlog.oldestSeconds > 60
	)
		throw new Error("deploy.preflight_failed");
}
function parseState(
	value: StateEnvelope | undefined,
	expectedEnvironment?: Environment,
): {
	current?: ReleaseSnapshot;
	previous?: ReleaseSnapshot;
} {
	if (value === undefined) return {};
	const envelope = exact(
		value,
		["schemaVersion", "current", "previous"],
		"deploy.state_invalid",
	);
	if (envelope.schemaVersion !== 1) throw new Error("deploy.state_invalid");
	return {
		...(envelope.current === null
			? {}
			: {
					current: parseSnapshot(
						envelope.current,
						"deploy.current_state_invalid",
						expectedEnvironment,
					),
				}),
		...(envelope.previous === null
			? {}
			: {
					previous: parseSnapshot(
						envelope.previous,
						"deploy.previous_state_invalid",
						expectedEnvironment,
					),
				}),
	};
}
function stateEnvelope(state: {
	current?: ReleaseSnapshot;
	previous?: ReleaseSnapshot;
}): StateEnvelope {
	return {
		schemaVersion: 1,
		current: state.current ?? null,
		previous: state.previous ?? null,
	};
}
function parseSnapshot(
	value: unknown,
	code: string,
	expectedEnvironment?: Environment,
): ReleaseSnapshot {
	const snapshot = exact(
		value,
		[
			"schemaVersion",
			"releaseDigest",
			"compatibility",
			"compose",
			"composeHash",
			"manifest",
			"imageReferences",
			"audit",
		],
		code,
	);
	const manifest = validateReleaseManifest(snapshot.manifest);
	const audit = exact(
		snapshot.audit,
		[
			"environment",
			"authorizationId",
			"authorizationArtifactSha256",
			"authorizationProofRunId",
			"releaseEvidenceHash",
			"sourceRepository",
			"commit",
			"releaseDigest",
			"manifest",
			"composeHash",
		],
		code,
	);
	if (
		snapshot.schemaVersion !== 1 ||
		snapshot.releaseDigest !== manifest.releaseDigest ||
		(snapshot.compatibility !== "expand-compatible" &&
			snapshot.compatibility !== "contract-maintenance") ||
		snapshot.compatibility !== manifest.database.compatibility ||
		typeof snapshot.compose !== "string" ||
		snapshot.composeHash !== hash(snapshot.compose) ||
		!equal(audit.manifest, manifest) ||
		audit.releaseDigest !== manifest.releaseDigest ||
		audit.composeHash !== snapshot.composeHash ||
		(expectedEnvironment !== undefined &&
			audit.environment !== expectedEnvironment) ||
		environment(audit.environment) !== audit.environment ||
		typeof audit.authorizationArtifactSha256 !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(audit.authorizationArtifactSha256) ||
		typeof audit.authorizationProofRunId !== "number" ||
		!Number.isSafeInteger(audit.authorizationProofRunId) ||
		audit.authorizationProofRunId < 1 ||
		typeof audit.releaseEvidenceHash !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(audit.releaseEvidenceHash) ||
		typeof audit.sourceRepository !== "string" ||
		!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(
			audit.sourceRepository,
		) ||
		typeof audit.authorizationId !== "string" ||
		audit.authorizationId.length < 1 ||
		audit.commit !== manifest.commit
	)
		throw new Error(code);
	return {
		...snapshot,
		manifest,
		imageReferences: validateSnapshotImages(
			snapshot.imageReferences,
			manifest,
			snapshot.compose as string,
			code,
		),
		audit: audit as ReleaseSnapshot["audit"],
	} as ReleaseSnapshot;
}
function restore(
	adapter: DeploymentAdapter,
	state: StateEnvelope | undefined,
	compose: string | undefined,
) {
	adapter.writeStateAtomic(state);
	adapter.stageComposeAtomic(compose);
}

/** Validates data supplied by an external GitHub artifact verifier; deployctl makes no GitHub call. */
export function planDeployment(value: unknown): DeploymentPlan {
	const input = exact(
		value,
		[
			"authorization",
			"authorizationProof",
			"manifest",
			"evidence",
			"sbom",
			"provenance",
			"environment",
			"composeImages",
			"gates",
		],
		"deploy.input_invalid",
	);
	const target = environment(input.environment),
		authorization = validateFinalPromotionAuthorization(input.authorization),
		manifest = validateReleaseManifest(input.manifest);
	if (
		authorization.target !== target ||
		authorization.releaseDigest !== manifest.releaseDigest ||
		authorization.artifactKind !== manifest.artifactKind
	)
		throw new Error("deploy.authorization_binding_invalid");
	validateAuthorizationRelations(authorization, target);
	const proof = validateAuthorizationProof(
		input.authorizationProof,
		authorization,
		target,
	);
	const evidence = validateEvidence(input.evidence, manifest, authorization);
	if (
		authorization.sourceRepository !== evidence.sourceRepository ||
		!Object.values(manifest.images).every((reference) =>
			immutableAtRepository(reference, String(evidence.imageRepository)),
		)
	)
		throw new Error("deploy.authorization_binding_invalid");
	validateProofs(input, evidence, manifest);
	validateGates(input.gates, manifest);
	const composeImages = exact(
		input.composeImages,
		["postgres", "cloudflared"],
		"deploy.compose_images_invalid",
	) as { postgres: string; cloudflared: string };
	const app =
		manifest.artifactKind === "universal-image"
			? manifest.images.web
			: (manifest.images as ImageMap);
	const compose = renderCompose({
		environment: target,
		images: { app, ...composeImages },
		...(manifest.artifactKind === "release-set"
			? { releaseManifest: manifest, releaseIdentity: manifest.releaseDigest }
			: {}),
		...(target === "staging"
			? {
					capacity: {
						clearance: true,
						windowApproved: true,
						migrationActive: false,
						restoreActive: false,
						maintenanceActive: false,
						backlogActive: false,
						buildOrTestActive: false,
					},
				}
			: {}),
	});
	if (
		composeImages.postgres !== postgresImage ||
		!immutableCloudflared(composeImages.cloudflared)
	)
		throw new Error("deploy.compose_images_invalid");
	const composeHash = hash(compose),
		imageReferences = [
			...new Set([
				...Object.values(manifest.images),
				composeImages.postgres,
				composeImages.cloudflared,
			]),
		].sort();
	const plan: DeploymentPlan = {
		environment: target,
		manifest,
		compose,
		composeHash,
		imageReferences,
		snapshot: {
			schemaVersion: 1,
			releaseDigest: manifest.releaseDigest,
			compatibility: manifest.database.compatibility,
			compose,
			composeHash,
			manifest,
			imageReferences,
			audit: {
				environment: target,
				authorizationId: authorization.authorizationId,
				authorizationArtifactSha256: proof.artifactSha256,
				authorizationProofRunId: proof.workflowRunId,
				releaseEvidenceHash: authorization.releaseEvidence.hash,
				sourceRepository: authorization.sourceRepository,
				commit: manifest.commit,
				releaseDigest: manifest.releaseDigest,
				manifest,
				composeHash,
			},
		},
	};
	return sealPlan(plan);
}
/** Stages Compose, then verifies persisted bytes after all pulls before atomically switching the state envelope. */
export async function applyDeployment(
	plan: DeploymentPlan,
	adapter: DeploymentAdapter,
) {
	assertCanonicalPlan(plan);
	const beforeState = adapter.readState(),
		beforeCompose = adapter.readCompose(),
		prior = parseState(beforeState, plan.environment);
	if (
		(plan.manifest.database.previousReleaseDigest === genesisDigest &&
			prior.current) ||
		(plan.manifest.database.previousReleaseDigest !== genesisDigest &&
			prior.current?.releaseDigest !==
				plan.manifest.database.previousReleaseDigest)
	)
		throw new Error("deploy.current_identity_invalid");
	adapter.stageComposeAtomic(plan.compose);
	try {
		for (const reference of plan.imageReferences) {
			await adapter.pull(reference);
			const inspected = await adapter.inspect(reference);
			if (
				inspected.reference !== reference ||
				inspected.platform !== "linux/amd64"
			)
				throw new Error("deploy.image_inspection_invalid");
		}
		if (
			adapter.readCompose() === undefined ||
			hash(adapter.readCompose()!) !== plan.composeHash
		)
			throw new Error("deploy.compose_hash_invalid");
		adapter.writeStateAtomic(
			stateEnvelope({
				current: plan.snapshot,
				...(prior.current ? { previous: prior.current } : {}),
			}),
		);
		try {
			await adapter.converge(adapter.readCompose()!);
		} catch (error) {
			restore(adapter, beforeState, beforeCompose);
			if (prior.current)
				await adapter.converge(prior.current.compose).catch(() => undefined);
			throw error;
		}
	} catch (error) {
		if (
			adapter.readState() !== beforeState ||
			adapter.readCompose() !== beforeCompose
		)
			restore(adapter, beforeState, beforeCompose);
		throw error;
	}
}
/** Rolls back only an image-compatible historical snapshot; it never performs a data rollback. */
export async function rollbackDeployment(
	plan: DeploymentPlan,
	adapter: DeploymentAdapter,
) {
	assertCanonicalPlan(plan);
	const beforeState = adapter.readState(),
		beforeCompose = adapter.readCompose(),
		state = parseState(beforeState, plan.environment),
		current = state.current,
		previous = state.previous;
	if (
		!current ||
		!previous ||
		!equal(current, plan.snapshot) ||
		current.compatibility !== "expand-compatible" ||
		current.manifest.database.previousReleaseDigest !== previous.releaseDigest
	)
		throw new Error("deploy.rollback_invalid");
	adapter.stageComposeAtomic(previous.compose);
	try {
		for (const reference of previous.imageReferences) {
			await adapter.pull(reference);
			const inspected = await adapter.inspect(reference);
			if (
				inspected.reference !== reference ||
				inspected.platform !== "linux/amd64"
			)
				throw new Error("deploy.image_inspection_invalid");
		}
		if (
			adapter.readCompose() === undefined ||
			hash(adapter.readCompose()!) !== previous.composeHash
		)
			throw new Error("deploy.compose_hash_invalid");
		adapter.writeStateAtomic(
			stateEnvelope({ current: previous, previous: current }),
		);
		try {
			await adapter.converge(adapter.readCompose()!);
		} catch (error) {
			restore(adapter, beforeState, beforeCompose);
			await adapter.converge(current.compose).catch(() => undefined);
			throw error;
		}
	} catch (error) {
		if (
			adapter.readState() !== beforeState ||
			adapter.readCompose() !== beforeCompose
		)
			restore(adapter, beforeState, beforeCompose);
		throw error;
	}
}
/** A testable local implementation using temp-file plus rename; it has no shell, host, network, or credential capability. */
export function createFilesystemDeploymentAdapter(
	root: string,
	runtime: DeploymentRuntime,
): DeploymentAdapter {
	const statePath = join(root, "state.json"),
		composePath = join(root, "compose.yml");
	const atomic = (path: string, value: string | undefined) => {
		if (value === undefined) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, value, { mode: 0o600 });
		renameSync(temporary, path);
	};
	return {
		...runtime,
		readState: () => {
			if (!existsSync(statePath)) return undefined;
			const bytes = readFileSync(statePath, "utf8");
			if (!bytes) return undefined;
			try {
				return JSON.parse(bytes) as StateEnvelope;
			} catch {
				throw new Error("deploy.state_invalid");
			}
		},
		writeStateAtomic: (state) =>
			atomic(
				statePath,
				state === undefined ? undefined : JSON.stringify(state),
			),
		readCompose: () =>
			existsSync(composePath)
				? readFileSync(composePath, "utf8") || undefined
				: undefined,
		stageComposeAtomic: (compose) => atomic(composePath, compose),
	};
}

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
type HostOperation =
	| "plan"
	| "apply"
	| "bootstrap"
	| "status"
	| "smoke"
	| "rollback";
export type HostCommand = {
	operation: HostOperation;
	environment: Environment;
	commit: string;
	digest: string;
};

/** Parses only the direct-source operator grammar; it never accepts paths, JSON, or flags through. */
export function parseHostCommand(argv: readonly string[]): HostCommand {
	const [operation, target, commitFlag, commit, digestFlag, digest, ...rest] =
		argv;
	if (
		rest.length ||
		!["plan", "apply", "bootstrap", "status", "smoke", "rollback"].includes(
			String(operation),
		) ||
		(target !== "staging" && target !== "production") ||
		commitFlag !== "--commit" ||
		typeof commit !== "string" ||
		!/^[a-f0-9]{40}$/.test(commit) ||
		digestFlag !== "--digest" ||
		typeof digest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(digest)
	)
		throw new Error("deploy.command_invalid");
	return {
		operation: operation as HostOperation,
		environment: target,
		commit,
		digest,
	};
}

function releaseRoot(environment: Environment) {
	return `/srv/agendia/${environment}/release`;
}
function matchesCommandPlan(command: HostCommand, plan: DeploymentPlan) {
	return (
		plan.environment === command.environment &&
		plan.snapshot.audit.commit === command.commit &&
		plan.snapshot.releaseDigest === command.digest
	);
}
function approvedPlan(command: HostCommand): DeploymentPlan {
	const path = join(
		releaseRoot(command.environment),
		"inputs",
		"approved-plan.json",
	);
	const info = statSync(path);
	if (info.uid !== 0 || (info.mode & 0o022) !== 0)
		throw new Error("deploy.approved_input_invalid");
	try {
		const plan = planDeployment(JSON.parse(readFileSync(path, "utf8")));
		if (!matchesCommandPlan(command, plan))
			throw new Error("deploy.approved_input_invalid");
		return plan;
	} catch {
		throw new Error("deploy.approved_input_invalid");
	}
}

/** Executes only a sealed plan stored in the fixed root-owned release-input location. */
export async function runApprovedHostCommand(
	command: HostCommand,
	plan: DeploymentPlan,
	adapter: DeploymentAdapter,
): Promise<void> {
	if (!matchesCommandPlan(command, plan))
		throw new Error("deploy.approved_input_invalid");
	if (command.operation === "plan") return;
	if (command.operation === "status") {
		assertCanonicalPlan(plan);
		const state = parseState(adapter.readState(), command.environment).current;
		if (
			state &&
			(!equal(state, plan.snapshot) ||
				hash(adapter.readCompose() ?? "") !== state.composeHash)
		)
			throw new Error("deploy.status_invalid");
		return;
	}
	if (command.operation === "apply" || command.operation === "bootstrap")
		return applyDeployment(plan, adapter, command.operation === "bootstrap");
	if (command.operation === "rollback")
		return rollbackDeployment(plan, adapter);
	throw new Error("deploy.operation_unavailable");
}

/** Preflights the actual executing checkout before dispatching its fixed approved input. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const command = parseHostCommand(argv),
		root = dirname(import.meta.dir);
	const { createHostRuntime, hostSourcePreflight } = await import(
		"./host-deployment-runtime.ts"
	);
	hostSourcePreflight(root, command.commit);
	const release = releaseRoot(command.environment);
	await runApprovedHostCommand(
		command,
		approvedPlan(command),
		createFilesystemDeploymentAdapter(
			release,
			createHostRuntime({ environment: command.environment, root: release }),
		),
	);
}
if (import.meta.main)
	main().catch(() => {
		console.error("deploy.command_failed");
		process.exitCode = 1;
	});

interface StateEnvelope {
	schemaVersion: 1;
	current: ReleaseSnapshot | null;
	previous: ReleaseSnapshot | null;
}

export interface DeploymentRuntime {
	pull(reference: string): Promise<void>;
	inspect(reference: string): Promise<{ reference: string; platform: string }>;
	converge(compose: string): Promise<void>;
	runOrdered?(bootstrapRequired: boolean): Promise<void>;
}
/** Bounded local adapter: state is one envelope and Compose is an independently staged byte file. */
export interface DeploymentAdapter extends DeploymentRuntime {
	readState(): StateEnvelope | undefined;
	writeStateAtomic(state: StateEnvelope | undefined): void;
	readCompose(): string | undefined;
	stageComposeAtomic(compose: string | undefined): void;
	readEvidence?(): string | undefined;
	writeEvidenceAtomic?(evidence: string | undefined): void;
	withLock?<T>(operation: () => Promise<T>): Promise<T>;
}
export type AtomicStep = "temp-open" | "file-sync" | "rename" | "parent-sync";
export type PersistenceHooks = {
	beforeAtomicStep?(step: AtomicStep): void;
};
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
function operationEvidence(
	plan: DeploymentPlan,
	phase: "apply" | "rollback",
	result: "started" | "pass" | "fail",
	snapshot = plan.snapshot,
) {
	return JSON.stringify({
		schemaVersion: 1,
		environment: plan.environment,
		toolingCommit: plan.snapshot.audit.commit,
		bunVersion: "1.4.0",
		releaseDigest: snapshot.releaseDigest,
		phase,
		result,
		occurredAt: new Date().toISOString(),
		sqlRollback: false,
		externalRestore: false,
	});
}
function operationFailure(
	adapter: DeploymentAdapter,
	plan: DeploymentPlan,
	phase: "apply" | "rollback",
	snapshot = plan.snapshot,
) {
	try {
		adapter.writeEvidenceAtomic?.(
			operationEvidence(plan, phase, "fail", snapshot),
		);
		return true;
	} catch {
		return false;
	}
}
async function underLock<T>(
	adapter: DeploymentAdapter,
	operation: () => Promise<T>,
) {
	return adapter.withLock ? adapter.withLock(operation) : operation();
}
async function convergeSnapshot(
	adapter: DeploymentAdapter,
	snapshot: ReleaseSnapshot,
	bootstrapRequired = false,
	ordered = false,
) {
	for (const reference of snapshot.imageReferences) {
		await adapter.pull(reference);
		const inspected = await adapter.inspect(reference);
		if (
			inspected.reference !== reference ||
			inspected.platform !== "linux/amd64"
		)
			throw new Error("deploy.image_inspection_invalid");
	}
	const compose = adapter.readCompose();
	if (compose === undefined || hash(compose) !== snapshot.composeHash)
		throw new Error("deploy.compose_hash_invalid");
	if (ordered) {
		if (!adapter.runOrdered) throw new Error("deploy.ordered_runtime_required");
		await adapter.runOrdered(bootstrapRequired);
	} else await adapter.converge(compose);
}

/** Acquires an exclusive release-directory lock; callers never wait behind another environment operation. */
export async function withEnvironmentLock<T>(
	root: string,
	operation: () => Promise<T>,
): Promise<T> {
	const lock = join(root, ".deploy.lock");
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch {
		throw new Error("deploy.operation_locked");
	}
	try {
		return await operation();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
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
/** Publishes state only after convergence; a started effect is never automatically reconverged or rolled back. */
export async function applyDeployment(
	plan: DeploymentPlan,
	adapter: DeploymentAdapter,
	bootstrapRequired = false,
) {
	assertCanonicalPlan(plan);
	if (!adapter.runOrdered) throw new Error("deploy.ordered_runtime_required");
	return underLock(adapter, async () => {
		const prior = parseState(adapter.readState(), plan.environment);
		if (
			(plan.manifest.database.previousReleaseDigest === genesisDigest &&
				prior.current) ||
			(plan.manifest.database.previousReleaseDigest !== genesisDigest &&
				prior.current?.releaseDigest !==
					plan.manifest.database.previousReleaseDigest)
		)
			throw new Error("deploy.current_identity_invalid");
		adapter.stageComposeAtomic(plan.compose);
		adapter.writeEvidenceAtomic?.(operationEvidence(plan, "apply", "started"));
		try {
			await convergeSnapshot(adapter, plan.snapshot, bootstrapRequired, true);
		} catch {
			if (!operationFailure(adapter, plan, "apply"))
				throw new Error("deploy.persistence_unknown");
			throw new Error("deploy.operation_failed");
		}
		try {
			adapter.writeStateAtomic(
				stateEnvelope({
					current: plan.snapshot,
					...(prior.current ? { previous: prior.current } : {}),
				}),
			);
			adapter.writeEvidenceAtomic?.(operationEvidence(plan, "apply", "pass"));
		} catch {
			operationFailure(adapter, plan, "apply");
			throw new Error("deploy.persistence_unknown");
		}
	});
}
/** Rolls back only image and Compose from an expand-compatible snapshot; it never invokes SQL or one-shots. */
export async function rollbackDeployment(
	plan: DeploymentPlan,
	adapter: DeploymentAdapter,
) {
	assertCanonicalPlan(plan);
	return underLock(adapter, async () => {
		const state = parseState(adapter.readState(), plan.environment),
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
		adapter.writeEvidenceAtomic?.(
			operationEvidence(plan, "rollback", "started", previous),
		);
		try {
			await convergeSnapshot(adapter, previous);
		} catch {
			if (!operationFailure(adapter, plan, "rollback", previous))
				throw new Error("deploy.persistence_unknown");
			throw new Error("deploy.operation_failed");
		}
		try {
			adapter.writeStateAtomic(
				stateEnvelope({ current: previous, previous: current }),
			);
			adapter.writeEvidenceAtomic?.(
				operationEvidence(plan, "rollback", "pass", previous),
			);
		} catch {
			operationFailure(adapter, plan, "rollback", previous);
			throw new Error("deploy.persistence_unknown");
		}
	});
}
/** A testable local store with exclusive temp files, file sync, rename, and parent-directory sync. */
export function createFilesystemDeploymentAdapter(
	root: string,
	runtime: DeploymentRuntime,
	hooks: PersistenceHooks = {},
): DeploymentAdapter {
	const statePath = join(root, "state.json"),
		composePath = join(root, "compose.yml"),
		evidencePath = join(root, "evidence.json");
	const atomic = (path: string, value: string | undefined) => {
		if (value === undefined) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		const temporary = `${path}.${randomUUID()}.tmp`;
		let descriptor: number | undefined,
			renamed = false;
		try {
			hooks.beforeAtomicStep?.("temp-open");
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, value);
			hooks.beforeAtomicStep?.("file-sync");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			hooks.beforeAtomicStep?.("rename");
			renameSync(temporary, path);
			renamed = true;
			hooks.beforeAtomicStep?.("parent-sync");
			const parent = openSync(dirname(path), "r");
			try {
				fsyncSync(parent);
			} finally {
				closeSync(parent);
			}
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if (!renamed && existsSync(temporary)) unlinkSync(temporary);
			if (renamed) throw new Error("deploy.persistence_unknown");
			throw error;
		}
	};
	return {
		...runtime,
		withLock: (operation) => withEnvironmentLock(root, operation),
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
		readEvidence: () =>
			existsSync(evidencePath)
				? readFileSync(evidencePath, "utf8") || undefined
				: undefined,
		writeEvidenceAtomic: (evidence) => atomic(evidencePath, evidence),
	};
}

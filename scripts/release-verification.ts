import {
	validateReleaseManifest,
	type ReleaseManifest,
} from "@agendia/release-manifest";
export const requiredReleaseChecks = [
	"quality",
	"unit",
	"postgres",
	"browser",
	"aggregate-contract",
	"source-build",
] as const;
type Check = { name: string; status: string; conclusion: string };
type PullRequest = {
	number: number;
	merged: boolean;
	mergeCommit: string;
	mergeMethod: string;
};
export type ReleaseCandidate = {
	commit: string;
	ciConclusion: string;
	pullRequests: PullRequest[];
	checks: Check[];
	manifest: ReleaseManifest | unknown;
};
type Finding = { id: string; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" };
type HighException = {
	id: string;
	owner: string;
	reason: string;
	expiresAt: string;
	version: 1;
};
type ExceptionRegistry = { schemaVersion: 1; exceptions: HighException[] };
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const requiredExceptionKeys = "expiresAt,id,owner,reason,version";
export function verifyReleaseCandidate(candidate: ReleaseCandidate) {
	if (!sha.test(candidate.commit)) throw new Error("release.commit_invalid");
	if (candidate.ciConclusion !== "success")
		throw new Error("release.ci_not_successful");
	if (
		!candidate.pullRequests.some(
			(pr) =>
				pr.merged &&
				pr.mergeMethod === "squash" &&
				pr.mergeCommit === candidate.commit,
		)
	)
		throw new Error("release.merged_squash_pr_missing");
	for (const name of requiredReleaseChecks) {
		const matches = candidate.checks.filter((entry) => entry.name === name);
		if (
			matches.length !== 1 ||
			matches[0]?.status !== "completed" ||
			matches[0].conclusion !== "success"
		)
			throw new Error(`release.required_check_invalid:${name}`);
	}
	const manifest = validateReleaseManifest(candidate.manifest);
	if (manifest.commit !== candidate.commit)
		throw new Error("release.manifest_commit_mismatch");
	return { commit: candidate.commit, manifest };
}
function parseRegistry(value: unknown, now: Date): ExceptionRegistry {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("scan.exception_registry_invalid");
	const root = value as Record<string, unknown>;
	if (
		Object.keys(root).sort().join(",") !== "exceptions,schemaVersion" ||
		root.schemaVersion !== 1 ||
		!Array.isArray(root.exceptions)
	)
		throw new Error("scan.exception_registry_invalid");
	const ids = new Set<string>();
	for (const entry of root.exceptions) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error("scan.exception_registry_invalid");
		const exception = entry as Record<string, unknown>;
		if (
			Object.keys(exception).sort().join(",") !== requiredExceptionKeys ||
			exception.version !== 1 ||
			typeof exception.id !== "string" ||
			typeof exception.owner !== "string" ||
			typeof exception.reason !== "string" ||
			typeof exception.expiresAt !== "string" ||
			!exception.id.trim() ||
			exception.owner.trim() !== exception.owner ||
			!exception.owner ||
			exception.reason.trim() !== exception.reason ||
			!exception.reason ||
			!rfc3339.test(exception.expiresAt) ||
			Number.isNaN(Date.parse(exception.expiresAt)) ||
			Date.parse(exception.expiresAt) <= now.getTime() ||
			ids.has(exception.id)
		)
			throw new Error("scan.exception_registry_invalid");
		ids.add(exception.id);
	}
	return root as ExceptionRegistry;
}
function parseTrivyReport(value: unknown): Finding[] {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("scan.report_invalid");
	const results = (value as Record<string, unknown>).Results;
	if (!Array.isArray(results)) throw new Error("scan.report_invalid");
	return results.flatMap((result) => {
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new Error("scan.report_invalid");
		const vulnerabilities = (result as Record<string, unknown>).Vulnerabilities;
		if (vulnerabilities === undefined) return [];
		if (!Array.isArray(vulnerabilities)) throw new Error("scan.report_invalid");
		return vulnerabilities.map((vulnerability) => {
			if (
				!vulnerability ||
				typeof vulnerability !== "object" ||
				Array.isArray(vulnerability)
			)
				throw new Error("scan.report_invalid");
			const value = vulnerability as Record<string, unknown>;
			if (
				typeof value.VulnerabilityID !== "string" ||
				!value.VulnerabilityID.trim() ||
				typeof value.Severity !== "string" ||
				!(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).includes(
					value.Severity as Finding["severity"],
				)
			)
				throw new Error("scan.report_invalid");
			return {
				id: value.VulnerabilityID,
				severity: value.Severity as Finding["severity"],
			};
		});
	});
}
export function verifyScanPolicy(
	report: unknown,
	registry: unknown,
	now = new Date(),
) {
	const exceptions = parseRegistry(registry, now).exceptions;
	const highExceptions: string[] = [];
	for (const finding of parseTrivyReport(report)) {
		if (finding.severity === "CRITICAL")
			throw new Error(`scan.critical:${finding.id}`);
		if (finding.severity !== "HIGH") continue;
		if (!exceptions.some((entry) => entry.id === finding.id))
			throw new Error(`scan.high_unapproved:${finding.id}`);
		highExceptions.push(finding.id);
	}
	return { highExceptions };
}
export function normalizeGhcrRepository(value: string): string {
	const normalized = value.toLowerCase();
	if (normalized !== value || !/^ghcr\.io\/[a-z0-9._-]+\/agendia$/.test(value))
		throw new Error("release.repository_invalid");
	return value;
}
export function parseDockerPushDigest(
	output: string,
	pushedReference: string,
): string {
	const tag = pushedReference.match(
		/^(ghcr\.io\/[a-z0-9._-]+\/agendia):([a-f0-9]{40})$/,
	);
	if (!tag?.[1] || !tag[2]) throw new Error("release.push_digest_invalid");
	const repository = normalizeGhcrRepository(tag[1]);
	const prefix = `${pushedReference}: digest: `;
	const parseSummary = (line: string) => {
		if (!line.startsWith(prefix)) return undefined;
		return line
			.slice(prefix.length)
			.match(/^(sha256:[a-f0-9]{64}) size: ([0-9]+)$/)?.[1];
	};
	const lines = output.split(/\r?\n/).filter(Boolean);
	const matches = lines.map(parseSummary).filter(Boolean);
	if (
		matches.length !== 1 ||
		!matches[0] ||
		parseSummary(lines.at(-1) ?? "") !== matches[0]
	)
		throw new Error("release.push_digest_invalid");
	return `${repository}@${matches[0]}`;
}
const genesisDigest = `sha256:${"0".repeat(64)}`;
const genesisMeaning =
	"The zero digest is a genesis sentinel for the first release and is not observed deployment history.";
const databaseKeys =
	"compatibility,minimumLedger,previousReleaseDigest,previousReleaseDigestMeaning,schemaVersion";
const commands = {
	web: ["bun", "/opt/agendia/web/server.js"],
	api: ["bun", "/opt/agendia/api/index.js"],
	"whatsapp-manager": ["bun", "/opt/agendia/whatsapp-manager/index.js"],
	"message-worker": ["bun", "/opt/agendia/message-worker/index.js"],
} as const;
function validateDatabase(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("release.database_contract_invalid");
	const database = value as Record<string, unknown>;
	if (
		Object.keys(database).sort().join(",") !== databaseKeys ||
		database.schemaVersion !== 1 ||
		(database.compatibility !== "expand-compatible" &&
			database.compatibility !== "contract-maintenance") ||
		typeof database.minimumLedger !== "string" ||
		!database.minimumLedger ||
		!digest.test(String(database.previousReleaseDigest)) ||
		(database.previousReleaseDigest === genesisDigest &&
			database.previousReleaseDigestMeaning !== genesisMeaning) ||
		(database.previousReleaseDigest !== genesisDigest &&
			database.previousReleaseDigestMeaning !== "")
	)
		throw new Error("release.database_contract_invalid");
	return {
		schemaVersion: 1 as const,
		compatibility: database.compatibility,
		previousReleaseDigest: database.previousReleaseDigest,
		minimumLedger: database.minimumLedger,
		previousReleaseDigestMeaning: database.previousReleaseDigestMeaning,
	};
}
export function validatePackagingDecision(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("release.packaging_decision_invalid");
	const decision = value as Record<string, unknown>;
	if (
		decision.schemaVersion !== 1 ||
		decision.outcome !== "universal-image" ||
		decision.platform !== "linux/amd64"
	)
		throw new Error("release.packaging_decision_invalid");
	return decision;
}
export function createUniversalReleaseManifest(input: {
	packagingDecision: unknown;
	database: unknown;
	commit: string;
	repository: string;
	releaseDigest: string;
}) {
	validatePackagingDecision(input.packagingDecision);
	const repository = normalizeGhcrRepository(input.repository),
		database = validateDatabase(input.database);
	if (!sha.test(input.commit) || !digest.test(input.releaseDigest))
		throw new Error("release.manifest_identity_invalid");
	const image = `${repository}@${input.releaseDigest}`;
	return validateReleaseManifest({
		schemaVersion: 1,
		artifactKind: "universal-image",
		commit: input.commit,
		releaseDigest: input.releaseDigest,
		platform: "linux/amd64",
		images: {
			web: image,
			api: image,
			"whatsapp-manager": image,
			"message-worker": image,
		},
		database: {
			compatibility: database.compatibility,
			previousReleaseDigest: database.previousReleaseDigest,
			minimumLedger: database.minimumLedger,
		},
	});
}
function validateCommands(value: unknown) {
	if (JSON.stringify(value) !== JSON.stringify(commands))
		throw new Error("release.generated_commands_invalid");
	return commands;
}
export function createReleaseEvidence(input: {
	candidate: ReleaseCandidate;
	sourceRepository: string;
	imageRepository: string;
	workflowRunId: number;
	mergedPullRequest: number;
	actor: string;
	timestamp: string;
	checks: Check[];
	database: unknown;
	generatedCommands: unknown;
	sbom: { path: string; format: "spdx-json"; digest: string };
	sbomAttestation: { id: string; url: string };
	provenanceAttestation: { id: string; url: string };
}) {
	const { commit, manifest } = verifyReleaseCandidate(input.candidate);
	const sourceRepository = input.sourceRepository.toLowerCase();
	if (
		!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(sourceRepository) ||
		input.imageRepository !== `ghcr.io/${sourceRepository}` ||
		!Number.isSafeInteger(input.workflowRunId) ||
		input.workflowRunId < 1
	)
		throw new Error("release.evidence_identity_invalid");
	const merged = input.candidate.pullRequests.find(
		(pr) =>
			pr.merged && pr.mergeMethod === "squash" && pr.mergeCommit === commit,
	);
	if (
		!merged ||
		input.mergedPullRequest !== merged.number ||
		JSON.stringify(input.checks) !== JSON.stringify(input.candidate.checks) ||
		!input.actor.trim() ||
		!rfc3339.test(input.timestamp) ||
		Number.isNaN(Date.parse(input.timestamp))
	)
		throw new Error("release.evidence_identity_invalid");
	const database = validateDatabase(input.database);
	if (
		database.compatibility !== manifest.database.compatibility ||
		database.minimumLedger !== manifest.database.minimumLedger ||
		database.previousReleaseDigest !==
			manifest.database.previousReleaseDigest ||
		!input.sbom.path ||
		input.sbom.format !== "spdx-json" ||
		!digest.test(input.sbom.digest) ||
		!input.sbomAttestation.id ||
		!input.sbomAttestation.url ||
		!input.provenanceAttestation.id ||
		!input.provenanceAttestation.url
	)
		throw new Error("release.evidence_identity_invalid");
	return {
		schemaVersion: 1,
		sourceRepository,
		imageRepository: normalizeGhcrRepository(input.imageRepository),
		workflowRunId: input.workflowRunId,
		mergedPullRequest: merged.number,
		actor: input.actor,
		timestamp: input.timestamp,
		commit,
		checks: input.checks,
		artifactKind: manifest.artifactKind,
		platform: manifest.platform,
		releaseDigest: manifest.releaseDigest,
		images: manifest.images,
		database,
		generatedCommands: validateCommands(input.generatedCommands),
		sbom: input.sbom,
		sbomAttestation: input.sbomAttestation,
		provenanceAttestation: input.provenanceAttestation,
		manifest,
	};
}

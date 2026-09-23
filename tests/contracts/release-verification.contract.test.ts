import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const fixture = (name: string) =>
	JSON.parse(read(`tests/fixtures/release-verification/${name}.json`));

const loadVerifier = () => import("../../scripts/release-verification.ts");

describe("CI and immutable release verification", () => {
	test("declares the least-privilege CI and exact-SHA release gates", () => {
		const ci = read(".github/workflows/ci.yml");
		const release = read(".github/workflows/release.yml");
		const lock = read("deploy/images.lock");
		expect(lock).toMatch(
			/POSTGRES_IMAGE=postgres@sha256:075f7ba66bc9b3ce7d6b8b635208ff61cd7cf1a67d71ec530eec5d7ae0cbe571/,
		);
		expect(lock).toContain(
			"cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
		);
		expect(ci).toContain("pull_request:");
		expect(ci).toContain("schedule:");
		expect(ci).toMatch(/permissions:\s*\n\s*contents: read/);
		for (const job of [
			"quality",
			"unit",
			"postgres",
			"browser",
			"aggregate-contract",
			"source-build",
		])
			expect(ci).toMatch(new RegExp(`^  ${job}:`, "m"));
		expect(release).toContain("workflow_run:");
		expect(release).toContain("github.event.workflow_run.id");
		expect(release).toContain("actions.listJobsForWorkflowRun");
		expect(release).toContain("github.paginate");
		expect(release).toContain("run_attempt == 1");
		expect(release).toContain("allow_squash_merge");
		expect(release).toContain("release-context.json");
		expect(release.indexOf("uses: actions/checkout")).toBeLessThan(
			release.indexOf('fs.writeFileSync("release-context.json"'),
		);
		expect(release).toContain("workflow_run.actor.login");
		expect(release).toContain("imagetools inspect");
		expect(release).toContain("format: spdx-json");
		expect(release).toContain("output-file: sbom.spdx.json");
		expect(release).toContain("AGENDIA_RELEASE_IMAGE");
		expect(release).toContain(
			"actions/attest-sbom@bd218ad0dbcb3e146bd073d1d9c6d78e08aa8a0b # v2",
		);
		expect(release).toContain("docker push");
		expect(release).not.toContain("RepoDigests");
		expect(release).toContain("github.event.workflow_run.head_sha");
		expect(release).toContain("linux/amd64");
		expect(release).toContain("attestations: write");
		expect(release).toContain("id-token: write");
		expect(release).not.toMatch(
			/\bssh\b|HOST_(?:KEY|PASSWORD)|DEPLOY_(?:KEY|TOKEN)/i,
		);
	});

	test("rejects missing quality gates, mutable identity, failed exact-SHA checks, and unmerged candidates", async () => {
		const { verifyReleaseCandidate } = await loadVerifier();
		for (const name of [
			"missing-lint",
			"tag-only",
			"failed-check",
			"unmerged-pr",
		])
			expect(() => verifyReleaseCandidate(fixture(name))).toThrow();
	});

	test("parses exactly one Docker push summary for the exact immutable candidate tag", async () => {
		const { parseDockerPushDigest } = await loadVerifier();
		const repository = "ghcr.io/agendia/agendia";
		const tag = `${repository}:${"a".repeat(40)}`;
		const digest = `sha256:${"b".repeat(64)}`;
		expect(
			parseDockerPushDigest(`${tag}: digest: ${digest} size: 1234\n`, tag),
		).toBe(`${repository}@${digest}`);
		for (const [candidate, output] of [
			[tag, `${repository}:${"c".repeat(40)}: digest: ${digest} size: 1\n`],
			[
				`ghcrXio/agendia/agendia:${"a".repeat(40)}`,
				`ghcrXio/agendia/agendia:${"a".repeat(40)}: digest: ${digest} size: 1\n`,
			],
			[tag, `${tag}: digest: ${digest} size: unknown\n`],
			[tag, `${tag}: pushed\n`],
			[
				tag,
				`${tag}: digest: ${digest} size: 1\n${tag}: digest: ${digest} size: 2\n`,
			],
		] as const)
			expect(() => parseDockerPushDigest(output, candidate)).toThrow(
				"release.push_digest_invalid",
			);
	});

	test("logs only bounded sorted HIGH advisory IDs before enforcing the unchanged policy", () => {
		const release = read(".github/workflows/release.yml");
		const trivy = release.indexOf("output: trivy.json");
		const diagnostic = release.indexOf(
			"- name: Log bounded Trivy HIGH advisory IDs",
		);
		const policy = release.indexOf("- name: Enforce fail-closed Trivy policy");
		const upload = release.slice(release.indexOf("actions/upload-artifact"));

		expect(trivy).toBeGreaterThan(-1);
		expect(diagnostic).toBeGreaterThan(trivy);
		expect(policy).toBeGreaterThan(diagnostic);
		expect(release.slice(diagnostic, policy)).toContain(
			'release.trivy.high_ids=${JSON.stringify(listHighTrivyIds(await Bun.file("trivy.json").json()))}',
		);
		expect(upload).not.toContain("trivy.json");
	});

	test("lists sorted unique HIGH IDs and rejects unsafe or excessive diagnostic output", async () => {
		const { listHighTrivyIds } = await loadVerifier();
		expect(
			listHighTrivyIds({
				Results: [
					{
						Vulnerabilities: [
							{ VulnerabilityID: "CVE-2026-0002", Severity: "HIGH" },
							{ VulnerabilityID: "CVE-2026-0001", Severity: "MEDIUM" },
							{ VulnerabilityID: "CVE-2026-0001", Severity: "HIGH" },
						],
					},
					{
						Vulnerabilities: [
							{ VulnerabilityID: "CVE-2026-0003", Severity: "CRITICAL" },
							{ VulnerabilityID: "CVE-2026-0001", Severity: "HIGH" },
						],
					},
				],
			}),
		).toEqual(["CVE-2026-0001", "CVE-2026-0002"]);
		expect(listHighTrivyIds({ Results: [] })).toEqual([]);
		for (const id of [
			"CVE 2026-0001",
			"CVE-2026-0001\nnext",
			"CVE-2026-0001\n",
			"CVE-2026-0001\r\n",
			'CVE-2026-"0001',
			"A".repeat(129),
			`${"A".repeat(128)}\n`,
		])
			expect(() =>
				listHighTrivyIds({
					Results: [
						{ Vulnerabilities: [{ VulnerabilityID: id, Severity: "HIGH" }] },
					],
				}),
			).toThrow("scan.high_diagnostic_invalid");
		expect(() =>
			listHighTrivyIds({
				Results: [
					{
						Vulnerabilities: Array.from({ length: 65 }, (_, index) => ({
							VulnerabilityID: `CVE-2026-${index}`,
							Severity: "HIGH",
						})),
					},
				],
			}),
		).toThrow("scan.high_diagnostic_limit");
	});

	test("requires a current owned HIGH exception while CRITICAL and UNKNOWN findings always block", async () => {
		const { verifyScanPolicy } = await loadVerifier();
		const emptyRegistry = { schemaVersion: 1, exceptions: [] };
		expect(() =>
			verifyScanPolicy(
				fixture("critical-scan"),
				emptyRegistry,
				new Date("2026-04-01"),
			),
		).toThrow("scan.critical:CVE-2026-9999");
		expect(() =>
			verifyScanPolicy(
				{
					Results: [
						{
							Vulnerabilities: [
								{ VulnerabilityID: "CVE-2026-0002", Severity: "UNKNOWN" },
							],
						},
					],
				},
				emptyRegistry,
				new Date("2026-04-01"),
			),
		).toThrow("scan.unknown:CVE-2026-0002");
		expect(() =>
			verifyScanPolicy(
				fixture("unapproved-high"),
				emptyRegistry,
				new Date("2026-04-01"),
			),
		).toThrow("scan.high_unapproved:CVE-2026-0001");
		expect(() =>
			verifyScanPolicy(
				fixture("expired-high"),
				fixture("expired-exceptions"),
				new Date("2026-04-01"),
			),
		).toThrow();
		expect(
			verifyScanPolicy(
				fixture("approved-high"),
				fixture("approved-exceptions"),
				new Date("2026-04-01"),
			),
		).toEqual({ highExceptions: ["CVE-2026-0001"] });
	});

	test("permits only the two staging CVE exceptions until their exact expiry", async () => {
		const { verifyScanPolicy } = await loadVerifier();
		const registry = JSON.parse(read("deploy/security/high-exceptions.json"));
		const exceptions = [
			{
				id: "CVE-2026-76642",
				owner: "valerubio7",
				reason:
					"Temporary exception while Debian Trixie util-linux lacks an official fix; staging-only is an operational hold, not technically enforced by the scanner, and production promotion is not authorized.",
				expiresAt: "2026-09-29T22:32:30Z",
				version: 1,
			},
			{
				id: "CVE-2026-78408",
				owner: "valerubio7",
				reason:
					"Temporary exception while Debian Trixie util-linux lacks an official fix for nsenter --join-cgroup; it requires a privileged operator on the attacker target, staging-only is an operational hold, not technically enforced by the scanner, and production promotion is not authorized.",
				expiresAt: "2026-09-29T22:32:30Z",
				version: 1,
			},
		];
		const report = (id: string, severity: string) => ({
			Results: [
				{ Vulnerabilities: [{ VulnerabilityID: id, Severity: severity }] },
			],
		});
		const beforeExpiry = new Date("2026-09-29T22:32:29.999Z");

		expect(registry).toEqual({ schemaVersion: 1, exceptions });
		for (const exception of exceptions) {
			expect(
				verifyScanPolicy(report(exception.id, "HIGH"), registry, beforeExpiry),
			).toEqual({ highExceptions: [exception.id] });
			for (const expiredAt of [
				new Date(exception.expiresAt),
				new Date("2026-09-29T22:32:30.001Z"),
			])
				expect(() =>
					verifyScanPolicy(report(exception.id, "HIGH"), registry, expiredAt),
				).toThrow("scan.exception_registry_invalid");
		}
		expect(() =>
			verifyScanPolicy(report("CVE-2026-0001", "HIGH"), registry, beforeExpiry),
		).toThrow("scan.high_unapproved:CVE-2026-0001");
		for (const exception of exceptions)
			for (const [severity, error] of [
				["CRITICAL", `scan.critical:${exception.id}`],
				["UNKNOWN", `scan.unknown:${exception.id}`],
			] as const)
				expect(() =>
					verifyScanPolicy(
						report(exception.id, severity),
						registry,
						beforeExpiry,
					),
				).toThrow(error);
	});

	test("supports universal-image and release-set evidence without branch-selected bytes", async () => {
		const { createReleaseEvidence, verifyReleaseCandidate } =
			await loadVerifier();
		for (const name of ["universal-image", "release-set"]) {
			const candidate = fixture(name);
			expect(verifyReleaseCandidate(candidate).commit).toBe(candidate.commit);
			expect(
				createReleaseEvidence({
					candidate,
					sourceRepository: "agendia/agendia",
					imageRepository: "ghcr.io/agendia/agendia",
					workflowRunId: 1,
					mergedPullRequest: 1,
					actor: "release-bot",
					timestamp: "2026-04-01T00:00:00Z",
					checks: candidate.checks,
					database: {
						schemaVersion: 1,
						...candidate.manifest.database,
						previousReleaseDigestMeaning: "",
					},
					generatedCommands: {
						web: ["bun", "/opt/agendia/web/server.js"],
						api: ["bun", "/opt/agendia/api/index.js"],
						"whatsapp-manager": [
							"bun",
							"/opt/agendia/whatsapp-manager/index.js",
						],
						"message-worker": ["bun", "/opt/agendia/message-worker/index.js"],
					},
					sbom: {
						path: "sbom.spdx.json",
						format: "spdx-json",
						digest: `sha256:${"e".repeat(64)}`,
					},
					sbomAttestation: {
						id: "1",
						url: "https://example.test/attestations/1",
					},
					provenanceAttestation: {
						id: "2",
						url: "https://example.test/attestations/2",
					},
				}),
			).toMatchObject({
				schemaVersion: 1,
				artifactKind: candidate.manifest.artifactKind,
				commit: candidate.commit,
				releaseDigest: candidate.manifest.releaseDigest,
				platform: "linux/amd64",
				sourceRepository: "agendia/agendia",
				imageRepository: "ghcr.io/agendia/agendia",
				workflowRunId: 1,
			});
		}
	});

	test("fails closed for malformed Trivy data and every invalid exception registry entry", async () => {
		const { verifyScanPolicy } = await loadVerifier();
		expect(() =>
			verifyScanPolicy(
				{
					Results: [
						{
							Vulnerabilities: [
								{ VulnerabilityID: "CVE-1", Severity: "UNRECOGNIZED" },
							],
						},
					],
				},
				{ schemaVersion: 1, exceptions: [] },
				new Date("2026-04-01"),
			),
		).toThrow("scan.report_invalid");
		for (const [report, registry] of [
			[{ Results: {} }, { schemaVersion: 1, exceptions: [] }],
			[
				{
					Results: [
						{ Vulnerabilities: [{ VulnerabilityID: "", Severity: "HIGH" }] },
					],
				},
				{ schemaVersion: 1, exceptions: [] },
			],
			[
				fixture("approved-high"),
				{
					schemaVersion: 1,
					exceptions: [
						{
							...fixture("approved-exceptions").exceptions[0],
							expiresAt: "not-rfc3339",
						},
					],
				},
			],
			[
				fixture("approved-high"),
				{
					schemaVersion: 1,
					exceptions: [
						{ ...fixture("approved-exceptions").exceptions[0], reason: " " },
					],
				},
			],
			[
				fixture("approved-high"),
				{
					schemaVersion: 1,
					exceptions: [
						fixture("approved-exceptions").exceptions[0],
						fixture("approved-exceptions").exceptions[0],
					],
				},
			],
		])
			expect(() =>
				verifyScanPolicy(report, registry, new Date("2026-04-01")),
			).toThrow();
	});
});

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	buildHostBundle,
	bundleCompilerOutputPath,
} from "../../scripts/package-host-bundle.ts";
import { parseDeploymentCommand } from "../../scripts/deployctl-cli.ts";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const sha256 = (value: Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

function fixture(
	overrides: Partial<Parameters<typeof buildHostBundle>[0]> = {},
) {
	return {
		commit,
		releaseDigest: digest,
		platform: "linux/amd64" as const,
		compose: "name: agendia\n",
		compile: async (target: string) => {
			expect(target).toBe("bun-linux-x64-baseline");
			return Buffer.from("closed-deployctl");
		},
		...overrides,
	};
}

function tarEntries(tar: Uint8Array) {
	const entries: Array<{ path: string; mode: string; bytes: Buffer }> = [];
	for (let offset = 0; offset < tar.length && tar[offset] !== 0; ) {
		const header = tar.subarray(offset, offset + 512);
		const path = Buffer.from(header.subarray(0, 100))
			.toString()
			.replace(/\0.*$/, "");
		const mode = Buffer.from(header.subarray(100, 108))
			.toString()
			.replace(/\0.*$/, "");
		const size = Number.parseInt(
			Buffer.from(header.subarray(124, 136))
				.toString()
				.replace(/\0.*$/, "")
				.trim(),
			8,
		);
		const body = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
		entries.push({ path, mode, bytes: body });
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

describe("host bundle contract", () => {
	test("builds byte-identical closed USTAR payloads with a canonical schema-1 manifest", async () => {
		const first = await buildHostBundle(fixture());
		const second = await buildHostBundle(fixture());
		expect(first.tar.equals(second.tar)).toBe(true);
		expect(
			tarEntries(first.tar).map(({ path, mode }) => ({ path, mode })),
		).toEqual([
			{ path: "agendia-deployctl", mode: "0000555" },
			{ path: "deploy/compose.yml", mode: "0000444" },
			{ path: "manifest.json", mode: "0000444" },
		]);
		const header = first.tar.subarray(0, 512),
			storedChecksum = Number.parseInt(
				Buffer.from(header.subarray(148, 156)).toString().trim(),
				8,
			),
			checksum = (value: Uint8Array) =>
				Buffer.from(value)
					.fill(32, 148, 156)
					.reduce((sum, byte) => sum + byte, 0);
		expect(Buffer.from(header.subarray(100, 108)).toString()).toBe("0000555\0");
		expect(Buffer.from(header.subarray(108, 116)).toString()).toBe("0000000\0");
		expect(Buffer.from(header.subarray(116, 124)).toString()).toBe("0000000\0");
		expect(Buffer.from(header.subarray(136, 148)).toString()).toBe(
			"00000000000\0",
		);
		expect(String.fromCharCode(header[156] ?? 1)).toBe("0");
		expect(Buffer.from(header.subarray(257, 263)).toString()).toBe("ustar\0");
		expect(Buffer.from(header.subarray(263, 265)).toString()).toBe("00");
		expect(storedChecksum).toBe(checksum(header));
		const headerTamper = Buffer.from(first.tar);
		headerTamper[100] = 49;
		expect(storedChecksum).not.toBe(checksum(headerTamper.subarray(0, 512)));
		const payloadTamper = Buffer.from(first.tar);
		payloadTamper[512] = (payloadTamper[512] ?? 0) ^ 1;
		expect(sha256(payloadTamper.subarray(512, 528))).not.toBe(
			sha256(Buffer.from("closed-deployctl")),
		);
		const root = await mkdtemp(join(tmpdir(), "host-bundle-"));
		try {
			await writeFile(join(root, "bundle.tar"), first.tar);
			expect((await readFile(join(root, "bundle.tar"))).toString("hex")).toBe(
				first.tar.toString("hex"),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		const manifest = JSON.parse(first.manifest);
		expect(first.manifest).toBe(JSON.stringify(manifest));
		expect(manifest).toEqual({
			schemaVersion: 1,
			commit,
			files: [
				{
					mode: 0o555,
					path: "agendia-deployctl",
					sha256: sha256(Buffer.from("closed-deployctl")),
					size: 16,
				},
				{
					mode: 0o444,
					path: "deploy/compose.yml",
					sha256: sha256(Buffer.from("name: agendia\n")),
					size: 14,
				},
			],
			platform: "linux/amd64",
			releaseDigest: digest,
			stateSchemas: [1],
		});
	});

	test("rejects mutable or mismatched identities and never accepts extra payloads", async () => {
		await expect(
			buildHostBundle(fixture({ releaseDigest: "ghcr.io/agendia:latest" })),
		).rejects.toThrow("bundle.identity_invalid");
		await expect(
			buildHostBundle(fixture({ platform: "linux/arm64" as "linux/amd64" })),
		).rejects.toThrow("bundle.identity_invalid");
		await expect(
			buildHostBundle(fixture({ commit: "checkout/main" })),
		).rejects.toThrow("bundle.identity_invalid");
		await expect(
			buildHostBundle(fixture({ checkoutCommit: "c".repeat(40) } as never)),
		).rejects.toThrow("bundle.identity_invalid");
		await expect(
			buildHostBundle(fixture({ compose: "GITHUB_TOKEN=secret" })),
		).rejects.toThrow("bundle.payload_invalid");
	});

	test("compiles every clean package invocation through one stable temporary output name", () => {
		expect(bundleCompilerOutputPath()).toBe(".host-bundle-deployctl");
	});

	test("keeps the executable interface fail-closed and release publication bound to one run", async () => {
		expect(() => parseDeploymentCommand(["apply", "production"])).toThrow(
			"deployctl.disabled",
		);
		const workflow = await readFile(".github/workflows/release.yml", "utf8");
		expect(workflow).toContain("Build host bundle twice and compare bytes");
		expect(workflow).toContain(
			"Build host bundle twice and compare bytes\n        env:\n          GITHUB_SHA: ${{ github.event.workflow_run.head_sha }}",
		);
		expect(workflow).toContain("host-bundle-context.json");
		expect(workflow).toContain("scan-target: agendia-host-linux-x64.tar");
		expect(workflow).toContain("sbom-path: host-bundle.spdx.json");
		expect(workflow).toContain("image: ${{ steps.image.outputs.reference }}");
		expect(workflow).toContain("host-bundle-sbom.attestation.json");
		expect(workflow).toContain("host-bundle-attestations.SHA256SUMS");
		expect(workflow).toContain("ciWorkflowRunAttempt");
		expect(workflow).toContain("releaseWorkflowRunAttempt");
		expect(workflow).toContain("sbomAttestationSha256");
		expect(workflow).toContain("provenanceAttestationSha256");
		expect(workflow).not.toContain("GHCR_HOST_CREDENTIAL");
	});
});

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalize } from "./promotion-authorization.ts";

type Platform = "linux/amd64";
type Payload = { path: string; mode: number; bytes: Buffer };
export type HostBundle = { tar: Buffer; manifest: string };
export type BuildHostBundleInput = {
	commit: string;
	checkoutCommit?: string | undefined;
	releaseDigest: string;
	platform: Platform;
	compose: string;
	compile: (target: "bun-linux-x64-baseline") => Promise<Buffer>;
};

const block = 512;
export function bundleCompilerOutputPath() {
	return ".host-bundle-deployctl";
}
const digest = (value: Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
const octal = (value: number, size: number) =>
	`${value.toString(8).padStart(size - 1, "0")}\0`;
function header(entry: Payload) {
	const value = Buffer.alloc(block);
	value.write(entry.path, 0, "ascii");
	value.write(octal(entry.mode, 8), 100, "ascii");
	value.write(octal(0, 8), 108, "ascii");
	value.write(octal(0, 8), 116, "ascii");
	value.write(octal(entry.bytes.length, 12), 124, "ascii");
	value.write(octal(0, 12), 136, "ascii");
	value.fill(32, 148, 156);
	value.write("0", 156, "ascii");
	value.write("ustar\0", 257, "ascii");
	value.write("00", 263, "ascii");
	value.write(
		octal(
			value.reduce((sum, byte) => sum + byte, 0),
			8,
		),
		148,
		"ascii",
	);
	return value;
}
function ustar(entries: Payload[]) {
	return Buffer.concat([
		...entries.flatMap((entry) => [
			header(entry),
			entry.bytes,
			Buffer.alloc((block - (entry.bytes.length % block)) % block),
		]),
		Buffer.alloc(block * 2),
	]);
}
function identity(input: BuildHostBundleInput) {
	if (
		!/^[a-f0-9]{40}$/.test(input.commit) ||
		(input.checkoutCommit !== undefined &&
			input.checkoutCommit !== input.commit) ||
		!/^sha256:[a-f0-9]{64}$/.test(input.releaseDigest) ||
		input.platform !== "linux/amd64"
	)
		throw new Error("bundle.identity_invalid");
	if (/(?:GITHUB_TOKEN|GHCR.*(?:TOKEN|PASSWORD)|ghp_)/i.test(input.compose))
		throw new Error("bundle.payload_invalid");
}

/** Produces the closed, timestamp-free USTAR payload; callers supply the compiler seam for tests. */
export async function buildHostBundle(
	input: BuildHostBundleInput,
): Promise<HostBundle> {
	identity(input);
	const files: Payload[] = [
		{
			path: "agendia-deployctl",
			mode: 0o555,
			bytes: await input.compile("bun-linux-x64-baseline"),
		},
		{
			path: "deploy/compose.yml",
			mode: 0o444,
			bytes: Buffer.from(input.compose),
		},
	].sort((left, right) => left.path.localeCompare(right.path));
	if (files.some(({ bytes }) => !bytes.length))
		throw new Error("bundle.payload_invalid");
	const manifest = canonicalize({
		schemaVersion: 1,
		commit: input.commit,
		files: files.map(({ path, mode, bytes }) => ({
			path,
			sha256: digest(bytes),
			size: bytes.length,
			mode,
		})),
		platform: input.platform,
		releaseDigest: input.releaseDigest,
		stateSchemas: [1],
	});
	return {
		manifest,
		tar: ustar([
			...files,
			{ path: "manifest.json", mode: 0o444, bytes: Buffer.from(manifest) },
		]),
	};
}

async function main() {
	const [manifestPath, outputPath] = process.argv.slice(2);
	if (!manifestPath || !outputPath) throw new Error("bundle.usage_invalid");
	let release: { commit: string; releaseDigest: string; platform: Platform };
	try {
		release = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
	} catch {
		throw new Error("bundle.manifest_invalid");
	}
	const staging = resolve(bundleCompilerOutputPath());
	try {
		const result = await buildHostBundle({
			commit: release.commit,
			checkoutCommit: process.env.GITHUB_SHA,
			releaseDigest: release.releaseDigest,
			platform: release.platform,
			compose: await readFile(resolve("deploy/compose.yml"), "utf8"),
			compile: async (target) => {
				const child = Bun.spawn(
					[
						"bun",
						"build",
						"scripts/deployctl-cli.ts",
						"--compile",
						"--target",
						target,
						"--outfile",
						staging,
					],
					{ stdout: "inherit", stderr: "inherit" },
				);
				if ((await child.exited) !== 0)
					throw new Error("bundle.compile_failed");
				return Buffer.from(await readFile(staging));
			},
		});
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, result.tar, { mode: 0o644 });
		await writeFile(`${outputPath}.manifest.json`, result.manifest, {
			mode: 0o644,
		});
	} finally {
		await rm(staging, { force: true });
	}
}
if (import.meta.main) await main();

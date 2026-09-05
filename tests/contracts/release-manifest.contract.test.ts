import { describe, expect, test } from "bun:test";
import {
	canonicalizeReleaseManifest,
	validateReleaseEvidence,
	validateReleaseManifest,
} from "../../packages/release-manifest/src/index.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const image = (name: string, character: string) =>
	`ghcr.io/agendia/${name}@${digest(character)}`;
const images = (web: string, api = web, manager = web, worker = web) => ({
	web: image("web", web),
	api: image("api", api),
	"whatsapp-manager": image("manager", manager),
	"message-worker": image("worker", worker),
});
const universalImages = (value: string) =>
	Object.fromEntries(
		["web", "api", "whatsapp-manager", "message-worker"].map((process) => [
			process,
			image("agendia", value),
		]),
	);
const universal = {
	schemaVersion: 1,
	artifactKind: "universal-image",
	commit: "a".repeat(40),
	releaseDigest: digest("1"),
	platform: "linux/amd64",
	images: universalImages("1"),
	database: {
		compatibility: "expand-compatible",
		previousReleaseDigest: digest("2"),
		minimumLedger: "0001_initial",
	},
};
const releaseSet = {
	...universal,
	artifactKind: "release-set",
	releaseDigest: digest("9"),
	images: images("3", "4", "5", "6"),
	database: { ...universal.database, compatibility: "contract-maintenance" },
};

describe("immutable release manifest", () => {
	test("accepts either artifact kind and serializes canonically", () => {
		expect(validateReleaseManifest(universal).artifactKind).toBe(
			"universal-image",
		);
		expect(validateReleaseManifest(releaseSet).artifactKind).toBe(
			"release-set",
		);
		expect(
			canonicalizeReleaseManifest({
				...universal,
				images: { ...universal.images },
			}),
		).toBe(JSON.stringify(universal));
	});

	test("rejects tags, incompatible platforms, missing or extra processes, and mixed images", () => {
		for (const manifest of [
			{
				...universal,
				images: { ...universal.images, api: "ghcr.io/agendia/api:latest" },
			},
			{ ...universal, platform: "linux/arm64" },
			{ ...universal, images: { web: universal.images.web } },
			{
				...universal,
				images: { ...universal.images, migrate: image("migrate", "1") },
			},
			{
				...universal,
				images: { ...universal.images, api: image("agendia", "7") },
			},
		])
			expect(() => validateReleaseManifest(manifest)).toThrow();
	});

	test("rejects altered linked digests and attestation or Compose disagreement", () => {
		expect(() =>
			validateReleaseManifest({ ...universal, releaseDigest: digest("8") }),
		).toThrow();
		expect(() =>
			validateReleaseEvidence(releaseSet, {
				attestationReleaseDigest: digest("8"),
				composeImages: releaseSet.images,
			}),
		).toThrow();
		expect(() =>
			validateReleaseEvidence(releaseSet, {
				attestationReleaseDigest: releaseSet.releaseDigest,
				composeImages: images("3", "8", "5", "6"),
			}),
		).toThrow();
	});
});

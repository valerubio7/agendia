import { z } from "zod";

export const releaseProcesses = [
	"web",
	"api",
	"whatsapp-manager",
	"message-worker",
] as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const image = z
	.string()
	.regex(
		/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)+[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/,
	);
const images = z
	.object({
		web: image,
		api: image,
		"whatsapp-manager": image,
		"message-worker": image,
	})
	.strict();
const database = z
	.object({
		compatibility: z.enum(["expand-compatible", "contract-maintenance"]),
		previousReleaseDigest: digest,
		minimumLedger: z.string().min(1),
	})
	.strict();
const base = z
	.object({
		schemaVersion: z.literal(1),
		commit: z.string().regex(/^[a-f0-9]{40}$/),
		platform: z.literal("linux/amd64"),
		images,
		database,
	})
	.strict();

export const releaseManifestSchema = z.discriminatedUnion("artifactKind", [
	base
		.extend({
			artifactKind: z.literal("universal-image"),
			releaseDigest: digest,
		})
		.refine(
			(manifest) =>
				new Set(Object.values(manifest.images)).size === 1 &&
				manifest.images.web.endsWith(manifest.releaseDigest),
			"universal-image must use one image matching releaseDigest",
		),
	base
		.extend({ artifactKind: z.literal("release-set"), releaseDigest: digest })
		.refine(
			(manifest) =>
				new Set(Object.values(manifest.images)).size ===
				releaseProcesses.length,
			"release-set must use one immutable image per process",
		),
]);
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function validateReleaseManifest(value: unknown): ReleaseManifest {
	return releaseManifestSchema.parse(value);
}

export function canonicalizeReleaseManifest(value: unknown): string {
	const manifest = validateReleaseManifest(value);
	return JSON.stringify({
		schemaVersion: manifest.schemaVersion,
		artifactKind: manifest.artifactKind,
		commit: manifest.commit,
		releaseDigest: manifest.releaseDigest,
		platform: manifest.platform,
		images: Object.fromEntries(
			releaseProcesses.map((process) => [process, manifest.images[process]]),
		),
		database: manifest.database,
	});
}

export function validateReleaseEvidence(
	manifest: unknown,
	evidence: unknown,
): ReleaseManifest {
	const parsed = validateReleaseManifest(manifest);
	const checked = z
		.object({ attestationReleaseDigest: digest, composeImages: images })
		.strict()
		.parse(evidence);
	if (checked.attestationReleaseDigest !== parsed.releaseDigest)
		throw new Error("Attestation digest disagrees with releaseDigest");
	for (const process of releaseProcesses)
		if (checked.composeImages[process] !== parsed.images[process])
			throw new Error(`Compose image disagrees for ${process}`);
	return parsed;
}

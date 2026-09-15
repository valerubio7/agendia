import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	renderCloudflaredConfig,
	renderCompose,
} from "../../scripts/render-compose";
import { postgresImage } from "../../scripts/support/locked-images.ts";
import {
	teardownStaging,
	type ManagedResource,
} from "../../scripts/staging-teardown";

const digest = (name: string) =>
	`registry.example/agendia/${name}@sha256:${"a".repeat(64)}`;

const universalImages = {
	app: digest("app"),
	postgres: postgresImage,
	cloudflared: digest("cloudflared"),
};

const releaseSetImages = {
	web: digest("web"),
	api: digest("api"),
	"whatsapp-manager": digest("manager"),
	"message-worker": digest("worker"),
};

const releaseSetManifest = (images = releaseSetImages) => ({
	schemaVersion: 1,
	artifactKind: "release-set" as const,
	commit: "b".repeat(40),
	releaseDigest: `sha256:${"c".repeat(64)}`,
	platform: "linux/amd64" as const,
	images,
	database: {
		compatibility: "expand-compatible" as const,
		previousReleaseDigest: `sha256:${"d".repeat(64)}`,
		minimumLedger: "0001_environment",
	},
});

describe("server Compose isolation", () => {
	test("renders production with literal isolated names, immutable images, hardening, probes, and no host ports", () => {
		const rendered = renderCompose({
			environment: "production",
			images: universalImages,
		});
		expect(() =>
			renderCompose({
				environment: "production",
				images: { ...universalImages, postgres: digest("not-postgres") },
			}),
		).toThrow("locked PostgreSQL image required");

		expect(rendered).toContain('name: "agendia-prod"');
		expect(rendered).toContain("agendia-prod-edge");
		expect(rendered).toContain("/srv/agendia/production/postgres");
		expect(rendered).toContain("/etc/agendia/production/config/api.env");
		expect(rendered).toContain('restart: "unless-stopped"');
		expect(rendered).toContain("read_only: true");
		expect(rendered).toContain('user: "10001:10001"');
		expect(rendered).toContain("cap_drop: [ALL]");
		expect(rendered).toContain("no-new-privileges:true");
		expect(rendered).toContain("/internal/live");
		expect(renderCloudflaredConfig("production")).toContain(
			"service: http_status:404",
		);
		expect(renderCloudflaredConfig("production")).toContain(
			"service: http://web:3000",
		);
		expect(renderCloudflaredConfig("staging")).toContain(
			"Access deny-by-default",
		);
		expect(rendered).not.toMatch(/^\s*ports:/m);
		expect(rendered).not.toMatch(/image:\s*[^\n@]+:(?!\/)/);
	});

	test("renders staging only with explicit conflict-free capacity clearance and accepts release-set images", () => {
		const releaseSet = {
			postgres: postgresImage,
			cloudflared: digest("cloudflared"),
			app: {
				web: digest("web"),
				api: digest("api"),
				"whatsapp-manager": digest("manager"),
				"message-worker": digest("worker"),
			},
		};
		const rendered = renderCompose({
			environment: "staging",
			images: releaseSet,
			releaseManifest: releaseSetManifest(releaseSet.app),
			releaseIdentity: releaseSetManifest(releaseSet.app).releaseDigest,
			capacity: {
				clearance: true,
				windowApproved: true,
				migrationActive: false,
				restoreActive: false,
				maintenanceActive: false,
				backlogActive: false,
				buildOrTestActive: false,
			},
		});

		expect(rendered).toContain('name: "agendia-stg"');
		expect(rendered).toContain("agendia-stg-data");
		expect(rendered).toContain("/srv/agendia/staging/postgres");
		expect(rendered).toContain('restart: "on-failure:3"');
		expect(rendered).toContain(digest("manager"));
		expect(() =>
			renderCompose({ environment: "staging", images: releaseSet }),
		).toThrow("staging capacity clearance");
		expect(() =>
			renderCompose({
				environment: "staging",
				images: releaseSet,
				capacity: {
					clearance: true,
					windowApproved: true,
					migrationActive: true,
				},
			}),
		).toThrow("staging capacity clearance");
		expect(
			renderCompose({
				environment: "staging",
				images: universalImages,
				capacity: {
					clearance: true,
					windowApproved: true,
					migrationActive: false,
					restoreActive: false,
					maintenanceActive: false,
					backlogActive: false,
					buildOrTestActive: false,
				},
			}),
		).toContain(digest("app"));
		expect(
			renderCompose({
				environment: "production",
				images: releaseSet,
				releaseManifest: releaseSetManifest(releaseSet.app),
				releaseIdentity: releaseSetManifest(releaseSet.app).releaseDigest,
			}),
		).toContain(digest("web"));
		expect(() =>
			renderCompose({
				environment: "production",
				images: { ...universalImages, app: "app:latest" },
			}),
		).toThrow("immutable image");
	});

	test("binds a release-set render to its validated immutable PR2 manifest", () => {
		const releaseSet = {
			postgres: postgresImage,
			cloudflared: digest("cloudflared"),
			app: releaseSetImages,
		};
		const capacity = {
			clearance: true,
			windowApproved: true,
			migrationActive: false,
			restoreActive: false,
			maintenanceActive: false,
			backlogActive: false,
			buildOrTestActive: false,
		};

		expect(
			renderCompose({
				environment: "staging",
				images: releaseSet,
				capacity,
				releaseManifest: releaseSetManifest(),
				releaseIdentity: releaseSetManifest().releaseDigest,
			}),
		).toContain(digest("manager"));
		expect(() =>
			renderCompose({
				environment: "staging",
				images: releaseSet,
				capacity,
			}),
		).toThrow("release-set manifest");
		expect(() =>
			renderCompose({
				environment: "staging",
				images: {
					...releaseSet,
					app: { ...releaseSetImages, web: digest("altered") },
				},
				capacity,
				releaseManifest: releaseSetManifest(),
				releaseIdentity: releaseSetManifest().releaseDigest,
			}),
		).toThrow("release-set manifest");
		expect(() =>
			renderCompose({
				environment: "staging",
				images: releaseSet,
				capacity,
				releaseManifest: {
					...releaseSetManifest(),
					artifactKind: "universal-image",
				},
				releaseIdentity: releaseSetManifest().releaseDigest,
			}),
		).toThrow();
		expect(() =>
			renderCompose({
				environment: "staging",
				images: releaseSet,
				capacity,
				releaseManifest: { ...releaseSetManifest(), unexpected: "input" },
				releaseIdentity: releaseSetManifest().releaseDigest,
			}),
		).toThrow();
		expect(() =>
			renderCompose({
				environment: "staging",
				images: releaseSet,
				capacity,
				releaseManifest: releaseSetManifest(),
				releaseIdentity: `sha256:${"e".repeat(64)}`,
			}),
		).toThrow("release identity");
	});

	test("uses cloudflared's shell-free native tunnel readiness healthcheck", () => {
		const rendered = renderCompose({
			environment: "production",
			images: universalImages,
		});
		expect(rendered).toContain(
			'test: ["CMD", "cloudflared", "tunnel", "ready"]',
		);
		expect(rendered).toContain("start_period: 10s");
		expect(rendered).not.toMatch(
			/cloudflared:[\s\S]*CMD-SHELL|cloudflared:[\s\S]*(curl|wget)/,
		);
	});

	test("removes staged resources while the teardown adapter proves production is unchanged", async () => {
		const staging: ManagedResource[] = [
			{
				id: "stg-container-id",
				name: "agendia-stg-web-1",
				labels: {
					"com.agendia.environment": "staging",
					"com.agendia.project": "agendia-stg",
					"com.agendia.managed": "true",
				},
			},
		];
		const production = [
			{ id: "prod-volume-id", checksum: "production-checksum" },
		];
		const commands: string[][] = [];

		await teardownStaging({
			environment: "staging",
			inspect: () => staging,
			observeProduction: () => production,
			run: (command) => {
				commands.push(command);
				staging.splice(0);
			},
		});

		expect(staging).toEqual([]);
		expect(commands).toEqual([
			[
				"docker",
				"compose",
				"-p",
				"agendia-stg",
				"-f",
				"deploy/compose.yml",
				"down",
				"--volumes",
				"--remove-orphans",
			],
		]);
		expect(production).toEqual([
			{ id: "prod-volume-id", checksum: "production-checksum" },
		]);
		await expect(
			teardownStaging({
				environment: "staging",
				inspect: () => [
					{ ...production[0]!, name: "agendia-prod-web-1", labels: {} },
				],
				observeProduction: () => production,
				run: () => undefined,
			}),
		).rejects.toThrow("prod");
		await expect(
			teardownStaging({
				environment: "production",
				inspect: () => staging,
				observeProduction: () => production,
				run: () => undefined,
			}),
		).rejects.toThrow("literal staging");
		await expect(
			teardownStaging({
				environment: "staging",
				inspect: () => staging,
				observeProduction: () => production,
				run: () => {
					production[0]!.checksum = "mutated";
				},
			}),
		).rejects.toThrow("production identity changed");
	});

	test("guards Next's generated production route declarations", () => {
		const declaration = readFileSync("apps/web/next-env.d.ts", "utf8");
		expect(declaration).toContain('import "./.next/types/routes.d.ts";');
		expect(declaration).toContain('import "./.next/types/root-params.d.ts";');
		expect(declaration).not.toContain(".next/dev");
	});
});

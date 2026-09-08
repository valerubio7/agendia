import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateReleaseManifest } from "@agendia/release-manifest";

export type Environment = "production" | "staging";
type AppImages =
	| string
	| Record<"web" | "api" | "whatsapp-manager" | "message-worker", string>;
export type RenderInput = {
	environment: Environment;
	images: { app: AppImages; postgres: string; cloudflared: string };
	releaseManifest?: unknown;
	releaseIdentity?: string;
	capacity?: Partial<{
		clearance: boolean;
		windowApproved: boolean;
		migrationActive: boolean;
		restoreActive: boolean;
		maintenanceActive: boolean;
		backlogActive: boolean;
		buildOrTestActive: boolean;
	}>;
};

const immutableImage = /^[a-z0-9][a-z0-9./_-]*@[sS][hH][aA]256:[a-f0-9]{64}$/i;
const appServices = [
	"web",
	"api",
	"whatsapp-manager",
	"message-worker",
] as const;
const root = resolve(import.meta.dir, "..");

const environments = {
	production: {
		project: "agendia-prod",
		state: "/srv/agendia/production",
		config: "/etc/agendia/production/config",
		secrets: "/etc/agendia/production/secrets",
		restart: "unless-stopped",
		limits: [
			"0.80",
			"1400m",
			"0.40",
			"600m",
			"0.25",
			"400m",
			"0.30",
			"600m",
			"0.25",
			"500m",
			"0.05",
			"128m",
		],
		tunnel: "agendia-production",
		hostname: "production.agendia.invalid",
	},
	staging: {
		project: "agendia-stg",
		state: "/srv/agendia/staging",
		config: "/etc/agendia/staging/config",
		secrets: "/etc/agendia/staging/secrets",
		restart: "on-failure:3",
		limits: [
			"0.20",
			"512m",
			"0.15",
			"384m",
			"0.10",
			"256m",
			"0.15",
			"384m",
			"0.15",
			"320m",
			"0.05",
			"96m",
		],
		tunnel: "agendia-staging",
		hostname: "staging.agendia.invalid",
	},
} as const;

function requireEnvironment(value: string): asserts value is Environment {
	if (value !== "production" && value !== "staging")
		throw new Error("environment must be production or staging");
}

function requireImage(value: string): string {
	if (!immutableImage.test(value))
		throw new Error("immutable image reference required");
	return value;
}

function resolveApps(
	app: AppImages,
	releaseManifest: unknown,
	releaseIdentity: string | undefined,
): Record<(typeof appServices)[number], string> {
	if (typeof app === "string") {
		const image = requireImage(app);
		return Object.fromEntries(
			appServices.map((service) => [service, image]),
		) as Record<(typeof appServices)[number], string>;
	}
	if (
		Object.keys(app).length !== appServices.length ||
		appServices.some((service) => !(service in app))
	)
		throw new Error(
			"release-set app images must contain exactly four services",
		);
	for (const service of appServices) requireImage(app[service]);
	if (releaseManifest === undefined)
		throw new Error("release-set manifest required");
	const manifest = validateReleaseManifest(releaseManifest);
	if (manifest.artifactKind !== "release-set")
		throw new Error("release-set manifest required");
	if (releaseIdentity !== manifest.releaseDigest)
		throw new Error("release-set manifest release identity disagrees");
	for (const service of appServices)
		if (app[service] !== manifest.images[service])
			throw new Error(`release-set manifest image disagrees for ${service}`);
	return app;
}

function requireStagingClearance(capacity: RenderInput["capacity"]): void {
	if (
		capacity?.clearance !== true ||
		capacity.windowApproved !== true ||
		capacity.migrationActive === true ||
		capacity.restoreActive === true ||
		capacity.maintenanceActive === true ||
		capacity.backlogActive === true ||
		capacity.buildOrTestActive === true
	)
		throw new Error(
			"staging capacity clearance is required without active conflicts",
		);
}

export function renderCompose(input: RenderInput): string {
	requireEnvironment(input.environment);
	if (input.environment === "staging") requireStagingClearance(input.capacity);
	const environment = environments[input.environment];
	const apps = resolveApps(
		input.images.app,
		input.releaseManifest,
		input.releaseIdentity,
	);
	const values: Record<string, string> = {
		PROJECT: environment.project,
		ENVIRONMENT: input.environment,
		POSTGRES_BIND: `${environment.state}/postgres`,
		CONFIG_DIR: environment.config,
		SECRETS_DIR: environment.secrets,
		RESTART: environment.restart,
		POSTGRES_IMAGE: requireImage(input.images.postgres),
		CLOUDFLARED_IMAGE: requireImage(input.images.cloudflared),
		WEB_IMAGE: apps.web,
		API_IMAGE: apps.api,
		MANAGER_IMAGE: apps["whatsapp-manager"],
		WORKER_IMAGE: apps["message-worker"],
	};
	const keys = [
		"POSTGRES_CPUS",
		"POSTGRES_MEMORY",
		"WEB_CPUS",
		"WEB_MEMORY",
		"API_CPUS",
		"API_MEMORY",
		"MANAGER_CPUS",
		"MANAGER_MEMORY",
		"WORKER_CPUS",
		"WORKER_MEMORY",
		"CLOUDFLARED_CPUS",
		"CLOUDFLARED_MEMORY",
	];
	keys.forEach((key, index) => {
		values[key] = environment.limits[index]!;
	});
	return readFileSync(resolve(root, "deploy/compose.yml"), "utf8").replace(
		/{{([A-Z_]+)}}/g,
		(_match, key: string) => {
			const value = values[key];
			if (!value) throw new Error(`unknown compose template token ${key}`);
			return value;
		},
	);
}

export function renderCloudflaredConfig(environmentInput: Environment): string {
	requireEnvironment(environmentInput);
	const environment = environments[environmentInput];
	const credentials = `/run/secrets/cloudflared-${environmentInput}.json`;
	return readFileSync(
		resolve(root, "deploy/cloudflared/config.yml.tmpl"),
		"utf8",
	)
		.replaceAll("{{TUNNEL_NAME}}", environment.tunnel)
		.replaceAll("{{CREDENTIALS_FILE}}", credentials)
		.replaceAll("{{HOSTNAME}}", environment.hostname);
}

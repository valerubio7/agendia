import { describe, expect, test } from "bun:test";
import {
	assertSourcePreflight,
	createBoundedHostRunner,
	createHostRuntime,
	type HostRunner,
	redactOperationsValue,
} from "../../scripts/host-deployment-runtime.ts";
import { postgresImage } from "../../scripts/support/locked-images.ts";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const appReference = `ghcr.io/valerubio7/agendia@${digest}`;
const ignoredDependencies = [
	"!! node_modules/",
	"!! apps/api/node_modules/",
	"!! apps/message-worker/node_modules/",
	"!! apps/web/node_modules/",
	"!! apps/whatsapp-manager/node_modules/",
	"!! packages/ai-deepseek/node_modules/",
	"!! packages/whatsapp-baileys/node_modules/",
];

function source(overrides: Record<string, unknown> = {}) {
	const root = `/opt/agendia/tooling/${commit}`;
	return {
		root,
		executingRoot: root,
		commit,
		bunVersion: "1.4.0",
		environment: {},
		stat: () => ({ uid: 0, mode: 0o40555 }),
		exists: () => false,
		read: (path: string) =>
			path.endsWith("HEAD")
				? `${commit}\n`
				: path.endsWith("bun.lock")
					? "lock"
					: "",
		git: (arguments_: readonly string[]) =>
			arguments_.includes("--ignored")
				? `${ignoredDependencies.join("\n")}\n`
				: arguments_[0] === "rev-parse"
					? `${commit}\n`
					: "",
		entries: () => [],
		...overrides,
	};
}

function runner(output?: string) {
	const calls: Array<{
		file: string;
		args: readonly string[];
		options: unknown;
	}> = [];
	const run: HostRunner = async (file, args, options) => {
		calls.push({ file, args, options });
		return {
			code: 0,
			stdout: output ?? `${args.at(-1)}|linux/amd64`,
			stderr: "",
		};
	};
	return { calls, run };
}

function hostRuntime(
	runner: HostRunner,
	environment: "staging" | "production" = "staging",
) {
	return createHostRuntime({ environment, root: "/tmp/release", runner });
}

function expectSourceFailure(overrides: Record<string, unknown>, code: string) {
	expect(() => assertSourcePreflight(source(overrides))).toThrow(code);
}

describe("direct pinned-source host runtime", () => {
	test("RED: accepts only a detached clean root-owned checkout with fixed Bun and frozen dependencies", () => {
		expect(() => assertSourcePreflight(source())).not.toThrow();
		expectSourceFailure(
			{ git: () => `${"c".repeat(40)}\n` },
			"host.source_commit_invalid",
		);
		expectSourceFailure(
			{
				git: (args: readonly string[]) =>
					args[0] === "status" ? " M scripts/deployctl.ts\n" : `${commit}\n`,
			},
			"host.source_dirty",
		);
		expectSourceFailure({ bunVersion: "1.4.1" }, "host.bun_version_invalid");
		expectSourceFailure(
			{ environment: { NODE_OPTIONS: "--require=evil" } },
			"host.environment_invalid",
		);
		expectSourceFailure(
			{ root: `/tmp/agendia-tooling/${commit}` },
			"host.source_path_invalid",
		);
		expectSourceFailure(
			{ exists: (path: string) => path.endsWith(".env") },
			"host.source_drift_invalid",
		);
		expectSourceFailure(
			{
				entries: () => ["node_modules/unsafe"],
				stat: (path: string) =>
					path.endsWith("unsafe")
						? { uid: 1_000, mode: 0o100644 }
						: { uid: 0, mode: 0o40555 },
			},
			"host.source_ownership_invalid",
		);
		expectSourceFailure(
			{ read: (path: string) => (path.endsWith("HEAD") ? `${commit}\n` : "") },
			"host.source_lock_invalid",
		);
	});

	test("RED: emits fixed Docker argv and a minimal non-shell environment for immutable amd64 images", async () => {
		const fake = runner();
		const runtime = hostRuntime(fake.run);
		await runtime.pull(appReference);
		await expect(runtime.inspect(appReference)).resolves.toEqual({
			reference: appReference,
			platform: "linux/amd64",
		});
		await runtime.converge("services: {}\n");
		expect(fake.calls.map(({ file, args }) => [file, args])).toEqual([
			[
				"/usr/bin/docker",
				["image", "pull", `ghcr.io/valerubio7/agendia@${digest}`],
			],
			[
				"/usr/bin/docker",
				[
					"image",
					"inspect",
					"--format",
					'{{join .RepoDigests ","}}|{{.Os}}/{{.Architecture}}',
					`ghcr.io/valerubio7/agendia@${digest}`,
				],
			],
			[
				"/usr/bin/docker",
				[
					"compose",
					"--project-name",
					"agendia-stg",
					"--file",
					"/tmp/release/compose.yml",
					"up",
					"--no-build",
					"--pull",
					"never",
					"--wait",
					"web",
					"api",
					"whatsapp-manager",
					"message-worker",
					"cloudflared",
				],
			],
		]);
		expect(fake.calls[2]?.args).not.toEqual(
			expect.arrayContaining(["provision-roles", "migrate", "queue-init"]),
		);
		expect(fake.calls.every(({ options }) => options)).toBe(true);
		expect(fake.calls[0]?.options).toMatchObject({
			shell: false,
			timeoutMs: 30_000,
			env: { DOCKER_CONFIG: "/etc/agendia/registry" },
		});
	});

	test("RED: dispatches an apply through the ordered Postgres, one-shot, app, and check commands", async () => {
		const fake = runner();
		const runtime = hostRuntime(fake.run);
		await runtime.runOrdered(false);
		expect(fake.calls.map(({ args }) => args.at(-1))).toEqual([
			"postgres",
			"provision-roles",
			"migrate",
			"queue-init",
			"cloudflared",
			"json",
		]);
		expect(fake.calls[4]?.args).toEqual(
			expect.arrayContaining([
				"web",
				"api",
				"whatsapp-manager",
				"message-worker",
			]),
		);
	});

	test("RED: rejects tags, poisoned runner output, and redacts operational failures", async () => {
		const fake = runner("linux/arm64");
		const runtime = hostRuntime(fake.run, "production");
		await expect(
			runtime.pull("ghcr.io/valerubio7/agendia:latest"),
		).rejects.toThrow("host.image_invalid");
		await expect(runtime.inspect(appReference)).rejects.toThrow(
			"host.image_platform_invalid",
		);
		expect(
			redactOperationsValue("postgres://user:secret@example.test/token?x=1"),
		).toBe("[redacted]");
	});

	test("RED: streams bounded output and escalates a timed-out child", async () => {
		let exit: (code: number) => void = () => {};
		const signals: Array<number | undefined> = [],
			close: Array<() => void> = [];
		const output = () =>
			new ReadableStream<Uint8Array>({
				start: (controller) => close.push(() => controller.close()),
			});
		const runtime = createBoundedHostRunner(
			() => ({
				exited: new Promise<number>((resolve) => {
					exit = resolve;
				}),
				stdout: output(),
				stderr: output(),
				kill: (signal?: number) => {
					signals.push(signal);
					if (signal === 9) {
						close.forEach((stream) => stream());
						exit(137);
					}
				},
			}),
			0,
		);
		const outcome = await runtime("/usr/bin/docker", ["version"], {
			shell: false,
			timeoutMs: 1,
			env: {},
		});
		expect(signals).toEqual([undefined, 9]);
		expect(outcome.timedOut).toBe(true);
	});

	test("RED: permits only locked PostgreSQL and Cloudflared infrastructure references", async () => {
		const fake = runner();
		const runtime = hostRuntime(fake.run);
		await expect(runtime.pull(postgresImage)).resolves.toBeUndefined();
		await expect(
			runtime.pull("cloudflare/cloudflared@sha256:" + "d".repeat(64)),
		).resolves.toBeUndefined();
		await expect(
			runtime.pull("postgres@sha256:" + "c".repeat(64)),
		).rejects.toThrow("host.image_invalid");
	});

	test("accepts exactly the seven workspace dependency directories in any order", () => {
		expect(() => assertSourcePreflight(source())).not.toThrow();
		expect(() =>
			assertSourcePreflight(
				source({
					git: (args: readonly string[]) =>
						args.includes("--ignored")
							? `${ignoredDependencies.toReversed().join("\n")}\n`
							: args[0] === "rev-parse"
								? `${commit}\n`
								: "",
				}),
			),
		).not.toThrow();
	});

	test("rejects missing, duplicate, and extra ignored entries", () => {
		for (const entries of [
			ignoredDependencies.slice(1),
			[...ignoredDependencies, ignoredDependencies[0]],
			[...ignoredDependencies, "!! node_modules/extra/"],
			[...ignoredDependencies, "!! .env.production"],
		]) {
			expectSourceFailure(
				{
					git: (args: readonly string[]) =>
						args.includes("--ignored")
							? `${entries.join("\n")}\n`
							: args[0] === "rev-parse"
								? `${commit}\n`
								: "",
				},
				"host.source_drift_invalid",
			);
		}
	});

	test("RED: binds preflight to its executing root and rejects ignored source drift", () => {
		expectSourceFailure(
			{ executingRoot: "/opt/agendia/tooling/" + "c".repeat(40) },
			"host.source_execution_invalid",
		);
		expectSourceFailure(
			{
				git: (args: readonly string[]) =>
					args.includes("--ignored")
						? "!! .env.production\n"
						: args[0] === "rev-parse"
							? `${commit}\n`
							: "",
			},
			"host.source_drift_invalid",
		);
	});
});

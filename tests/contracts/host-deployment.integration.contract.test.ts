import { describe, expect, test } from "bun:test";
import {
	createHostRuntime,
	redactOperationsValue,
	runPinnedDeploymentLifecycle,
	type HostRunner,
} from "../../scripts/host-deployment-runtime.ts";
const sentinel = "slice5-admin-secret-sentinel";
function runner(failure = false, outcome: "created" | "existing" = "created") {
	const files: string[] = [],
		calls: string[][] = [],
		environments: Record<string, string>[] = [];
	const run: HostRunner = async (file, args, options) => {
		files.push(file);
		calls.push([...args]);
		environments.push(options.env);
		const service = args.at(-1);
		return {
			code: failure && service === "bootstrap-admin" ? 1 : 0,
			stdout:
				service === "bootstrap-admin"
					? JSON.stringify({ event: "admin.bootstrap", outcome })
					: "ok",
			stderr: "",
		};
	};
	return { files, calls, environments, run };
}
const runtime = (
	runner: HostRunner,
	environment: "staging" | "production" = "staging",
) => createHostRuntime({ environment, root: "/tmp/release", runner });
const secretFilesystem = (
	environment: "staging" | "production" = "staging",
	unlinkFails = false,
) => ({
	statfs: () => ({ type: 0x01021994 }),
	mountinfo: () =>
		`36 25 0:32 / /run/agendia/${environment}/bootstrap rw - tmpfs tmpfs rw`,
	lstat: (path: string) => {
		const file = path.endsWith("/admin-password");
		return {
			uid: 0,
			gid: 0,
			mode: file ? 0o100600 : path === "/run" ? 0o40755 : 0o40700,
			nlink: 1,
			ino: 42,
			isFile: () => file,
			isDirectory: () => !file,
		};
	},
	readNoFollow: () => ({
		password: sentinel,
		inode: 42,
		stat: {
			uid: 0,
			gid: 0,
			mode: 0o100600,
			nlink: 1,
			ino: 42,
			isFile: () => true,
			isDirectory: () => false,
		},
	}),
	unlink: () => {
		if (unlinkFails) throw new Error("unlink failed");
	},
});
describe("direct source bootstrap lifecycle", () => {
	test("RED: stages the explicit root-only bootstrap before apps and never passes its sentinel to Docker", async () => {
		const fake = runner();
		await expect(
			runtime(fake.run).runBootstrap(secretFilesystem()),
		).resolves.toEqual({
			outcome: "created",
		});
		expect(
			fake.files.map(
				(file, index) => `${file}\0${fake.calls[index]!.join("\0")}`,
			),
		).toEqual([
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0up\0--no-build\0--pull\0never\0--wait\0postgres",
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0run\0--rm\0--no-deps\0-T\0provision-roles",
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0run\0--rm\0--no-deps\0-T\0migrate",
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0run\0--rm\0--no-deps\0-T\0queue-init",
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0run\0--rm\0--no-deps\0-T\0bootstrap-admin",
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0up\0--no-build\0--pull\0never\0--wait\0web\0api\0whatsapp-manager\0message-worker\0cloudflared",
			"/usr/bin/docker\0compose\0--project-name\0agendia-stg\0--file\0/tmp/release/compose.yml\0ps\0--format\0json",
		]);
		expect(fake.environments).toEqual(
			Array(7).fill({ DOCKER_CONFIG: "/etc/agendia/registry" }),
		);
		expect(JSON.stringify([fake.calls, fake.environments])).not.toContain(
			sentinel,
		);
	});
	test("RED: fails closed before application convergence when bootstrap fails", async () => {
		const fake = runner(true);
		await expect(
			runtime(fake.run, "production").runBootstrap(
				secretFilesystem("production"),
			),
		).rejects.toThrow("host.operation_failed");
		expect(fake.calls.map((args) => args.at(-1))).not.toContain("cloudflared");
	});
	test("TRIANGULATE: accepts an idempotent existing result but blocks apps when cleanup fails", async () => {
		const existing = runner(false, "existing");
		await expect(
			runtime(existing.run).runBootstrap(secretFilesystem()),
		).resolves.toEqual({
			outcome: "existing",
		});
		const cleanup = runner();
		await expect(
			runtime(cleanup.run).runBootstrap(secretFilesystem("staging", true)),
		).rejects.toThrow("unlink failed");
		expect(cleanup.calls.map((args) => args.at(-1))).not.toContain(
			"cloudflared",
		);
	});

	test("RED: stages pinned source, records an update failure, rolls back compatibly, and blocks admission", async () => {
		const fake = runner(false, "existing"),
			events: string[] = [];
		const bootstrap = await runtime(fake.run).runBootstrap(secretFilesystem());
		await expect(
			runPinnedDeploymentLifecycle({
				stagePinnedSource: async () => `sha256:${"a".repeat(64)}`,
				productionDigest: `sha256:${"a".repeat(64)}`,
				executeProduction: async () => {
					events.push("production.executed");
				},
				update: async () => {
					throw new Error("update failed");
				},
				rollback: {
					compatible: true,
					execute: async () => {
						events.push("rollback.executed");
					},
				},
				externalGates: { tunnel: false, backup: false, identities: false },
				evidence: (event) => events.push(event),
			}),
		).rejects.toThrow("host.user_admission_blocked");
		expect(events).toEqual([
			"staging.pass",
			"production.executed",
			"production.pass",
			"update.failed",
			"rollback.executed",
			"rollback.pass",
			"admission.blocked",
		]);
		expect(
			JSON.stringify([
				bootstrap,
				fake.files,
				fake.calls,
				fake.environments,
				events,
			]),
		).not.toContain(sentinel);
		expect(redactOperationsValue(sentinel)).toBe("[redacted]");
		await expect(
			runPinnedDeploymentLifecycle({
				stagePinnedSource: async () => `sha256:${"a".repeat(64)}`,
				productionDigest: `sha256:${"b".repeat(64)}`,
				executeProduction: async () => {
					throw new Error("production called");
				},
				update: async () => {},
				rollback: { compatible: true, execute: async () => {} },
				externalGates: { tunnel: true, backup: true, identities: true },
				evidence: () => {},
			}),
		).rejects.toThrow("host.lifecycle_digest_mismatch");
	});
});

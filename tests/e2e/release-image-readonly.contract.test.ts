import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { PgBoss } from "pg-boss";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresImage } from "../../scripts/support/locked-images.ts";
import {
	assertReadonlyRuntime,
	readonlyDockerRunArguments,
	readonlyRuntimePlans,
} from "../../deploy/p0/readonly-runtime.ts";

const commands = ["web", "api", "whatsapp-manager", "message-worker"] as const;
const image =
	process.env.AGENDIA_RELEASE_IMAGE ?? "agendia-release-pr4-readonly:test";
const buildLocally = process.env.AGENDIA_RELEASE_IMAGE === undefined;
const docker = (args: string[], options: { allowFailure?: boolean } = {}) => {
	try {
		return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
	} catch (error) {
		if (
			options.allowFailure &&
			error &&
			typeof error === "object" &&
			"stdout" in error
		)
			return `${String(error.stdout)}${"stderr" in error ? String(error.stderr) : ""}`;
		throw error;
	}
};
const ensureImage = () => {
	if (buildLocally)
		docker(["build", "--platform", "linux/amd64", "-t", image, "."]);
};
const cleanupImage = () => {
	if (!buildLocally) return;
	docker(["image", "rm", "-f", image], { allowFailure: true });
	expect(() => docker(["image", "inspect", image])).toThrow();
};
const runReleaseEntrypoint = (
	environment: "development" | "test" | "staging" | "production",
) => {
	const configDir = mkdtempSync(join(tmpdir(), "agendia-release-config-"));
	const databaseFile = join(configDir, "api-database-url");
	const { AGENDIA_ISOLATION_MANIFEST_FILE, DATABASE_URL, ...inherited } =
		process.env;
	const databaseUrl =
		environment === "staging"
			? "postgres://agendia_stg_api:secret@postgres/agendia_stg"
			: environment === "production"
				? "postgres://agendia_prod_api:secret@postgres/agendia_prod"
				: "postgres://api:secret@postgres/agendia_test";
	writeFileSync(databaseFile, `${databaseUrl}\n`, { mode: 0o644 });
	try {
		execFileSync(
			process.execPath,
			["scripts/release-entrypoint-config.ts", "api"],
			{
				cwd: process.cwd(),
				env: {
					...inherited,
					AGENDIA_PROCESS: "api",
					AGENDIA_ENVIRONMENT: environment,
					AGENDIA_ENVIRONMENT_ID: "00000000-0000-4000-8000-000000000001",
					AGENDIA_SECRET_SET_ID: "00000000-0000-4000-8000-000000000002",
					AGENDIA_RELEASE_DIGEST: `sha256:${"a".repeat(64)}`,
					API_DATABASE_URL_FILE: databaseFile,
					APP_ORIGIN:
						environment === "development"
							? "http://localhost:3000"
							: "https://readonly.test",
				},
				encoding: "utf8",
				stdio: "pipe",
			},
		);
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
};
const runtimeEnvironment = (databaseFile: string) => [
	"-e",
	"AGENDIA_PROCESS=api",
	"-e",
	"AGENDIA_ENVIRONMENT=test",
	"-e",
	"AGENDIA_ENVIRONMENT_ID=00000000-0000-4000-8000-000000000001",
	"-e",
	"AGENDIA_SECRET_SET_ID=00000000-0000-4000-8000-000000000002",
	"-e",
	`AGENDIA_RELEASE_DIGEST=sha256:${"a".repeat(64)}`,
	"-e",
	"APP_ORIGIN=https://readonly.test",
	"-e",
	`API_DATABASE_URL_FILE=/run/agendia/config/${databaseFile.split("/").pop()}`,
	"-e",
	"WHATSAPP_LINK_CODE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
];

type EffectiveMount = { Destination: string; RW: boolean; Type: string };

const containerDiagnostics = (application: string) => {
	const logs = spawnSync("docker", ["logs", application], { encoding: "utf8" });
	return {
		running: docker(["inspect", "-f", "{{.State.Running}}", application]).trim(),
		exitCode: docker([
			"inspect",
			"-f",
			"{{.State.ExitCode}}",
			application,
		]).trim(),
		error: docker(["inspect", "-f", "{{.State.Error}}", application]).trim(),
		logs: `${logs.stdout ?? ""}${logs.stderr ?? ""}`,
	};
};

const expectContainerRunning = (application: string) => {
	expect(containerDiagnostics(application)).toMatchObject({ running: "true" });
};

const effectiveMounts = (application: string): EffectiveMount[] => {
	const mounts = JSON.parse(
		docker(["inspect", "-f", "{{json .Mounts}}", application]),
	) as EffectiveMount[];
	const tmpfs = JSON.parse(
		docker(["inspect", "-f", "{{json .HostConfig.Tmpfs}}", application]),
	) as Record<string, string> | null;
	return [
		...mounts,
		...Object.keys(tmpfs ?? {}).map((Destination) => ({
			Destination,
			RW: true,
			Type: "tmpfs",
		})),
	];
};

const assertEffectiveMountContract = (
	application: string,
	command: (typeof commands)[number],
) => {
	const expected = [
		...readonlyRuntimePlans[command].tmpfs.map((mount) => ({
			Destination: mount.destination,
			RW: true,
			Type: "tmpfs",
		})),
		{ Destination: "/run/agendia/config", RW: false, Type: "bind" },
	].sort((left, right) => left.Destination.localeCompare(right.Destination));
	const actual = effectiveMounts(application)
		.map(({ Destination, RW, Type }) => ({ Destination, RW, Type }))
		.sort((left, right) => left.Destination.localeCompare(right.Destination));
	expect(actual).toEqual(expected);
	for (const mount of readonlyRuntimePlans[command].tmpfs)
		expect(
			docker([
				"exec",
				application,
				"stat",
				"-c",
				"%u:%g:%a",
				mount.destination,
			]).trim(),
		).toBe(`${mount.uid}:${mount.gid}:${mount.mode.replace(/^0/, "")}`);
};

const assertHttpResponse = async (
	application: string,
	command: "web" | "api",
) => {
	const [port, expectedStatus, path] =
		command === "web" ? [3000, 200, ""] : [3001, 401, "auth/session"];
	let response = "not attempted";
	for (let retry = 0; retry < 20; retry++) {
		response = docker(
			[
				"exec",
				application,
				"bun",
				"-e",
				`const host=${command === "web" ? "process.env.HOSTNAME" : "'127.0.0.1'"};const r=await fetch(\`http://\${host}:${port}/${path}\`);if(r.status!==${expectedStatus})throw new Error(String(r.status))`,
			],
			{ allowFailure: true },
		);
		if (!response) return;
		await Bun.sleep(250);
	}
	expect(response).toBe("");
};

describe("release image read-only runtime", () => {
	test("validates every environment but requires the isolation manifest only for releases", () => {
		expect(() => runReleaseEntrypoint("development")).not.toThrow();
		expect(() => runReleaseEntrypoint("test")).not.toThrow();
		expect(() => runReleaseEntrypoint("staging")).toThrow();
		expect(() => runReleaseEntrypoint("production")).toThrow();
	});

	test("fails closed for an undeclared mount or a forbidden write", () => {
		expect(() =>
			assertReadonlyRuntime({
				command: "api",
				mounts: ["/tmp", "/run/agendia/api", "/var/cache"],
				writable: ["/tmp", "/run/agendia/api"],
			}),
		).toThrow("undeclared writable mount: /var/cache");
		expect(() =>
			assertReadonlyRuntime({
				command: "api",
				mounts: ["/tmp", "/run/agendia/api"],
				writable: ["/tmp", "/run/agendia/api", "/etc"],
			}),
		).toThrow("forbidden writable path: /etc");
	});

	test("declares the exact read-only-root contract for every release command", () => {
		expect(Object.keys(readonlyRuntimePlans)).toEqual([...commands]);
		for (const command of commands) {
			const plan = readonlyRuntimePlans[command];
			expect(plan.tmpfs).toBeDefined();
			expect(plan.readOnlyRoot).toBe(true);
			expect(plan.providerEgress).toBe(false);
			expect(plan.database).toBe("ephemeral-postgresql");
			expect(plan.writable).toContain("/tmp");
			expect(plan.deniedWrites).toEqual(["/opt/agendia", "/etc", "/sibling"]);
			expect(plan.restartIndependent).toBe(true);
		}
	});

	test("triangulates Docker hardening arguments for universal-image commands", () => {
		for (const command of commands) {
			const arguments_ = readonlyDockerRunArguments(command);
			expect(arguments_).toContain("--read-only");
			expect(arguments_).not.toContain("--network");
			for (const mount of readonlyRuntimePlans[command].tmpfs)
				expect(arguments_).toContain(
					`${mount.destination}:rw,nosuid,nodev,noexec,uid=${mount.uid},gid=${mount.gid},mode=${mount.mode}`,
				);
			expect(
				arguments_.filter((argument) => argument === "--tmpfs").length,
			).toBe(readonlyRuntimePlans[command].tmpfs.length);
		}
	});

	test("starts the generated API against isolated ephemeral PostgreSQL with only declared writable tmpfs", async () => {
		const name = `agendia-pr4-red-${Date.now()}`;
		const network = `${name}-network`;
		const database = `${name}-postgres`;
		const application = `${name}-api`;
		const label = `com.agendia.pr4.run=${name}`;
		const configDir = mkdtempSync(join(tmpdir(), "agendia-pr4-config-"));
		const databaseFile = join(configDir, "api-database-url");
		writeFileSync(
			databaseFile,
			"postgres://postgres:postgres@postgres:5432/postgres\n",
			{ mode: 0o644 },
		);
		chmodSync(configDir, 0o755);
		try {
			ensureImage();
			docker(["network", "create", "--internal", "--label", label, network]);
			docker([
				"run",
				"-d",
				"--name",
				database,
				"--label",
				label,
				"--mount",
				`type=volume,destination=/var/lib/postgresql/data,volume-label=${label}`,
				"--network",
				network,
				"--network-alias",
				"postgres",
				"-e",
				"POSTGRES_PASSWORD=postgres",
				postgresImage,
			]);
			docker([
				"run",
				"-d",
				"--name",
				application,
				"--label",
				label,
				"--network",
				network,
				"--read-only",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,noexec,uid=10001,gid=10001,mode=1777",
				"--tmpfs",
				"/run/agendia/api:rw,nosuid,nodev,noexec,uid=10001,gid=10001,mode=0750",
				"-v",
				`${configDir}:/run/agendia/config:ro`,
				...runtimeEnvironment(databaseFile),
				image,
				"api",
			]);
			await Bun.sleep(2_500);
			expect(containerDiagnostics(application)).toMatchObject({
				running: "true",
				exitCode: "0",
				error: "",
			});
			assertEffectiveMountContract(application, "api");
		} finally {
			docker(["rm", "-f", application, database], { allowFailure: true });
			docker(["network", "rm", network], { allowFailure: true });
			for (const volume of docker([
				"volume",
				"ls",
				"-q",
				"--filter",
				`label=${label}`,
			])
				.trim()
				.split("\n")
				.filter(Boolean))
				docker(["volume", "rm", "-f", volume], { allowFailure: true });
			cleanupImage();
			expect(docker(["ps", "-aq", "--filter", `label=${label}`]).trim()).toBe(
				"",
			);
			expect(
				docker(["volume", "ls", "-q", "--filter", `label=${label}`]).trim(),
			).toBe("");
			expect(
				docker(["network", "ls", "-q", "--filter", `label=${label}`]).trim(),
			).toBe("");
			rmSync(configDir, { recursive: true, force: true });
		}
	}, 180_000);

	test("triangulates the real isolated runtime for web, API, manager, and worker", async () => {
		const name = `agendia-pr4-runtime-${Date.now()}`;
		const network = `${name}-network`;
		const database = `${name}-postgres`;
		const label = `com.agendia.pr4.run=${name}`;
		const configDir = mkdtempSync(join(tmpdir(), "agendia-pr4-config-"));
		const databaseFile = join(configDir, "database-url");
		writeFileSync(
			databaseFile,
			"postgres://postgres:postgres@postgres:5432/postgres\n",
			{ mode: 0o644 },
		);
		chmodSync(configDir, 0o755);
		const applications: string[] = [];
		try {
			ensureImage();
			docker(["network", "create", "--internal", "--label", label, network]);
			docker([
				"run",
				"-d",
				"--name",
				database,
				"--label",
				label,
				"--mount",
				`type=volume,destination=/var/lib/postgresql/data,volume-label=${label}`,
				"--network",
				network,
				"--network-alias",
				"postgres",
				"-v",
				`${process.cwd()}/packages/db/migrations:/migrations:ro`,
				"-e",
				"POSTGRES_PASSWORD=postgres",
				postgresImage,
			]);
			for (let retry = 0; retry < 30; retry++) {
				if (
					docker(
						[
							"exec",
							database,
							"pg_isready",
							"-h",
							"localhost",
							"-U",
							"postgres",
						],
						{ allowFailure: true },
					).includes("accepting connections")
				)
					break;
				await Bun.sleep(250);
			}
			docker([
				"exec",
				database,
				"sh",
				"-ec",
				'for sql in /migrations/*.sql; do psql -h localhost -v ON_ERROR_STOP=1 -U postgres -f "$sql"; done',
			]);
			const databaseIp = docker([
				"inspect",
				"-f",
				`{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}`,
				database,
			]).trim();
			const bootstrap = new PgBoss({
				connectionString: `postgres://postgres:postgres@${databaseIp}:5432/postgres`,
				schema: "pgboss",
			});
			await bootstrap.start();
			await bootstrap.stop();
			for (const command of commands) {
				const application = `${name}-${command}`;
				applications.push(application);
				const databaseVariable = `${command.toUpperCase().replaceAll("-", "_")}_DATABASE_URL_FILE`;
				docker([
					"run",
					"-d",
					"--name",
					application,
					"--label",
					label,
					"--network",
					network,
					...readonlyDockerRunArguments(command),
					"-v",
					`${configDir}:/run/agendia/config:ro`,
					"-e",
					`AGENDIA_PROCESS=${command}`,
					"-e",
					"AGENDIA_ENVIRONMENT=test",
					"-e",
					"AGENDIA_ENVIRONMENT_ID=00000000-0000-4000-8000-000000000001",
					"-e",
					"AGENDIA_SECRET_SET_ID=00000000-0000-4000-8000-000000000002",
					"-e",
					`AGENDIA_RELEASE_DIGEST=sha256:${"b".repeat(64)}`,
					"-e",
					"APP_ORIGIN=https://readonly.test",
					"-e",
					`${databaseVariable}=/run/agendia/config/database-url`,
					...(command === "whatsapp-manager"
						? [
								"-e",
								"QUEUE_PUBLISHER_DATABASE_URL_FILE=/run/agendia/config/database-url",
							]
						: []),
					"-e",
					"WHATSAPP_LINK_CODE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
					"-e",
					"BAILEYS_KMS_VERSION=readonly-v1",
					"-e",
					"BAILEYS_KMS_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
					"-e",
					"DEEPSEEK_API_KEY=readonly-provider-double",
					image,
					command,
				]);
				await Bun.sleep(1_000);
				expectContainerRunning(application);
				assertEffectiveMountContract(application, command);
				if (command === "whatsapp-manager")
					expect(
						docker([
							"exec",
							database,
							"psql",
							"-h",
							"localhost",
							"-U",
							"postgres",
							"-At",
							"-c",
							"select count(*) from pgboss.queue where name='ai-generate'",
						]).trim(),
					).toBe("1");
				for (const [port, expectedStatus] of command === "web"
					? [[3000, 200]]
					: command === "api"
						? [[3001, 401]]
						: []) {
					let response = "";
					for (let retry = 0; retry < 20; retry++) {
						response = docker(
							[
								"exec",
								application,
								"bun",
								"-e",
								`const host=${command === "web" ? "process.env.HOSTNAME" : "'127.0.0.1'"};const r=await fetch(\`http://\${host}:${port}/${command === "api" ? "auth/session" : ""}\`);if(r.status!==${expectedStatus})throw new Error(String(r.status))`,
							],
							{ allowFailure: true },
						);
						if (!response) break;
						await Bun.sleep(250);
					}
					expect(response).toBe("");
				}
				const writable = readonlyRuntimePlans[command].writable;
				docker([
					"exec",
					application,
					"sh",
					"-ec",
					`touch ${writable.map((path) => `${path}/pr4-write`).join(" ")}`,
				]);
				for (const forbidden of [
					"/opt/agendia/pr4-write",
					"/etc/pr4-write",
					"/run/agendia/sibling",
				]) {
					expect(() =>
						docker(["exec", application, "sh", "-ec", `touch ${forbidden}`]),
					).toThrow();
				}
				docker([
					"exec",
					application,
					"sh",
					"-ec",
					"touch /tmp/pr4-tmpfs-marker",
				]);
				docker(["restart", application]);
				await Bun.sleep(1_000);
				expect(() =>
					docker([
						"exec",
						application,
						"sh",
						"-ec",
						"test ! -e /tmp/pr4-tmpfs-marker",
					]),
				).not.toThrow();
				expect(
					docker(["inspect", "-f", "{{.State.Running}}", application]).trim(),
				).toBe("true");
				assertEffectiveMountContract(application, command);
				if (command === "web" || command === "api")
					await assertHttpResponse(application, command);
				if (command === "whatsapp-manager")
					expect(
						docker([
							"exec",
							database,
							"psql",
							"-h",
							"localhost",
							"-U",
							"postgres",
							"-At",
							"-c",
							"select count(*) from pgboss.queue where name='ai-generate'",
						]).trim(),
					).toBe("1");
			}
			const verification = new PgBoss({
				connectionString: `postgres://postgres:postgres@${databaseIp}:5432/postgres`,
				schema: "pgboss",
			});
			await verification.start();
			try {
				expect(
					(await verification.getQueues()).map((queue) => queue.name),
				).toEqual(
					expect.arrayContaining(["ai-generate", "conversation-summary"]),
				);
				const jobId = await verification.send("ai-generate", {
					businessId: "00000000-0000-4000-8000-000000000003",
					messageId: "missing-message-is-a-deterministic-noop",
					correlationId: "pr4-worker-consumption",
				});
				let state = "created";
				for (
					let retry = 0;
					retry < 20 && !["completed", "failed", "consumed"].includes(state);
					retry++
				) {
					await Bun.sleep(250);
					state = docker([
						"exec",
						database,
						"psql",
						"-h",
						"localhost",
						"-U",
						"postgres",
						"-At",
						"-c",
						`select coalesce((select state::text from pgboss.job where id='${jobId}'),'consumed')`,
					]).trim();
				}
				expect(["completed", "failed", "consumed"]).toContain(state);
			} finally {
				await verification.stop();
			}
			expect(
				docker(["network", "inspect", "-f", "{{.Internal}}", network]).trim(),
			).toBe("true");
		} finally {
			docker(["rm", "-f", ...applications, database], { allowFailure: true });
			docker(["network", "rm", network], { allowFailure: true });
			for (const volume of docker([
				"volume",
				"ls",
				"-q",
				"--filter",
				`label=${label}`,
			])
				.trim()
				.split("\n")
				.filter(Boolean))
				docker(["volume", "rm", "-f", volume], { allowFailure: true });
			cleanupImage();
			expect(docker(["ps", "-aq", "--filter", `label=${label}`]).trim()).toBe(
				"",
			);
			expect(
				docker(["volume", "ls", "-q", "--filter", `label=${label}`]).trim(),
			).toBe("");
			expect(
				docker(["network", "ls", "-q", "--filter", `label=${label}`]).trim(),
			).toBe("");
			rmSync(configDir, { recursive: true, force: true });
		}
	}, 240_000);
});

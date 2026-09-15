import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	statfsSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { DeploymentRuntime } from "./deployctl.ts";
import { postgresImage } from "./support/locked-images.ts";

const bunVersion = "1.4.0";
const docker = "/usr/bin/docker";
const outputLimit = 8_192;
const appImage = /^ghcr\.io\/valerubio7\/agendia@sha256:[a-f0-9]{64}$/;
const cloudflaredImage = /^cloudflare\/cloudflared@sha256:[a-f0-9]{64}$/;
type Environment = "staging" | "production";

type HostResult = {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
};

export type HostRunner = (
	file: string,
	args: readonly string[],
	options: { shell: false; timeoutMs: number; env: Record<string, string> },
) => Promise<HostResult>;

async function readBoundedOutput(
	stream: ReadableStream<Uint8Array>,
	onLimit: () => void,
): Promise<string> {
	const reader = stream.getReader(),
		chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.length;
			chunks.push(next.value);
			if (length > outputLimit) {
				onLimit();
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

type HostChild = {
	exited: Promise<number>;
	kill(signal?: number): void;
} & Record<"stdout" | "stderr", ReadableStream<Uint8Array>>;
export type HostSpawner = (...args: Parameters<HostRunner>) => HostChild;

export function createBoundedHostRunner(
	spawn: HostSpawner,
	escalationMs = 1_000,
): HostRunner {
	return async (file, args, run) => {
		if (file !== docker || run.shell !== false)
			throw new Error("host.runner_invalid");
		const child = spawn(file, args, run);
		let timedOut = false,
			terminating = false,
			escalation: Timer | undefined;
		const terminate = () => {
			if (terminating) return;
			terminating = true;
			child.kill();
			escalation = setTimeout(() => child.kill(9), escalationMs);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, run.timeoutMs);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			readBoundedOutput(child.stdout, terminate),
			readBoundedOutput(child.stderr, terminate),
		]);
		clearTimeout(timeout);
		if (escalation) clearTimeout(escalation);
		return { code, stdout, stderr, timedOut };
	};
}

/** The production runner has no PATH lookup or shell expansion; tests inject HostSpawner instead. */
export function createFixedHostRunner(): HostRunner {
	return createBoundedHostRunner((file, args, run) =>
		Bun.spawn([file, ...args], {
			cwd: "/",
			env: run.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
}

type SourcePreflight = {
	root: string;
	executingRoot: string;
	commit: string;
	bunVersion: string;
	environment: Record<string, string | undefined>;
	stat(path: string): { uid: number; mode: number };
	exists(path: string): boolean;
	read(path: string): string;
	entries(path: string): readonly string[];
	git(args: readonly string[]): string;
};

export function assertSourcePreflight(source: SourcePreflight): void {
	if (
		!/^[a-f0-9]{40}$/.test(source.commit) ||
		source.root !== `/opt/agendia/tooling/${source.commit}`
	)
		throw new Error("host.source_path_invalid");
	if (source.executingRoot !== source.root)
		throw new Error("host.source_execution_invalid");
	if (source.bunVersion !== bunVersion)
		throw new Error("host.bun_version_invalid");
	for (const name of [
		"NODE_OPTIONS",
		"NODE_PATH",
		"BUN_OPTIONS",
		"BUN_PRELOAD",
		"BUNFIG",
		"BUN_CONFIG",
		"BUN_AUTO_INSTALL",
	])
		if (source.environment[name]) throw new Error("host.environment_invalid");
	for (const path of [
		join(source.root, ".env"),
		join(source.root, ".env.local"),
		join(source.root, "bunfig.toml"),
	])
		if (source.exists(path)) throw new Error("host.source_drift_invalid");
	for (const path of [
		"/opt",
		"/opt/agendia",
		"/opt/agendia/tooling",
		source.root,
		join(source.root, ".git"),
		join(source.root, "package.json"),
		join(source.root, "bun.lock"),
		join(source.root, "node_modules"),
		...source.entries(source.root).map((entry) => join(source.root, entry)),
	]) {
		const info = source.stat(path);
		if (info.uid !== 0 || (info.mode & 0o022) !== 0)
			throw new Error("host.source_ownership_invalid");
	}
	if (!source.read(join(source.root, "bun.lock")).trim())
		throw new Error("host.source_lock_invalid");
	if (source.read(join(source.root, ".git", "HEAD")).trim() !== source.commit)
		throw new Error("host.source_branch_invalid");
	if (source.git(["rev-parse", "HEAD"]).trim() !== source.commit)
		throw new Error("host.source_commit_invalid");
	if (source.git(["status", "--porcelain=v1", "--untracked-files=all"]).trim())
		throw new Error("host.source_dirty");
	if (
		source
			.git(["status", "--porcelain=v1", "--ignored", "--untracked-files=all"])
			.trim() !== "!! node_modules/"
	)
		throw new Error("host.source_drift_invalid");
}

function image(reference: string): void {
	const valid =
		reference === postgresImage ||
		appImage.test(reference) ||
		cloudflaredImage.test(reference);
	if (!valid) throw new Error("host.image_invalid");
}
function result({ code, stdout, stderr, timedOut }: HostResult): string {
	const successful =
		code === 0 &&
		!timedOut &&
		stdout.length <= outputLimit &&
		stderr.length <= outputLimit;
	if (!successful) throw new Error("host.operation_failed");
	return stdout.trim();
}
function project(environment: Environment) {
	return environment === "staging" ? "agendia-stg" : "agendia-prod";
}
function options() {
	return {
		shell: false as const,
		timeoutMs: 30_000,
		env: { DOCKER_CONFIG: "/etc/agendia/registry" },
	};
}

type BootstrapSecretStat = {
	uid: number;
	gid: number;
	mode: number;
	nlink: number;
	ino: number;
	isFile(): boolean;
	isDirectory(): boolean;
};
export type BootstrapSecretFilesystem = {
	statfs(path: string): { type: number };
	mountinfo(): string;
	lstat(path: string): BootstrapSecretStat;
	readNoFollow(path: string): {
		password: string;
		inode: number;
		stat: BootstrapSecretStat;
	};
	unlink(path: string): void;
};
export type BootstrapSecret = { path: string; password: string; inode: number };

const tmpfsMagic = 0x01021994;
export function bootstrapSecretPath(environment: Environment): string {
	return `/run/agendia/${environment}/bootstrap/admin-password`;
}
function bootstrapSecretStat(stat: BootstrapSecretStat): void {
	if (!stat.isFile()) throw new Error("host.bootstrap_secret_type_invalid");
	if (stat.uid !== 0 || stat.gid !== 0)
		throw new Error("host.bootstrap_secret_owner_invalid");
	if (stat.mode !== 0o100600)
		throw new Error("host.bootstrap_secret_mode_invalid");
	if (stat.nlink !== 1) throw new Error("host.bootstrap_secret_link_invalid");
}
function assertBootstrapSecretParents(
	path: string,
	filesystem: BootstrapSecretFilesystem,
): void {
	if (
		!/^\/run\/agendia\/(?:staging|production)\/bootstrap\/admin-password$/.test(
			path,
		)
	)
		throw new Error("host.bootstrap_secret_path_invalid");
	const expected = [
		["/run", 0o755],
		["/run/agendia", 0o700],
		[path.slice(0, path.lastIndexOf("/bootstrap")), 0o700],
		[path.slice(0, path.lastIndexOf("/")), 0o700],
	] as const;
	for (const [parent, mode] of expected) {
		const stat = filesystem.lstat(parent);
		if (
			!stat.isDirectory() ||
			stat.uid !== 0 ||
			stat.gid !== 0 ||
			stat.mode !== (0o40000 | mode)
		)
			throw new Error("host.bootstrap_secret_parent_invalid");
	}
}
function assertBootstrapTmpfs(
	path: string,
	mountinfo: string,
	type: number,
): void {
	const mounts = mountinfo
		.split("\n")
		.map((line) => {
			const [left, right] = line.split(" - ", 2);
			return { mount: left?.split(" ")[4], type: right?.split(" ")[0] };
		})
		.filter((entry) => entry.mount && path.startsWith(`${entry.mount}/`))
		.sort((left, right) => right.mount!.length - left.mount!.length);
	if (type !== tmpfsMagic || mounts[0]?.type !== "tmpfs")
		throw new Error("host.bootstrap_secret_tmpfs_invalid");
}
export function readBootstrapSecret(
	environment: Environment,
	filesystem: BootstrapSecretFilesystem = hostBootstrapSecretFilesystem,
): BootstrapSecret {
	const path = bootstrapSecretPath(environment);
	assertBootstrapTmpfs(
		path,
		filesystem.mountinfo(),
		filesystem.statfs(path).type,
	);
	assertBootstrapSecretParents(path, filesystem);
	const before = filesystem.lstat(path);
	bootstrapSecretStat(before);
	const opened = filesystem.readNoFollow(path);
	bootstrapSecretStat(opened.stat);
	const after = filesystem.lstat(path);
	bootstrapSecretStat(after);
	if (
		opened.inode !== before.ino ||
		opened.stat.ino !== before.ino ||
		after.ino !== before.ino
	)
		throw new Error("host.bootstrap_secret_inode_invalid");
	return { path, password: opened.password, inode: before.ino };
}
export function unlinkBootstrapSecret(
	secret: BootstrapSecret,
	filesystem: BootstrapSecretFilesystem = hostBootstrapSecretFilesystem,
): void {
	assertBootstrapSecretParents(secret.path, filesystem);
	const current = filesystem.lstat(secret.path);
	bootstrapSecretStat(current);
	if (current.ino !== secret.inode)
		throw new Error("host.bootstrap_secret_inode_invalid");
	filesystem.unlink(secret.path);
}
const hostBootstrapSecretFilesystem: BootstrapSecretFilesystem = {
	statfs: statfsSync,
	mountinfo: () => readFileSync("/proc/self/mountinfo", "utf8"),
	lstat: lstatSync,
	readNoFollow: (path) => {
		const descriptor = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const stat = fstatSync(descriptor);
			return {
				password: readFileSync(descriptor, "utf8"),
				inode: stat.ino,
				stat,
			};
		} finally {
			closeSync(descriptor);
		}
	},
	unlink: unlinkSync,
};

export type OrderedDeploymentRuntime = {
	startPostgres(): Promise<void>;
	runOneShot(
		service: "provision-roles" | "migrate" | "queue-init",
	): Promise<void>;
	checks(): Promise<void>;
};

/** Runs only after preflight; bootstrap remains an explicit Slice 5 gate. */
export async function runOrderedDeployment(options: {
	runtime: OrderedDeploymentRuntime & {
		converge(compose?: string): Promise<void>;
	};
	bootstrapRequired: boolean;
	bootstrap?: () => Promise<void>;
}): Promise<void> {
	await options.runtime.startPostgres();
	for (const service of ["provision-roles", "migrate", "queue-init"] as const)
		await options.runtime.runOneShot(service);
	if (options.bootstrapRequired) {
		if (!options.bootstrap) throw new Error("host.bootstrap_required");
		await options.bootstrap();
	}
	await options.runtime.converge();
	await options.runtime.checks();
}
type LifecycleEvidence =
	| "staging.pass"
	| "production.pass"
	| "update.failed"
	| "rollback.pass"
	| "admission.blocked"
	| "admission.pass";
export async function runPinnedDeploymentLifecycle(input: {
	stagePinnedSource(): Promise<string>;
	productionDigest: string;
	executeProduction(): Promise<void>;
	update(): Promise<void>;
	rollback: { compatible: boolean; execute(): Promise<void> };
	externalGates: { tunnel: boolean; backup: boolean; identities: boolean };
	evidence(event: LifecycleEvidence): void;
}): Promise<void> {
	const stagingDigest = await input.stagePinnedSource();
	if (!/^sha256:[a-f0-9]{64}$/.test(stagingDigest))
		throw new Error("host.lifecycle_digest_invalid");
	input.evidence("staging.pass");
	if (input.productionDigest !== stagingDigest)
		throw new Error("host.lifecycle_digest_mismatch");
	await input.executeProduction();
	input.evidence("production.pass");
	try {
		await input.update();
	} catch {
		input.evidence("update.failed");
		if (!input.rollback.compatible)
			throw new Error("host.rollback_incompatible");
		await input.rollback.execute();
		input.evidence("rollback.pass");
	}
	if (Object.values(input.externalGates).some((gate) => !gate)) {
		input.evidence("admission.blocked");
		throw new Error("host.user_admission_blocked");
	}
	input.evidence("admission.pass");
}

export type BootstrapOutcome = { outcome: "created" | "existing" };
function parseBootstrapOutcome(value: string): BootstrapOutcome {
	let parsed: { event?: unknown; outcome?: unknown };
	try {
		parsed = JSON.parse(value) as { event?: unknown; outcome?: unknown };
	} catch {
		throw new Error("host.bootstrap_result_invalid");
	}
	if (
		parsed.event === "admin.bootstrap" &&
		(parsed.outcome === "created" || parsed.outcome === "existing")
	)
		return { outcome: parsed.outcome };
	throw new Error("host.bootstrap_result_invalid");
}

export function createHostRuntime(input: {
	environment: Environment;
	root: string;
	runner?: HostRunner;
}): DeploymentRuntime &
	OrderedDeploymentRuntime & {
		runOrdered(bootstrapRequired: boolean): Promise<void>;
		runBootstrap(
			filesystem?: BootstrapSecretFilesystem,
		): Promise<BootstrapOutcome>;
	} {
	const compose = join(input.root, "compose.yml"),
		runner = input.runner ?? createFixedHostRunner(),
		apps = ["web", "api", "whatsapp-manager", "message-worker", "cloudflared"];
	const run = (args: readonly string[]) =>
		runner(docker, args, options()).then(result);
	const composeCommand = (...args: string[]) =>
		run([
			"compose",
			"--project-name",
			project(input.environment),
			"--file",
			compose,
			...args,
		]);
	const composeUp = (...services: string[]) =>
		composeCommand(
			"up",
			"--no-build",
			"--pull",
			"never",
			"--wait",
			...services,
		);
	const runtime: DeploymentRuntime & OrderedDeploymentRuntime = {
		pull: async (reference) => {
			image(reference);
			await run(["image", "pull", reference]);
		},
		inspect: async (reference) => {
			image(reference);
			const inspected = await run([
				"image",
				"inspect",
				"--format",
				'{{join .RepoDigests ","}}|{{.Os}}/{{.Architecture}}',
				reference,
			]);
			const [repoDigests, platform] = inspected.split("|", 2);
			if (
				platform !== "linux/amd64" ||
				!repoDigests?.split(",").includes(reference)
			)
				throw new Error("host.image_platform_invalid");
			return { reference, platform };
		},
		converge: async (rendered) => {
			if (rendered !== undefined && (!rendered || rendered.length > 1_000_000))
				throw new Error("host.compose_invalid");
			await composeUp(...apps);
		},
		startPostgres: async () => {
			await composeUp("postgres");
		},
		runOneShot: async (service) => {
			await composeCommand("run", "--rm", "--no-deps", "-T", service);
		},
		checks: async () => {
			await composeCommand("ps", "--format", "json");
		},
	};
	const runBootstrap = async (filesystem = hostBootstrapSecretFilesystem) => {
		let outcome: BootstrapOutcome | undefined;
		await runOrderedDeployment({
			runtime,
			bootstrapRequired: true,
			bootstrap: async () => {
				const secret = readBootstrapSecret(input.environment, filesystem);
				outcome = parseBootstrapOutcome(
					await composeCommand(
						"run",
						"--rm",
						"--no-deps",
						"-T",
						"bootstrap-admin",
					),
				);
				unlinkBootstrapSecret(secret, filesystem);
			},
		});
		return outcome!;
	};
	return {
		...runtime,
		runOrdered: async (bootstrapRequired) => {
			if (bootstrapRequired) await runBootstrap();
			else await runOrderedDeployment({ runtime, bootstrapRequired: false });
		},
		runBootstrap,
	};
}

export function redactOperationsValue(value: string): string {
	return /postgres(?:ql)?:\/\/|:\/\/|token|secret|password/i.test(value)
		? "[redacted]"
		: value;
}

export function hostSourcePreflight(root: string, commit: string): void {
	assertSourcePreflight({
		root,
		executingRoot: realpathSync(join(import.meta.dir, "..")),
		commit,
		bunVersion: Bun.version,
		environment: process.env,
		stat: statSync,
		exists: existsSync,
		read: (path) => readFileSync(path, "utf8"),
		entries: (path) => readdirSync(path, { encoding: "utf8", recursive: true }),
		git: (args) => {
			const child = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				env: {},
			});
			if (child.exitCode !== 0) throw new Error("host.source_git_invalid");
			return new TextDecoder().decode(child.stdout);
		},
	});
}

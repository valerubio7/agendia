export const releaseRuntimeCommands = [
	"web",
	"api",
	"whatsapp-manager",
	"message-worker",
] as const;

type ReleaseRuntimeCommand = (typeof releaseRuntimeCommands)[number];

export interface ReadonlyTmpfsMount {
	destination: string;
	uid: 10001;
	gid: 10001;
	mode: "1777" | "0750";
}

export interface ReadonlyRuntimePlan {
	readOnlyRoot: true;
	database: "ephemeral-postgresql";
	providerEgress: false;
	writable: readonly string[];
	tmpfs: readonly ReadonlyTmpfsMount[];
	deniedWrites: readonly ["/opt/agendia", "/etc", "/sibling"];
	restartIndependent: true;
}

const tmpfs = (servicePath: string): readonly ReadonlyTmpfsMount[] => [
	{ destination: "/tmp", uid: 10001, gid: 10001, mode: "1777" },
	{ destination: servicePath, uid: 10001, gid: 10001, mode: "0750" },
];

export const readonlyRuntimePlans: Record<
	ReleaseRuntimeCommand,
	ReadonlyRuntimePlan
> = {
	web: {
		readOnlyRoot: true,
		database: "ephemeral-postgresql",
		providerEgress: false,
		writable: ["/tmp", "/run/agendia/web", "/opt/agendia/web/.next/cache"],
		tmpfs: [
			...tmpfs("/run/agendia/web"),
			{
				destination: "/opt/agendia/web/.next/cache",
				uid: 10001,
				gid: 10001,
				mode: "0750",
			},
		],
		deniedWrites: ["/opt/agendia", "/etc", "/sibling"],
		restartIndependent: true,
	},
	api: {
		readOnlyRoot: true,
		database: "ephemeral-postgresql",
		providerEgress: false,
		writable: ["/tmp", "/run/agendia/api"],
		tmpfs: tmpfs("/run/agendia/api"),
		deniedWrites: ["/opt/agendia", "/etc", "/sibling"],
		restartIndependent: true,
	},
	"whatsapp-manager": {
		readOnlyRoot: true,
		database: "ephemeral-postgresql",
		providerEgress: false,
		writable: ["/tmp", "/run/agendia/whatsapp-manager"],
		tmpfs: tmpfs("/run/agendia/whatsapp-manager"),
		deniedWrites: ["/opt/agendia", "/etc", "/sibling"],
		restartIndependent: true,
	},
	"message-worker": {
		readOnlyRoot: true,
		database: "ephemeral-postgresql",
		providerEgress: false,
		writable: ["/tmp", "/run/agendia/message-worker"],
		tmpfs: tmpfs("/run/agendia/message-worker"),
		deniedWrites: ["/opt/agendia", "/etc", "/sibling"],
		restartIndependent: true,
	},
};

export function readonlyDockerRunArguments(
	command: ReleaseRuntimeCommand,
): string[] {
	return [
		"--read-only",
		...readonlyRuntimePlans[command].tmpfs.flatMap((mount) => [
			"--tmpfs",
			`${mount.destination}:rw,nosuid,nodev,noexec,uid=${mount.uid},gid=${mount.gid},mode=${mount.mode}`,
		]),
	];
}

export function assertReadonlyRuntime(input: {
	command: ReleaseRuntimeCommand;
	mounts: readonly string[];
	writable: readonly string[];
}): void {
	const plan = readonlyRuntimePlans[input.command];
	for (const mount of input.mounts)
		if (!plan.writable.includes(mount))
			throw new Error(`undeclared writable mount: ${mount}`);
	for (const path of input.writable)
		if (
			plan.deniedWrites.includes(path as "/opt/agendia" | "/etc" | "/sibling")
		)
			throw new Error(`forbidden writable path: ${path}`);
	for (const path of input.writable)
		if (!plan.writable.includes(path))
			throw new Error(`undeclared writable path: ${path}`);
}

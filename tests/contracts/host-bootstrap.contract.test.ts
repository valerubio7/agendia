import { describe, expect, test } from "bun:test";
import {
	bootstrapSecretPath,
	readBootstrapSecret,
	unlinkBootstrapSecret,
} from "../../scripts/host-deployment-runtime.ts";

const sentinel = "slice5-admin-secret-sentinel";
type Details = {
	uid: number;
	gid: number;
	mode: number;
	nlink: number;
	ino: number;
	file: boolean;
	directory: boolean;
};

const directory = (mode: number): Details => ({
	uid: 0,
	gid: 0,
	mode,
	nlink: 1,
	ino: 1,
	file: false,
	directory: true,
});

function filesystem(
	overrides: Partial<Details & { mountinfo: string; password: string }> = {},
) {
	let secret: Details = {
		uid: 0,
		gid: 0,
		mode: 0o100600,
		nlink: 1,
		ino: 42,
		file: true,
		directory: false,
		...overrides,
	};
	const directories = new Map<string, Details>([
		["/run", directory(0o40755)],
		["/run/agendia", directory(0o40700)],
		["/run/agendia/staging", directory(0o40700)],
		["/run/agendia/staging/bootstrap", directory(0o40700)],
	]);
	let descriptor = { ...secret };
	let unlinked = false;
	const path = bootstrapSecretPath("staging");
	return {
		filesystem: {
			statfs: () => ({ type: 0x01021994 }),
			mountinfo: () =>
				overrides.mountinfo ??
				"36 25 0:32 / /run/agendia/staging/bootstrap rw - tmpfs tmpfs rw",
			lstat: (candidate: string) => {
				const details =
					candidate === path ? secret : directories.get(candidate);
				if (!details) throw new Error("missing");
				return {
					...details,
					isFile: () => details.file,
					isDirectory: () => details.directory,
				};
			},
			readNoFollow: () => ({
				password: overrides.password ?? sentinel,
				inode: descriptor.ino,
				stat: {
					...descriptor,
					isFile: () => descriptor.file,
					isDirectory: () => descriptor.directory,
				},
			}),
			unlink: () => {
				unlinked = true;
			},
		},
		replace: (next: Partial<Details>) => {
			secret = { ...secret, ...next };
		},
		replaceDescriptor: (next: Partial<Details>) => {
			descriptor = { ...descriptor, ...next };
		},
		replaceDirectory: (candidate: string, next: Partial<Details>) => {
			const existing = directories.get(candidate);
			if (!existing) throw new Error("unknown directory");
			directories.set(candidate, { ...existing, ...next });
		},
		wasUnlinked: () => unlinked,
	};
}

describe("root-only first-admin bootstrap secret", () => {
	test("RED: accepts only the fixed tmpfs file after no-follow root mode, link, and inode checks", () => {
		expect(bootstrapSecretPath("staging")).toBe(
			"/run/agendia/staging/bootstrap/admin-password",
		);
		expect(bootstrapSecretPath("production")).toBe(
			"/run/agendia/production/bootstrap/admin-password",
		);
		const fake = filesystem();
		expect(readBootstrapSecret("staging", fake.filesystem)).toEqual({
			inode: 42,
			password: sentinel,
			path: "/run/agendia/staging/bootstrap/admin-password",
		});
		for (const [override, code] of [
			[{ uid: 1000 }, "host.bootstrap_secret_owner_invalid"],
			[{ mode: 0o100640 }, "host.bootstrap_secret_mode_invalid"],
			[{ mode: 0o104600 }, "host.bootstrap_secret_mode_invalid"],
			[{ nlink: 2 }, "host.bootstrap_secret_link_invalid"],
			[{ file: false }, "host.bootstrap_secret_type_invalid"],
			[
				{
					mountinfo:
						"36 25 0:32 / /run/agendia/staging/bootstrap rw - ext4 /dev/vda rw",
				},
				"host.bootstrap_secret_tmpfs_invalid",
			],
		] as const)
			expect(() =>
				readBootstrapSecret("staging", filesystem(override).filesystem),
			).toThrow(code);
	});

	test("RED: rejects every root-only directory ancestor when its type, owner, or mode drifts", () => {
		for (const [path, override] of [
			["/run", { mode: 0o40775 }],
			["/run/agendia", { uid: 1000 }],
			["/run/agendia/staging", { mode: 0o40750 }],
			["/run/agendia/staging/bootstrap", { mode: 0o42700 }],
			["/run/agendia/staging/bootstrap", { directory: false }],
		] as const) {
			const fake = filesystem();
			fake.replaceDirectory(path, override);
			expect(() => readBootstrapSecret("staging", fake.filesystem)).toThrow(
				"host.bootstrap_secret_parent_invalid",
			);
		}
	});

	test("RED: revalidates descriptor metadata and the pathname after opening without following links", () => {
		for (const [descriptor, code] of [
			[{ ino: 99 }, "host.bootstrap_secret_inode_invalid"],
			[{ uid: 1000 }, "host.bootstrap_secret_owner_invalid"],
			[{ mode: 0o100640 }, "host.bootstrap_secret_mode_invalid"],
			[{ nlink: 2 }, "host.bootstrap_secret_link_invalid"],
			[{ file: false }, "host.bootstrap_secret_type_invalid"],
		] as const) {
			const fake = filesystem();
			fake.replaceDescriptor(descriptor);
			expect(() => readBootstrapSecret("staging", fake.filesystem)).toThrow(
				code,
			);
		}
		const replaced = filesystem();
		const original = readBootstrapSecret("staging", replaced.filesystem);
		replaced.replace({ ino: 99 });
		expect(() => unlinkBootstrapSecret(original, replaced.filesystem)).toThrow(
			"host.bootstrap_secret_inode_invalid",
		);
	});

	test("RED: never unlinks a caller-substituted path outside the fixed secret location", () => {
		const fake = filesystem();
		const secret = readBootstrapSecret("staging", fake.filesystem);
		expect(() =>
			unlinkBootstrapSecret(
				{ ...secret, path: "/run/agendia/staging/bootstrap/substitute" },
				fake.filesystem,
			),
		).toThrow("host.bootstrap_secret_path_invalid");
		expect(fake.wasUnlinked()).toBe(false);
	});

	test("TRIANGULATE: unlinks only the same validated inode after a successful structured outcome", () => {
		const fake = filesystem();
		const secret = readBootstrapSecret("staging", fake.filesystem);
		unlinkBootstrapSecret(secret, fake.filesystem);
		expect(fake.wasUnlinked()).toBe(true);

		const replaced = filesystem();
		const original = readBootstrapSecret("staging", replaced.filesystem);
		replaced.replace({ ino: 99 });
		expect(() => unlinkBootstrapSecret(original, replaced.filesystem)).toThrow(
			"host.bootstrap_secret_inode_invalid",
		);
		expect(replaced.wasUnlinked()).toBe(false);
	});
});

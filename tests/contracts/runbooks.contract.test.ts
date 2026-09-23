import { describe, expect, test } from "bun:test";

const runbooks = [
	"host-provisioning",
	"deploy",
	"staging-window",
	"backup-restore",
	"rollback",
	"disaster-recovery",
	"host-health",
] as const;

async function readRunbook(name: (typeof runbooks)[number]) {
	return Bun.file(`docs/runbooks/${name}.md`).text();
}

const guidanceSections = [
	"## Precheck",
	"## Proposed command",
	"## Verification",
	"## Rollback",
];

describe("operational runbooks", () => {
	test("provide bounded precheck-to-rollback guidance without unsafe ingress", async () => {
		for (const name of runbooks) {
			const content = await readRunbook(name);
			for (const section of guidanceSections)
				expect(content).toContain(section);
		}

		const allRunbooks = (await Promise.all(runbooks.map(readRunbook))).join(
			"\n",
		);
		expect(allRunbooks).toContain("inbound port forwarding is prohibited");
		expect(allRunbooks).not.toMatch(/ssh\s+-[LRD]/i);
		expect(allRunbooks).not.toMatch(/ports:\s*\n?\s*-\s*["']?\d+:/i);
	});

	test("links bounded sections to real repository artifacts and commands", async () => {
		const documents = await Promise.all(runbooks.map(readRunbook));
		for (const content of documents) {
			const positions = guidanceSections.map((section) =>
				content.indexOf(section),
			);
			expect(positions.every((position) => position >= 0)).toBe(true);
			expect(positions).toEqual(
				[...positions].sort((left, right) => left - right),
			);
			for (let index = 0; index < positions.length; index++) {
				const end = positions[index + 1] ?? content.length;
				expect(
					content.slice(positions[index], end).split("\n").length,
				).toBeLessThanOrEqual(16);
			}
		}

		const [deploy, staging, backup, rollback, recovery, health] =
			await Promise.all([
				readRunbook("deploy"),
				readRunbook("staging-window"),
				readRunbook("backup-restore"),
				readRunbook("rollback"),
				readRunbook("disaster-recovery"),
				readRunbook("host-health"),
			]);
		for (const content of [deploy, staging, rollback, recovery])
			expect(content).toContain("scripts/deployctl.ts");
		expect(await Bun.file("scripts/deployctl.ts").exists()).toBe(true);
		expect(backup).toContain("agendia-backup.service");
		expect(
			await Bun.file("deploy/systemd/agendia-backup.service").exists(),
		).toBe(true);
		expect(backup).toContain("bun run backup:drill");
		expect(health).not.toContain("sudo agendia-host-health");
	});

	test("links an exact, fail-closed pinned-source pre-import guard", async () => {
		const deploy = await readRunbook("deploy");
		const guardPath = "docs/runbooks/deploy-source-preflight.md";
		expect(deploy).toContain(
			"[pinned source pre-import guard](deploy-source-preflight.md)",
		);
		expect(await Bun.file(guardPath).exists()).toBe(true);
		const guard = await Bun.file(guardPath).text();
		expect(guard).toContain("sudo env -i PATH=/usr/bin:/bin sh -ceu '");
		expect(guard).toContain(
			'test -z "$(git status --porcelain=v1 --untracked-files=all)"',
		);
		for (const path of [
			"node_modules/",
			"apps/api/node_modules/",
			"apps/message-worker/node_modules/",
			"apps/web/node_modules/",
			"apps/whatsapp-manager/node_modules/",
			"packages/ai-deepseek/node_modules/",
			"packages/whatsapp-baileys/node_modules/",
		])
			expect(guard).toContain(`"!! ${path}"`);
		const expectedEntries = guard.match(/"!! [^"\n]+"/g) ?? [];
		expect(expectedEntries).toHaveLength(7);
		expect(
			expectedEntries.every((entry) => entry.endsWith('node_modules/"')),
		).toBe(true);
		expect(guard).not.toMatch(/"!! [^"\n]*[?*][^"\n]*"/);
		expect(guard).toContain(
			"actual=$(git status --porcelain=v1 --ignored --untracked-files=all | sort)",
		);
		expect(guard).toContain('test "$actual" = "$expected"');
		expect(guard).toContain(
			'unsafe=$(find -L "$r" -xdev \\( ! -user root -o -perm /022 \\) -print -quit)',
		);
		expect(guard).toContain('test -z "$unsafe"');
		expect(guard).not.toMatch(/!\s*find[^\n]*\|\s*grep/);
	});

	test("rejects unsafe operational fiction and keeps the runbook semantics separate", async () => {
		const [deploy, backup, rollback, recovery] = await Promise.all([
			readRunbook("deploy"),
			readRunbook("backup-restore"),
			readRunbook("rollback"),
			readRunbook("disaster-recovery"),
		]);
		for (const content of [deploy, rollback, recovery]) {
			expect(content).not.toMatch(/deployctl\s+(?:apply|rollback)/i);
			expect(content).not.toMatch(/--release\s+[^\s`]*:(?!.*@sha256)/i);
			expect(content).toMatch(/tag|rebuild/i);
		}
		expect(backup).not.toMatch(
			/agendia-backup-production\.service|agendia-restore-drill/i,
		);
		for (const content of [backup, recovery])
			expect(content).not.toMatch(/rm -rf|down[^\n]*--volumes/i);
		expect(backup).toContain("does not replace production data");
		expect(rollback).toContain("does not restore PostgreSQL data or schema");
		expect(recovery).toContain("does not provide a production restore command");
		expect(deploy).toContain("not configured as active controls in SOLO PILOT");
	});

	test("keeps immutable promotion, application rollback, data recovery, and host reconstruction separate", async () => {
		const [deploy, rollback, recovery] = await Promise.all([
			readRunbook("deploy"),
			readRunbook("rollback"),
			readRunbook("disaster-recovery"),
		]);

		expect(deploy).toContain("`@sha256`");
		expect(deploy).toContain("universal-image");
		expect(deploy).toContain("release-set");
		expect(rollback).toContain("## Application rollback");
		expect(rollback).toContain("does not restore PostgreSQL data or schema");
		expect(rollback).toContain("backup-restore.md");
		expect(recovery).toContain("## Data recovery");
		expect(recovery).toContain("## Full host reconstruction");
	});

	test("documents capacity, governance modes, and human-owned external gates", async () => {
		const [staging, deploy, host] = await Promise.all([
			readRunbook("staging-window"),
			readRunbook("deploy"),
			readRunbook("host-provisioning"),
		]);

		expect(staging).toContain("production has priority");
		expect(staging).toContain(
			"migration, restore, maintenance, backlog, build, or test",
		);
		expect(deploy).toContain("SOLO PILOT");
		expect(deploy).toContain("MULTI-MAINTAINER");
		expect(host).toContain("Human approval required");
		expect(host).toContain("External gates remain deferred");
	});

	test("makes each operational action contingent on an explicit human decision", async () => {
		for (const name of runbooks)
			expect(await readRunbook(name)).toContain("Human approval required");
	});

	test("RED: documents direct pinned-source operation while keeping backup and real-user gates blocked", async () => {
		const [deploy, rollback, host, backup] = await Promise.all([
			readRunbook("deploy"),
			readRunbook("rollback"),
			readRunbook("host-provisioning"),
			readRunbook("backup-restore"),
		]);
		expect(deploy).toContain("/opt/agendia/tools/bun-1.4.0/bin/bun");
		expect(deploy).toContain("gh 2.76.2");
		expect(host).toContain("StrictHostKeyChecking=yes");
		expect(host).toContain("checkout detached");
		expect(rollback).not.toContain("separately reviewed host package");
		expect(rollback).toContain("same digest");
		expect(backup).toContain("disabled");
		expect(backup).toContain("no backup executable");
		for (const content of [deploy, rollback, host, backup])
			expect(content).toMatch(
				/tunnel.*domain.*DNS|backup.*restore|separate identities/i,
			);
	});
});

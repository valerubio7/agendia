import { execFile } from "node:child_process";
import { promisify } from "node:util";
const { expect, test } =
	typeof Bun === "undefined"
		? require("@playwright/test")
		: require("bun:test");

const run = promisify(execFile);
const helper = "tests/e2e/support/release-promotion.ts";

async function simulate(mode = "success") {
	try {
		const { stdout } = await run("bun", ["run", helper, mode], {
			env: {
				...process.env,
				PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
			},
		});
		return JSON.parse(stdout);
	} catch (error) {
		return { error: String((error as { stderr?: string }).stderr ?? error) };
	}
}

test("rejects changed promotion digests before production orchestration", async () => {
	const result = await simulate("changed-digest");
	expect(result.error).toContain("promotion.digest_mismatch");
});

test("promotes one immutable digest through isolated ephemeral staging", async () => {
	const result = await simulate();
	expect(result.evidence.releaseDigest).toBe(`sha256:${"a".repeat(64)}`);
	expect(result.evidence.order).toEqual(["migrate", "queue-init"]);
	expect(result.evidence.readiness).toEqual({
		web: true,
		api: true,
		manager: true,
		worker: true,
	});
	expect(result.evidence.privateSmoke).toBe(true);
	expect(result.productionAfter).toEqual(result.productionBefore);
	expect(
		result.stagingEvents.filter(
			(event: string) => event === "converge:private",
		),
	).toHaveLength(2);
});

test("triangulates fallback release-set resolution and cross-environment rejection", async () => {
	const [fallback, crossed] = await Promise.all([
		simulate("release-set"),
		simulate("cross-resource"),
	]);
	expect(fallback.evidence.artifactKind).toBe("release-set");
	expect(fallback.evidence.releaseDigest).toBe(`sha256:${"a".repeat(64)}`);
	expect(crossed.error).toContain("promotion.cross_environment_resource");
});

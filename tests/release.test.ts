import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
const sha = "a".repeat(40);
const paths = ["", "apps/api", "apps/message-worker", "apps/web", "apps/whatsapp-manager", "packages/ai-deepseek", "packages/auth", "packages/contracts", "packages/db", "packages/domain", "packages/whatsapp-baileys"];
// Execute the actual workflow Bash with isolated fake network/registry/archive tools.
const scripts = [...workflow.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)]
  .map((match) => match[1]!.replace(/^          /gm, ""));
const mock = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename } from "node:path";
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const command = args.join(" ");
const mode = process.env.MODE;
const sha = process.env.RELEASE;
const afterBuild = existsSync("build-complete");
appendFileSync("operations", tool + " " + command + "\\n");
function emit(value) { console.log(JSON.stringify(value)); }
if (tool === "gh" && process.env.PREFLIGHT) {
  const run = {
    id: 123, name: "Publish release", path: ".github/workflows/publish.yml",
    status: mode === "pub-pending" ? "in_progress" : "completed",
    conclusion: mode === "pub-failed" ? "failure" : "success",
    event: mode === "pub-legacy" ? "workflow_run" : mode === "pub-pr" ? "pull_request" : "push",
    head_sha: mode === "pub-sha" ? "b".repeat(40) : sha, head_branch: "unknown-tag-branch",
    display_title: mode === "pub-title" ? "Untrusted title" : "Publish " + sha,
    head_repository: { full_name: mode === "pub-fork" ? "other/repo" : process.env.REPOSITORY }
  };
  if (command.includes("environments/")) emit({ protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1, type: "User", login: "human" } }] }] });
  else if (command.includes("actions/runs/")) emit(run);
  else if (command.includes("publish.yml/runs")) emit({ workflow_runs: [run] });
  else if (command.includes("contents/package.json")) emit({ version: mode === "version" ? "0.1.0" : "0.7.0" });
  else if (command.includes("releases/tags/")) {
    if (mode === "unpublished") process.exit(1);
    emit({ tag_name: "v0.7.0", target_commitish: sha, draft: mode === "draft", prerelease: mode === "prerelease", published_at: "2026-01-01" });
  } else if (command.includes("git/ref/tags/")) emit({ object: { type: "commit", sha: mode === "tag-mismatch" ? "b".repeat(40) : sha } });
  else if (command.includes("compare/")) console.log("ahead");
  else if (command.includes("ci.yml/runs")) emit({ workflow_runs: [{ name: "CI", path: ".github/workflows/ci.yml", event: "push", head_sha: sha, head_branch: "main", status: "completed", conclusion: mode === "ci-failure" ? "failure" : "success", head_repository: { full_name: process.env.REPOSITORY } }] });
  else throw new Error("Unexpected preflight gh: " + command);
} else if (tool === "gh") {
  if (mode === "tag-missing" && command.includes("git/ref/tags/")) process.exit(1);
  if (command.includes("git/ref/tags/")) {
    if (afterBuild && mode === "final-missing") process.exit(1);
    if (afterBuild && mode === "final-unknown") process.exit(7);
    if (afterBuild && mode === "final-malformed") emit({ object: {} });
    else emit({ object: { type: mode.startsWith("annotated") ? "tag" : "commit", sha: mode === "tag-mismatch" || (afterBuild && mode === "final-drift") ? "b".repeat(40) : sha } });
  } else if (command.includes("git/tags/")) {
    if (afterBuild && mode === "annotated-final-unknown") process.exit(7);
    if (afterBuild && mode === "annotated-final-malformed") emit({ object: {} });
    else emit({ object: { type: "commit", sha: mode === "annotated-mismatch" || (afterBuild && mode === "annotated-final-drift") ? "b".repeat(40) : sha } });
  } else if (command.includes("compare/")) {
    emit({ status: mode === "ancestry" ? "diverged" : mode === "identical" ? "identical" : "ahead" });
  } else if (command.includes("actions/workflows/ci.yml/runs")) {
    const run = {
      name: "CI", path: ".github/workflows/ci.yml",
      head_sha: mode === "ci-sha" ? "b".repeat(40) : sha, head_branch: "main",
      event: mode === "ci-pr" ? "pull_request" : "push",
      status: mode === "ci-pending" ? "in_progress" : "completed",
      conclusion: ["ci-failure", "ci-rerun"].includes(mode) ? "failure" : "success",
      head_repository: { full_name: mode === "ci-fork" ? "other/repo" : process.env.REPOSITORY }
    };
    emit(mode === "ci-unknown" ? {} : { workflow_runs: mode === "ci-empty" ? [] : mode === "ci-rerun" ? [run, { ...run, conclusion: "success" }] : [run] });
  } else if (command.includes("releases/tags/")) {
    if (["release-exists", "draft", "prerelease"].includes(mode)) {
      emit({ id: 1, draft: mode === "draft", prerelease: mode === "prerelease" });
    } else {
      if (mode === "api-network") process.exit(7);
      console.log("HTTP/2 " + (mode === "api-403" ? "403" : mode === "api-500" ? "500" : "404") + "\\n");
      emit({ message: mode === "api-unknown" ? "Unknown" : "Not Found" });
      process.exit(1);
    }
  } else if (command.includes("tarball/")) console.log("mock archive");
  else if (command.startsWith("release create")) process.exit(0);
  else throw new Error("Unexpected gh: " + command);
} else if (tool === "curl") {
  if (mode === "network") process.exit(7);
  if (command.includes("/token?")) emit({ token: "fake-registry-token" });
  else {
    const output = args[args.indexOf("-o") + 1];
    writeFileSync(output, JSON.stringify({ errors: [{ code: mode === "registry-unknown" ? "UNKNOWN" : "MANIFEST_UNKNOWN" }] }));
    console.log(mode === "image-exists" || (mode === "alias-exists" && command.endsWith("v0.7.0")) ? "200" : mode === "registry-403" ? "403" : mode === "registry-500" ? "500" : "404");
  }
} else if (tool === "tar") {
  for (const path of ${JSON.stringify(paths)}) {
    mkdirSync("source/" + path, { recursive: true });
    const conflict = (mode === "version" && path === "apps/api") || (mode === "root-version" && path === "");
    writeFileSync("source/" + path + "/package.json", JSON.stringify({ version: conflict ? "0.1.0" : "0.7.0" }));
  }
  mkdirSync("source/docs/releases", { recursive: true });
  writeFileSync("source/docs/releases/v0.7.0.md", mode === "notes-missing" ? "" : "Notas pendientes de publicación.");
} else if (tool === "docker") {
  if (args[0] === "build") writeFileSync("build-complete", "built validated SHA");
  if (mode === "image-failure" && args[0] === "push") process.exit(1);
  if (args[0] === "buildx") console.log("sha256:" + (mode === "digest" && command.includes(":v0.7.0") ? "b" : "a").repeat(64));
  if (args[0] === "inspect") console.log(mode === "revision" ? "wrong" : sha);
} else throw new Error("Unexpected tool: " + tool);
`;

function run(mode = "", event = "push", ref = "refs/tags/v0.7.0", preflight = false, publisherRun = "123") {
  const cwd = mkdtempSync(join(tmpdir(), "agendia-release-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  for (const tool of ["gh", "curl", "docker", "tar"]) {
    writeFileSync(join(bin, tool), mock);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(cwd, "operations"), "");
  const result = Bun.spawnSync(["bash", "-c", preflight ? readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8").match(/        run: \|\n((?:          .*\n|\n)+)/)![1]!.replace(/^          /gm, "") : scripts.join("\n")], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: cwd, MODE: mode, RELEASE: sha,
      REPOSITORY: "valerubio7/agendia", PREFLIGHT: preflight ? "1" : "", PUBLISHER_RUN: publisherRun, ACTOR: "fake", GH_TOKEN: "fake", EVENT: event, REF: ref },
  });
  return { code: result.exitCode, log: readFileSync(join(cwd, "operations"), "utf8"), error: result.stderr.toString() };
}

test("publisher accepts lightweight and annotated stable tags after exact main CI", () => {
  expect(workflow).toContain("run-name: Publish ${{ github.sha }}");
  expect(workflow).toContain("  push:\n    tags: ['v*']");
  expect(workflow).not.toMatch(/workflow_run:|pull_request:|branches:/);
  expect(scripts.length).toBe(3);
  for (const mode of ["", "annotated", "identical"]) {
    const result = run(mode);
    expect(result.error).toBe("");
    expect(result.code).toBe(0);
    const order = ["actions/workflows/ci.yml/runs", "tarball/", "docker login", "docker build",
      `docker push ghcr.io/valerubio7/agendia:${sha}`, "docker push ghcr.io/valerubio7/agendia:v0.7.0",
      "docker buildx imagetools inspect", "docker inspect", "gh release create v0.7.0"];
    let previous = -1;
    for (const entry of order) {
      const position = result.log.indexOf(entry);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(result.log).toContain("org.opencontainers.image.version=0.7.0");
    expect(result.log).toContain(`org.opencontainers.image.revision=${sha}`);
    expect(result.log).toContain("org.opencontainers.image.source=https://github.com/valerubio7/agendia");
    expect(result.log.match(/docker buildx imagetools inspect/g)).toHaveLength(2);
    expect(result.log).toContain("--generate-notes --draft=false --prerelease=false --latest=false");
    expect(result.log).toContain(`--target ${sha}`);
    expect(result.log).not.toContain(":latest");
    expect(result.log.match(/git\/ref\/tags\/v0\.7\.0/g)).toHaveLength(2);
    const finalTagRead = result.log.lastIndexOf("gh api repos/valerubio7/agendia/git/ref/tags/");
    expect(finalTagRead).toBeGreaterThan(result.log.indexOf("docker inspect"));
    expect(finalTagRead).toBeLessThan(result.log.indexOf("gh release create"));
    if (mode === "annotated") expect(result.log.match(/gh api .*\/git\/tags\//g)).toHaveLength(2);
  }
});

for (const [event, ref] of [["push", "refs/heads/main"], ["pull_request", "refs/tags/v0.7.0"], ["push", "refs/tags/v0.7.0-beta"], ["push", "refs/tags/v00.7.0"]]) {
  test(`non-release event rejected: ${event} ${ref}`, () => {
    const result = run("", event, ref);
    expect(result.code).not.toBe(0);
    expect(result.log).toBe("");
  });
}

const rejections = ["tag-missing", "tag-mismatch", "annotated-mismatch", "ancestry", "ci-sha", "ci-pr", "ci-fork", "ci-pending", "ci-failure", "ci-unknown", "ci-empty", "ci-rerun", "release-exists", "draft", "prerelease", "api-403", "api-500", "api-network", "api-unknown", "network", "image-exists", "alias-exists", "registry-403", "registry-500", "registry-unknown", "version", "root-version", "notes-missing", "image-failure", "digest", "revision"];
for (const mode of rejections) {
  test(`publisher fails closed: ${mode}`, () => {
    const result = run(mode);
    expect(result.code).not.toBe(0);
    expect(result.log).not.toContain("gh release create");
    if (!["image-failure", "digest", "revision"].includes(mode)) expect(result.log).not.toContain("docker login");
  });
}

for (const mode of ["final-drift", "annotated-final-drift", "final-missing", "final-unknown", "final-malformed", "annotated-final-unknown", "annotated-final-malformed"]) {
  test(`tag binding after build fails closed: ${mode}`, () => {
    const result = run(mode);
    expect(result.log).toContain("docker inspect");
    expect(result.log.match(/git\/ref\/tags\/v0\.7\.0/g)).toHaveLength(2);
    expect(result.log.lastIndexOf("gh api repos/valerubio7/agendia/git/ref/tags/")).toBeGreaterThan(result.log.indexOf("docker inspect"));
    expect(result.log).not.toContain("gh release create");
    expect(result.code).not.toBe(0);
  });
}

test("automatic preflight selects upstream SHA and verifies stable release before protected job", () => {
  const result = run("", "push", "", true);
  expect(result.code).toBe(0);
  expect(result.log).toContain("actions/runs/123");
  expect(result.log).toContain(`contents/package.json?ref=${sha}`);
  expect(result.log).toContain("git/ref/tags/v0.7.0");
  expect(result.log).toContain(`docker pull ghcr.io/valerubio7/agendia@sha256:${"a".repeat(64)}`);
  const deploy = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  expect(deploy).toContain("  deploy:\n    needs: preflight\n    environment: production");
  expect(deploy.split("  deploy:")[0]).not.toContain("secrets.");
  const auto = readFileSync(join(root, ".github/workflows/auto-deploy.yml"), "utf8");
  expect(auto).toContain("release: ${{ github.event.workflow_run.head_sha }}");
  expect(auto).not.toContain("secrets: inherit");
  for (const guard of ["workflows: [Publish release]", "types: [completed]", "conclusion == 'success'", "event == 'push'", "head_repository.full_name == github.repository", "uses: ./.github/workflows/deploy.yml"]) expect(auto).toContain(guard);
});
test("manual new publisher uses source SHA without relying on tag head_branch", () => {
  expect(run("", "push", "", true, "").code).toBe(0);
  expect(run("pub-fork", "push", "", true, "").code).not.toBe(0);
});
for (const mode of ["pub-failed", "pub-pending", "pub-pr", "pub-title", "pub-fork", "pub-sha", "pub-legacy", "ci-failure", "draft", "prerelease", "unpublished", "version", "tag-mismatch", "digest", "revision"]) {
  test(`automatic preflight fails closed: ${mode}`, () => {
    const result = run(mode, "push", "", true);
    expect(result.code).not.toBe(0);
    expect(result.log).not.toMatch(/ssh |release create/);
  });
}

test("all eleven manifests and lock workspace versions agree", () => {
  const lock = readFileSync(join(root, "bun.lock"), "utf8");
  const workspaceSection = lock.split('  "packages": {')[0]!;
  expect(workspaceSection.match(/"version": "0.7.0"/g)).toHaveLength(11);
  for (const path of paths) {
    expect(JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")).version).toBe("0.7.0");
  }
});

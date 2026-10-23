import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const command = args.join(" ");
const mode = process.env.MODE;
const sha = process.env.RELEASE;
appendFileSync("operations", tool + " " + command + "\\n");
function emit(value) { console.log(JSON.stringify(value)); }
if (tool === "gh") {
  if (mode === "tag-missing" && command.includes("git/ref/tags/")) process.exit(1);
  // A second ref/tags read is the pre-publication recheck; drift modes fail there.
  if (command.includes("git/ref/tags/")) {
    const reads = existsSync("ref-reads") ? Number(readFileSync("ref-reads", "utf8")) + 1 : 1;
    writeFileSync("ref-reads", String(reads));
    const recheck = reads >= 2;
    const annotation = mode.startsWith("annotated");
    if (recheck && mode === "final-missing") process.exit(1);
    if (recheck && mode === "final-unknown") process.exit(7);
    if (recheck && mode === "final-malformed") emit({ object: {} });
    else emit({ object: {
      type: annotation ? "tag" : "commit",
      sha: mode === "tag-mismatch" || (recheck && ["final-drift", "annotated-final-drift"].includes(mode)) ? "b".repeat(40) : sha,
    } });
  } else if (command.includes("git/tags/")) {
    const reads = existsSync("tag-reads") ? Number(readFileSync("tag-reads", "utf8")) + 1 : 1;
    writeFileSync("tag-reads", String(reads));
    const recheck = reads >= 2;
    if (recheck && mode === "annotated-final-unknown") process.exit(7);
    if (recheck && mode === "annotated-final-malformed") emit({ object: {} });
    else emit({ object: { type: "commit", sha: mode === "annotated-mismatch" || (recheck && mode === "annotated-final-drift") ? "b".repeat(40) : sha } });
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
  else if (command.startsWith("release create")) {
    writeFileSync("release-args", JSON.stringify(args));
    process.exit(0);
  }
  else throw new Error("Unexpected gh: " + command);
} else if (tool === "tar") {
  for (const path of ${JSON.stringify(paths)}) {
    mkdirSync("source/" + path, { recursive: true });
    const conflict = (mode === "version" && path === "apps/api") || (mode === "root-version" && path === "");
    writeFileSync("source/" + path + "/package.json", JSON.stringify({ version: conflict ? "0.1.0" : "0.7.0" }));
  }
  if (mode !== "notes-missing") {
    mkdirSync("source/docs/releases", { recursive: true });
    writeFileSync("source/docs/releases/v0.7.0.md", "Notas pendientes de publicación.");
  }
} else if (tool === "docker") {
  // No docker operations remain in publish.yml; never reached.
  process.exit(1);
} else throw new Error("Unexpected tool: " + tool);
`;

function run(mode = "", event = "push", ref = "refs/tags/v0.7.0") {
  const cwd = mkdtempSync(join(tmpdir(), "agendia-release-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  for (const tool of ["gh", "tar"]) {
    writeFileSync(join(bin, tool), mock);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(cwd, "operations"), "");
  const result = Bun.spawnSync(["bash", "-c", scripts.join("\n")], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: cwd, MODE: mode, RELEASE: sha,
      REPOSITORY: "valerubio7/agendia", ACTOR: "fake", GH_TOKEN: "fake", EVENT: event, REF: ref },
  });
  return { code: result.exitCode, log: readFileSync(join(cwd, "operations"), "utf8"), error: result.stderr.toString(),
    notesExist: existsSync(join(cwd, "source/docs/releases/v0.7.0.md")),
    releaseArgs: existsSync(join(cwd, "release-args")) ? JSON.parse(readFileSync(join(cwd, "release-args"), "utf8")) as string[] : [],
  };
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
    // Chronology: CI gate, source, release-absence check, tag re-read (assertion below), create.
    const order = ["actions/workflows/ci.yml/runs", "tarball/", "gh api --include repos/valerubio7/agendia/releases/tags/v0.7.0", "gh release create v0.7.0"];
    let previous = -1;
    for (const entry of order) {
      const position = result.log.indexOf(entry);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(result.log).toContain("--generate-notes --draft=false --prerelease=false --latest=false");
    expect(result.log).toContain(`--target ${sha}`);
    expect(result.log).not.toContain("docker");
    expect(result.log.match(/git\/ref\/tags\/v0\.7\.0/g)).toHaveLength(2);
    const finalTagRead = result.log.lastIndexOf("gh api repos/valerubio7/agendia/git/ref/tags/");
    expect(finalTagRead).toBeLessThan(result.log.indexOf("gh release create"));
    if (mode === "annotated") expect(result.log.match(/gh api .*\/git\/tags\//g)).toHaveLength(2);
  }
});

test("publisher creates stable Release without archived notes", () => {
  const result = run("notes-missing");
  expect(result.code).toBe(0);
  expect(result.notesExist).toBe(false);
  expect(result.releaseArgs[result.releaseArgs.indexOf("--notes") + 1]).toBe(
    "Agendia v0.7.0: versión estable de la instantánea completa validada de main. Esta publicación no anuncia un despliegue en producción.",
  );
  expect(result.releaseArgs).toContain("--notes");
  expect(result.releaseArgs).toContain("--generate-notes");
  expect(result.releaseArgs).not.toContain("--notes-file");
  const finalTagRead = result.log.lastIndexOf("gh api repos/valerubio7/agendia/git/ref/tags/");
  expect(finalTagRead).toBeGreaterThan(-1);
  expect(result.log.indexOf("gh release create")).toBeGreaterThan(finalTagRead);
});

for (const [event, ref] of [["push", "refs/heads/main"], ["pull_request", "refs/tags/v0.7.0"], ["push", "refs/tags/v0.7.0-beta"], ["push", "refs/tags/v00.7.0"]]) {
  test(`non-release event rejected: ${event} ${ref}`, () => {
    const result = run("", event, ref);
    expect(result.code).not.toBe(0);
    expect(result.log).toBe("");
  });
}

const rejections = ["tag-missing", "tag-mismatch", "annotated-mismatch", "ancestry", "ci-sha", "ci-pr", "ci-fork", "ci-pending", "ci-failure", "ci-unknown", "ci-empty", "ci-rerun", "release-exists", "draft", "prerelease", "api-403", "api-500", "api-network", "api-unknown", "version", "root-version"];
for (const mode of rejections) {
  test(`publisher fails closed: ${mode}`, () => {
    const result = run(mode);
    expect(result.code).not.toBe(0);
    expect(result.log).not.toContain("gh release create");
    expect(result.log).not.toContain("docker");
  });
}

for (const mode of ["final-drift", "annotated-final-drift", "final-missing", "final-unknown", "final-malformed", "annotated-final-unknown", "annotated-final-malformed"]) {
  test(`tag binding after preflight fails closed: ${mode}`, () => {
    const result = run(mode);
    expect(result.log.match(/git\/ref\/tags\/v0\.7\.0/g)).toHaveLength(2);
    expect(result.log.lastIndexOf("gh api repos/valerubio7/agendia/git/ref/tags/")).toBeLessThan(result.log.indexOf("gh release create v0.7.0") === -1 ? Infinity : result.log.indexOf("gh release create v0.7.0"));
    expect(result.log).not.toContain("gh release create");
    expect(result.code).not.toBe(0);
  });
}

test("all eleven manifests and lock workspace versions agree", () => {
  const lock = readFileSync(join(root, "bun.lock"), "utf8");
  const workspaceSection = lock.split('  "packages": {')[0]!;
  // Bun omits the root version, but not its workspace identity.
  const workspaces = JSON.parse((workspaceSection + "}").replace(/,\s*([}\]])/g, "$1")).workspaces;
  expect(Object.keys(workspaces).sort()).toEqual([...paths].sort());
  expect(workspaceSection.match(/"version": "0.8.0"/g)).toHaveLength(paths.length - 1);
  for (const path of paths) {
    const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
    expect(manifest.version).toBe("0.8.0");
    expect(workspaces[path].name).toBe(manifest.name);
    if (path) expect(workspaces[path].version).toBe(manifest.version);
    else expect(workspaces[path]).not.toHaveProperty("version");
  }
});

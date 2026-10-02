import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sha = "a".repeat(40);
const read = (path: string) => readFileSync(join(root, path), "utf8");

function fixture(mode = "success") {
  const dir = mkdtempSync(join(tmpdir(), "agendia-cd-"));
  const app = join(dir, "app");
  const bin = join(dir, "bin");
  const incoming = join(dir, "incoming");
  mkdirSync(app); mkdirSync(bin); mkdirSync(incoming);
  writeFileSync(join(incoming, "deploy-release.sh"), read("deploy/deploy-release.sh"));
  writeFileSync(join(incoming, "compose.production.yml"), read("compose.production.yml"));
  mkdirSync(join(app, "deploy"));
  writeFileSync(join(app, "deploy/.env.production"), "fixture=true\n");
  writeFileSync(join(app, "compose.production.yml"), read("compose.production.yml"));
  // Mock all Docker operations: these tests never contact a daemon or registry.
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$LOG"
if [[ "$1" == pull ]]; then
  [[ "$MODE" != pull ]] || exit 6
elif [[ "$*" == *"pg_dump"* ]]; then
  [[ "$MODE" != backup ]] || exit 7
  [[ "$MODE" == empty ]] || echo 'database dump'
elif [[ "$*" == *"config --quiet"* ]]; then
  [[ "$MODE" != config ]] || exit 8
elif [[ "$*" == *"run --rm --no-deps migrate"* ]]; then
  [[ "$MODE" != migration ]] || exit 9
elif [[ "$*" == *"run --rm --no-deps provision"* ]]; then
  [[ "$MODE" != provision ]] || exit 9
elif [[ "$*" == *"ps -q"* ]]; then
  echo "container-\${*: -1}"
elif [[ "$1" == image ]]; then
  if [[ "$*" == *revision* ]]; then
    if [[ "$MODE" == revision ]]; then echo invalid; else echo "$SHA"; fi
  else tag="\${*: -1}"; printf '%s@sha256:' "\${tag%:*}"; printf '%064d\\n' 0; fi
elif [[ "$1" == inspect ]]; then
  if [[ "$*" == *State.Health* ]]; then
    if [[ "$MODE" == health ]]; then echo unhealthy; else echo healthy; fi
  elif [[ "$*" == *State.Status* ]]; then
    if [[ "$MODE" == worker && "$*" == *container-worker* ]]; then echo exited; else echo running; fi
  else echo 'sha256:previous'; fi
fi
`);
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o700); chmodSync(join(bin, "sleep"), 0o700);
  const log = join(dir, "docker.log");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, MODE: mode, SHA: sha };
  const args = ["bash", join(incoming, "deploy-release.sh"), sha, "owner/repo", app, "agendia"];
  return { app, log, env, args };
}

function run(mode: string) {
  const f = fixture(mode);
  const result = Bun.spawnSync(f.args, { env: f.env });
  return { ...f, result, logText: readFileSync(f.log, "utf8") };
}

describe("release deployment boundaries", () => {
  test("successful deployment orders pull, backup, stop, migration, provision, health, atomic record", () => {
    const f = run("success");
    expect(f.result.exitCode).toBe(0);
    expect(existsSync(join(f.app, ".env"))).toBe(false);
    expect(readFileSync(join(f.app, "deploy/.env.production"), "utf8")).toBe("fixture=true\n");
    const composeCalls = f.logText.split("\n").filter((line) => line.startsWith("compose "));
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const call of composeCalls) expect(call).toContain(`--env-file ${f.app}/deploy/.env.production -f `);
    const operations = ["pull ghcr.io", "pg_dump", "stop web", "run --rm --no-deps migrate", "run --rm --no-deps provision", "up -d --no-build", "State.Health"];
    let previous = -1;
    for (const operation of operations) {
      const position = f.logText.indexOf(operation);
      expect(position).toBeGreaterThan(previous); previous = position;
    }
    const current = readFileSync(join(f.app, ".release-state"), "utf8").split("\n")[0]!;
    expect(readFileSync(join(current, "images.env"), "utf8")).toContain("@sha256:");
    expect(readFileSync(join(current, "previous-images"), "utf8")).toContain("api=sha256:previous");
    expect(readFileSync(join(current, "previous-compose.yml"), "utf8")).toBe(read("compose.production.yml"));
  });
  for (const mode of ["pull", "revision", "backup", "empty", "config"]) {
    test(`${mode} failure prevents downtime`, () => {
      const f = run(mode);
      expect(f.result.exitCode).not.toBe(0);
      expect(f.logText).not.toContain("stop web");
    });
  }
  for (const mode of ["migration", "provision", "health", "worker"]) {
    test(`${mode} failure preserves last successful release and never rolls back schema`, () => {
      const f = fixture(mode);
      const previous = join(f.app, "releases", "prior");
      mkdirSync(previous, { recursive: true });
      writeFileSync(join(previous, "compose.production.yml"), read("compose.production.yml"));
      const state = `${previous}\nnone\n`;
      writeFileSync(join(f.app, ".release-state"), state);
      const result = Bun.spawnSync(f.args, { env: f.env });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(f.app, ".release-state"), "utf8")).toBe(state);
      const log = readFileSync(f.log, "utf8");
      if (mode === "migration" || mode === "provision") expect(log).not.toContain("up -d");
      expect(log).not.toContain("down");
      expect(result.stderr.toString()).toContain("no automatic schema rollback");
    });
  }
  test("host lock rejects concurrent deployment before Docker", async () => {
    const f = fixture();
    const holder = Bun.spawn(["flock", join(f.app, ".deploy.lock"), "bash", "-c", "echo locked; read -r release"], { stdin: "pipe", stdout: "pipe" });
    await holder.stdout.getReader().read();
    const result = Bun.spawnSync(f.args, { env: f.env });
    holder.stdin.write("release\n"); holder.stdin.end();
    await holder.exited;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("host lock");
    expect(existsSync(f.log)).toBe(false);
  });
});

test("publishing gates Docker operations on CD tests from the downloaded release", () => {
  const publish = read(".github/workflows/publish.yml");
  const gate = "      - name: Deployment regressions on validated source\n        working-directory: source\n        run: bun test tests/deployment.test.ts\n";
  expect(publish).toContain(gate);
  const order = ["tar -xzf source.tar.gz -C source", "- name: Set up Bun", gate, "docker login", "docker build", "docker push"];
  let previous = -1;
  for (const operation of order) {
    const position = publish.indexOf(operation);
    expect(position).toBeGreaterThan(previous); previous = position;
  }
  expect(publish).not.toContain("continue-on-error:");
});

test("workflow trust, source matching and SSH policies remain explicit", () => {
  const publish = read(".github/workflows/publish.yml");
  for (const guard of ["workflows: [CI]", "run-name: Publish ${{ github.event.workflow_run.head_sha }}", "types: [completed]", "conclusion == 'success'", "event == 'push'", "head_branch == 'main'", "head_repository.full_name == github.repository", "packages: write", "tarball/$RELEASE"]) expect(publish).toContain(guard);
  const deploy = read(".github/workflows/deploy.yml");
  for (const guard of ["workflow_dispatch:", "github.ref == 'refs/heads/main'", "environment: production", "cancel-in-progress: false", "compare/$RELEASE...main", "ci.yml publish.yml", ".display_title == (\"Publish \" + $sha)", "?ref=$RELEASE", "StrictHostKeyChecking=yes", "BatchMode=yes"]) expect(deploy).toContain(guard);
  expect(deploy).not.toContain("pull_request:");
  expect(deploy).not.toContain("uses:");
  expect(publish.match(/uses: .+/g)).toEqual(["uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2"]);
  expect(publish).toContain("bun-version: 1.4.0");
  expect(read("compose.production.yml")).toContain("${AGENDIA_RUNTIME_IMAGE:-agendia-runtime:local}");
});

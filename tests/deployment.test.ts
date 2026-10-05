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
  else
    tag="\${*: -1}"
    case "$MODE" in
      digest) echo 'ghcr.io/owner/repo@sha256:invalid' ;;
      repository) printf 'ghcr.io/other/repo@sha256:%064d\\n' 0 ;;
      *) printf '%s@sha256:' "\${tag%:*}"; printf '%064d\\n' 0 ;;
    esac
  fi
elif [[ "$1" == inspect ]]; then
  if [[ "$*" == *State.Health* ]]; then
    if [[ "$MODE" == health ]]; then echo unhealthy; else echo healthy; fi
  elif [[ "$*" == *State.Status* ]]; then
    if [[ "$MODE" == worker && "$*" == *container-worker* ]]; then echo exited; else echo running; fi
  else echo "sha256:previous-\${*: -1}"; fi
fi
`);
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o700); chmodSync(join(bin, "sleep"), 0o700);
  const log = join(dir, "docker.log");
  const env = { PATH: `${bin}:${process.env.PATH}`, LOG: log, MODE: mode, SHA: sha };
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
    expect(readFileSync(join(current, "images.env"), "utf8")).toBe(`AGENDIA_IMAGE=ghcr.io/owner/repo@sha256:${"0".repeat(64)}\n`);
    expect(f.logText.split("\n").filter((line) => line.startsWith("pull "))).toEqual([`pull ghcr.io/owner/repo:${sha}`]);
    expect(readFileSync(join(current, "previous-images"), "utf8")).toContain("api=sha256:previous-container-api");
    expect(readFileSync(join(current, "previous-compose.yml"), "utf8")).toBe(read("compose.production.yml"));
  });
  for (const mode of ["pull", "revision", "digest", "repository", "backup", "empty", "config"]) {
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
  for (const format of ["legacy", "unified"]) {
    test(`${format} recovery retains version-matched Compose, saved refs and actual distinct image IDs`, () => {
      const f = fixture();
      const previous = join(f.app, "releases", "prior");
      mkdirSync(previous, { recursive: true });
      const savedCompose = format === "legacy"
        ? read("compose.production.yml")
          .replace("target: application", "target: runtime")
          .replace("${AGENDIA_IMAGE:-agendia:local}", "${AGENDIA_RUNTIME_IMAGE:-agendia-runtime:local}")
          .replace("    working_dir: /app/apps/web", "    image: ${AGENDIA_WEB_IMAGE:-agendia-web:local}\n    working_dir: /app/apps/web")
        : read("compose.production.yml");
      const savedImages = format === "legacy"
        ? "AGENDIA_RUNTIME_IMAGE=sha256:old-api\nAGENDIA_WEB_IMAGE=sha256:old-web\n"
        : "AGENDIA_IMAGE=sha256:old-application\n";
      writeFileSync(join(previous, "compose.production.yml"), savedCompose);
      writeFileSync(join(previous, "images.env"), savedImages);
      writeFileSync(join(f.app, ".release-state"), `${previous}\nnone\n`);
      const result = Bun.spawnSync(f.args, { env: f.env });
      expect(result.exitCode).toBe(0);
      const [current, prior] = readFileSync(join(f.app, ".release-state"), "utf8").split("\n");
      expect(prior).toBe(previous);
      expect(readFileSync(join(current!, "previous-compose.yml"), "utf8")).toBe(savedCompose);
      expect(readFileSync(join(previous, "images.env"), "utf8")).toBe(savedImages);
      expect(readFileSync(join(current!, "previous-images"), "utf8")).toBe(
        "api=sha256:previous-container-api\nweb=sha256:previous-container-web\nworker=sha256:previous-container-worker\nmanager=sha256:previous-container-manager\n",
      );
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

// Execute workflow preflight without ever resolving production secrets or running SSH.
function preflight(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "agendia-preflight-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const workflow = read(".github/workflows/deploy.yml");
  const script = workflow.match(/        run: \|\n((?:          .*\n|\n)+)/)![1]!.replace(/^          /gm, "");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$LOG"
if [[ "$*" == *environments/production* ]]; then
  case "$MODE" in
    forbidden|missing) echo "HTTP $MODE" >&2; exit 1 ;;
    unknown) echo 'null' ;;
    nohuman) echo '{"protection_rules":[{"type":"required_reviewers","reviewers":[]}]}' ;;
    malformed) echo '{}' ;;
    bot) echo '{"protection_rules":[{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":1,"type":"Bot","login":"robot[bot]"}}]}]}' ;;
    none) echo '{"protection_rules":[]}' ;;
    *) echo '{"protection_rules":[{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":1,"type":"User","login":"human"}}]}]}' ;;
  esac
elif [[ "$*" == *compare/* ]]; then echo ahead
elif [[ "$*" == *publish.yml* ]]; then
  echo '{"workflow_runs":[{"name":"Publish release","path":".github/workflows/publish.yml","display_title":"Publish ${sha}","event":"workflow_run","head_branch":"main","head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"completed","conclusion":"success","head_repository":{"full_name":"owner/repo"}}]}'
elif [[ "$*" == *actions/workflows/* ]]; then
  echo '{"workflow_runs":[{"name":"CI","path":".github/workflows/ci.yml","event":"push","head_branch":"main","head_sha":"${sha}","status":"completed","conclusion":"success","head_repository":{"full_name":"owner/repo"}}]}'
else exit 9
fi
`);
  chmodSync(join(bin, "gh"), 0o700);
  const log = join(dir, "calls"); writeFileSync(log, "");
  const result = Bun.spawnSync(["bash", "-c", script], { cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, MODE: mode, RELEASE: sha, REPOSITORY: "owner/repo", PUBLISHER_RUN: "" } });
  return { result, log: readFileSync(log, "utf8") };
}
for (const mode of ["missing", "forbidden", "unknown", "malformed", "none", "nohuman", "bot"]) {
  test(`production preflight rejects ${mode} before source or credential access`, () => {
    const result = preflight(mode);
    expect(result.result.exitCode).not.toBe(0);
    expect(result.log).toContain("environments/production");
    expect(result.log).not.toContain("compare/");
    expect(result.log).not.toContain("contents/");
  });
}

test("legacy manual source proof remains eligible only after human protection", () => {
  expect(preflight("success").result.exitCode).toBe(0);
});

test("application packaging shares one image with explicit web startup and separate PostgreSQL", () => {
  const dockerfile = read("Dockerfile");
  expect(dockerfile).toContain("ENV AGENDIA_API_ORIGIN=http://api:3001\nRUN bun run --cwd apps/web build");
  expect(dockerfile).toContain('FROM web-build AS application\nUSER bun\nWORKDIR /app\nCMD ["bun", "run", "scripts/start-api.ts"]');
  expect(dockerfile).toContain("FROM base AS runtime");
  expect(dockerfile).toContain("FROM application AS web");
  const compose = read("compose.production.yml");
  expect(compose.match(/target: application/g)).toHaveLength(1);
  expect(compose.match(/image: /g)).toHaveLength(2);
  expect(compose).toContain("image: ${AGENDIA_IMAGE:-agendia:local}");
  expect(compose).toContain('working_dir: /app/apps/web\n    command: [bun, --bun, ./node_modules/next/dist/bin/next, start, --hostname, 0.0.0.0, --port, "3000"]');
  expect(compose).toContain("image: postgres:17.9-bookworm");
  expect(compose).toContain("postgres-data:/var/lib/postgresql/data");
  const publish = read(".github/workflows/publish.yml");
  expect(publish).toContain('image="ghcr.io/$namespace:$RELEASE"');
  expect(publish.match(/docker build /g)).toHaveLength(1);
  expect(publish.match(/docker push /g)).toHaveLength(2);
  expect(publish).toContain('docker build --target application --label "org.opencontainers.image.revision=$RELEASE"');
  expect(publish).not.toContain("for target");
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

type Workflow = {
  permissions: Record<string, string>;
  jobs: Record<string, {
    permissions?: Record<string, string>;
    needs?: string;
    environment?: string;
    uses?: string;
    steps: { name: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; run?: string; if?: string; "continue-on-error"?: boolean }[];
  }>;
};
const workflowYaml = (path: string) => Bun.YAML.parse(read(path)) as Workflow;

test("OIDC permission is isolated to protected deploy and propagated by the reusable caller", () => {
  const deploy = workflowYaml(".github/workflows/deploy.yml");
  const caller = workflowYaml(".github/workflows/auto-deploy.yml");
  for (const workflow of [deploy, caller]) {
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read", packages: "read" });
  }
  const preflight = deploy.jobs.preflight!;
  expect(preflight.permissions).toEqual({ contents: "read", actions: "read", packages: "read" });
  expect(preflight.environment).toBeUndefined();
  expect(JSON.stringify(preflight)).not.toMatch(/tailscale|PRODUCTION_|secrets\.|id-token/i);
  for (const step of preflight.steps) {
    expect(step.uses).toBeUndefined();
    expect(step.run).not.toMatch(/^\s*(ssh|scp|tailscale)\s/m);
  }
  const permissions = { contents: "read", actions: "read", packages: "read", "id-token": "write" };
  expect(deploy.jobs.deploy!.permissions).toEqual(permissions);
  expect(caller.jobs.release!.permissions).toEqual(permissions);
  expect(caller.jobs.release!.uses).toBe("./.github/workflows/deploy.yml");
  expect(deploy.jobs.deploy!.needs).toBe("preflight");
  expect(deploy.jobs.deploy!.environment).toBe("production");
});

test("protected deployment validates identity then joins ephemeral Tailnet before pinned SSH", () => {
  const steps = workflowYaml(".github/workflows/deploy.yml").jobs.deploy!.steps;
  const check = steps.findIndex((step) => step.name === "Validate private connection identifiers");
  const network = steps.findIndex((step) => step.uses?.startsWith("tailscale/github-action@"));
  const ssh = steps.findIndex((step) => step.name === "Transfer and execute over pinned SSH");
  expect(check).toBeGreaterThanOrEqual(0);
  expect(network).toBeGreaterThan(check);
  expect(ssh).toBeGreaterThan(network);
  expect(steps[network]!.uses).toBe("tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd");
  expect(steps[network]!.with).toEqual({
    "oauth-client-id": "${{ vars.PRODUCTION_TAILSCALE_CLIENT_ID }}",
    audience: "${{ vars.PRODUCTION_TAILSCALE_AUDIENCE }}",
    tags: "tag:agendia-ci", version: "1.102.4",
    args: "--accept-dns=false --accept-routes=false --ssh=false",
    ping: "${{ vars.PRODUCTION_SSH_HOST }}", "log-mode": "quiet",
  });
  for (const step of steps.slice(0, ssh)) expect(JSON.stringify(step)).not.toContain("secrets.");
  for (const step of steps) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
  }
  expect(JSON.stringify(steps)).not.toMatch(/authkey|oauth-secret|tailscale ssh|StrictHostKeyChecking=no/);
  expect(steps[ssh]!.run).toContain("StrictHostKeyChecking=yes");
});

test("missing federation identifiers or invalid target fail closed without external commands", () => {
  const check = workflowYaml(".github/workflows/deploy.yml").jobs.deploy!.steps
    .find((step) => step.name === "Validate private connection identifiers");
  expect(check).toBeDefined();
  expect(check!.env).toEqual({
    TS_CLIENT_ID: "${{ vars.PRODUCTION_TAILSCALE_CLIENT_ID }}",
    TS_AUDIENCE: "${{ vars.PRODUCTION_TAILSCALE_AUDIENCE }}",
    SSH_HOST: "${{ vars.PRODUCTION_SSH_HOST }}",
  });
  const valid = { TS_CLIENT_ID: "fixture-client", TS_AUDIENCE: "fixture-audience", SSH_HOST: "fixture-host" };
  const cases = [valid, { ...valid, TS_CLIENT_ID: "" }, { ...valid, TS_AUDIENCE: "" },
    { ...valid, SSH_HOST: "" }, { ...valid, SSH_HOST: "host; echo unsafe" }];
  for (const [index, env] of cases.entries()) {
    // Empty PATH and explicit environment prohibit real provider/SSH commands and inherited credentials.
    const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", check!.run!], { env: { PATH: "", ...env } });
    expect(result.exitCode === 0).toBe(index === 0);
  }
});

test("workflow trust, source matching and SSH policies remain explicit", () => {
  const publish = read(".github/workflows/publish.yml");
  for (const guard of ["tags: ['v*']", "run-name: Publish ${{ github.sha }}", "github.event_name == 'push'", '.conclusion == "success"', '.event == "push"', '.head_branch == "main"', '.head_repository.full_name == $repo', "actions: read", "packages: write", "tarball/$RELEASE"]) expect(publish).toContain(guard);
  expect(publish).not.toContain("workflow_run:");
  const deploy = read(".github/workflows/deploy.yml");
  for (const guard of ["workflow_dispatch:", "github.ref == 'refs/heads/main'", "environment: production", "cancel-in-progress: false", "compare/$RELEASE...main", "actions/workflows/ci.yml", ".display_title == (\"Publish \" + $sha)", "?ref=$RELEASE", "StrictHostKeyChecking=yes", "BatchMode=yes"]) expect(deploy).toContain(guard);
  expect(deploy).not.toContain("pull_request:");
  expect(deploy.match(/uses: .+/g)).toEqual(["uses: tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd # v4"]);
  expect(publish.match(/uses: .+/g)).toEqual(["uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2"]);
  expect(publish).toContain("bun-version: 1.4.0");
  expect(read("compose.production.yml")).toContain("${AGENDIA_IMAGE:-agendia:local}");
});

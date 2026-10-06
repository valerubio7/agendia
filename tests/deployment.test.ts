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
  on?: Record<string, { inputs?: Record<string, { description?: string; required?: boolean; default?: boolean; type?: string }> }>;
  jobs: Record<string, {
    permissions?: Record<string, string>;
    needs?: string;
    if?: string;
    environment?: string;
    "runs-on"?: string;
    uses?: string;
    steps: { name: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; run?: string; if?: string; "continue-on-error"?: boolean }[];
  }>;
};
const workflowYaml = (path: string) => Bun.YAML.parse(read(path)) as Workflow;

// In-memory filesystem, process and HTTP boundaries: never launch/download a real CLI.
async function connectionFixture(mode = "success") {
  const absent = () => Object.assign(Error("absent"), { code: "ENOENT" });
  const { connect, cleanup, PIN } = await import("../.github/actions/tailscale-connection/main.mjs");
  const directory = "/runner/agendia-ts-fixture";
  const binary = `${directory}/tailscale_1.102.4_amd64/tailscaled`;
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const logs: string[] = [];
  let alive = false;
  const env = { RUNNER_TEMP: "/runner", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_STATE: "/state",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token?existing=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-bearer", "INPUT_CLIENT-ID": "fixture-client", INPUT_AUDIENCE: "fixture/audience?x=1" };
  const io = {
    async mkdtemp() { files.set(directory, "directory"); return directory; },
    async realpath(path: string) { return path; },
    async chmod(path: string, permission: number) { calls.push(["chmod", path, String(permission)]); },
    async writeFile(path: string, data: string | Uint8Array, options?: unknown) {
      if (path.endsWith("/token")) expect(logs[0]).toBe("::add-mask::fixture-jwt");
      files.set(path, String(data)); calls.push(["write", path, JSON.stringify(options)]);
    },
    async appendFile(path: string, data: string) { files.set(path, (files.get(path) ?? "") + data); },
    async readFile(path: string) { if (!files.has(path)) throw absent(); return files.get(path)!; },
    async lstat(path: string) {
      if (!files.has(path)) throw absent();
      return { uid: 1000, mode: 0o700, isDirectory: () => path === directory,
        isFile: () => path !== directory && !path.endsWith(".sock"),
        isSymbolicLink: () => mode === "symlink" && path === binary,
        isSocket: () => path.endsWith(".sock") };
    },
    async unlink(path: string) { files.delete(path); },
    async rm(path: string) { calls.push(["remove", path]); for (const key of files.keys()) if (key.startsWith(path)) files.delete(key); },
  };
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[0] === "-tzf") return mode === "archive" ? "../foreign\n" : "tailscale_1.102.4_amd64/\ntailscale_1.102.4_amd64/tailscale\ntailscale_1.102.4_amd64/tailscaled\n";
    if (args[0] === "-xzf") {
      files.set(binary, "binary"); files.set(binary.replace(/d$/, ""), "binary"); return "";
    }
    if (args.includes("version")) return mode === "version" ? "1.0.0" : "1.102.4\nfixture-build";
    if (args.includes("up") && mode === "up") throw Error("fixture-jwt private failure");
    if (args.includes("logout") && mode === "logout") throw Error("fixture-jwt private failure");
    if (args.includes("kill")) {
      if (mode === "stop") throw Error("private failure");
      if (mode !== "stubborn" || args.includes("-KILL")) alive = false;
    }
    return "";
  };
  const request = async (url: string | URL, options?: RequestInit) => {
    calls.push(["fetch", String(url), JSON.stringify(options?.headers), String(options?.redirect)]);
    if (String(url).includes("/token")) {
      expect(options?.redirect).toBe("error");
      return new Response(JSON.stringify({ value: mode === "missingtoken" ? null : "fixture-jwt" }), { status: mode === "oidc" ? 403 : 200 });
    }
    return new Response("fixture-archive", { status: mode === "download" ? 503 : 200 });
  };
  const deps = { io, run, fetch: request, env, uid: 1000, platform: "linux", arch: "x64",
    digest: mode === "checksum" ? undefined : () => PIN.sha256,
    log: (message: string) => logs.push(message), pause: async () => {},
    proc: async () => alive ? `${mode === "foreign" || (mode === "reused" && calls.some((call) => call.includes("logout"))) ? "/foreign/tailscaled" : binary}\0--socket=${directory}/tailscaled.sock\0--state=mem:\0` : "",
    launch: async (args: string[], log: string) => {
      calls.push(["launch", ...args, log]);
      if (mode === "startup") throw Error("fixture-jwt launch failure");
      alive = mode !== "stale"; files.set(`${directory}/daemon.pid`, mode === "badpid" ? "1" : "42");
      if (mode !== "readiness") files.set(`${directory}/tailscaled.sock`, "socket");
    },
  };
  return { connect, cleanup, deps, files, calls, logs, directory };
}

test("local connection action declares unconditional Node24 post cleanup", async () => {
  const { PIN } = await import("../.github/actions/tailscale-connection/main.mjs");
  expect(PIN).toEqual({ version: "1.102.4", url: "https://pkgs.tailscale.com/stable/tailscale_1.102.4_amd64.tgz",
    sha256: "50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9" });
  const action = Bun.YAML.parse(read(".github/actions/tailscale-connection/action.yml")) as { runs: Record<string, string>; inputs: Record<string, unknown> };
  expect(action.runs).toEqual({ using: "node24", main: "main.mjs", post: "post.mjs", "post-if": "always()" });
  expect(Object.keys(action.inputs)).toEqual(["client-id", "audience"]);
});

test("native connection uses one strict up, audience OIDC, private token file and owned post", async () => {
  const f = await connectionFixture();
  await f.connect(f.deps);
  const up = f.calls.filter((call) => call.includes("up"));
  expect(up).toHaveLength(1);
  const launch = f.calls.find((call) => call[0] === "launch")!;
  expect(launch.slice(1, 5)).toEqual(["-n", "bash", "-c", 'set -e; echo $$ > "$1"; shift; exec "$@"']);
  expect(launch).toContain("--state=mem:");
  expect(launch).toContain(`--socket=${f.directory}/tailscaled.sock`);
  expect(f.calls.some((call) => call[0] === "chmod" && call[1] === f.directory && call[2] === "448")).toBe(true);
  expect(f.calls.findIndex((call) => call[0] === "launch")).toBeLessThan(f.calls.findIndex((call) => call.includes("up")));
  for (const flag of ["--accept-dns=false", "--accept-routes=false", "--ssh=false", "--advertise-tags=tag:agendia-ci",
    "--client-id=fixture-client?preauthorized=true&ephemeral=true", `--id-token=file:${f.directory}/token`]) expect(up[0]!.filter((arg) => arg === flag)).toHaveLength(1);
  expect(up[0]?.slice(0, 4)).toEqual(["sudo", "-n", `${f.directory}/tailscale_1.102.4_amd64/tailscale`, `--socket=${f.directory}/tailscaled.sock`]);
  expect(JSON.stringify(f.calls.filter((call) => !["write", "fetch"].includes(call[0]!)))).not.toContain("fixture-jwt");
  expect(f.logs).toEqual(["::add-mask::fixture-jwt", "TS_CONNECTED"]);
  expect(f.files.has(`${f.directory}/token`)).toBe(false);
  expect(f.calls.find((call) => call[0] === "write" && call[1]?.endsWith("/token"))?.[2]).toContain("384");
  const oidc = f.calls.find((call) => call[0] === "fetch" && call[1]?.includes("/token"))!;
  expect(new URL(oidc[1]!).searchParams.get("audience")).toBe("fixture/audience?x=1");
  await f.cleanup(f.directory, f.deps);
  expect(f.calls.some((call) => call.includes("logout"))).toBe(true);
  expect(f.calls.some((call) => call.includes("kill") && call.includes("42"))).toBe(true);
  expect(f.files.has(f.directory)).toBe(false);
  await f.cleanup(f.directory, f.deps); // Always-post after setup cleanup is idempotent.
});

for (const mode of ["download", "checksum", "archive", "version", "symlink", "oidc", "missingtoken", "startup", "readiness", "stale", "badpid", "up"]) {
  test(`native connection fails closed and cleans setup on ${mode}`, async () => {
    const f = await connectionFixture(mode);
    await expect(f.connect(f.deps)).rejects.toThrow(/^TS_/);
    expect(f.files.has(f.directory)).toBe(["startup", "badpid"].includes(mode));
    if (mode === "checksum") expect(f.calls.filter((call) => call[0] !== "fetch" && call[0] !== "write" && call[0] !== "chmod" && call[0] !== "remove")).toEqual([]);
    if (mode !== "up") expect(f.calls.some((call) => call.includes("up"))).toBe(false);
    expect(f.calls.some((call) => call.includes("logout"))).toBe(mode === "up");
    expect(f.logs.filter((line) => !line.startsWith("::add-mask::")).join(" ")).not.toMatch(/fixture-jwt|private/);
  });
}

test("post surfaces logout failure but still stops owned daemon and removes files", async () => {
  const f = await connectionFixture("logout"); await f.connect(f.deps);
  await expect(f.cleanup(f.directory, f.deps)).rejects.toThrow("TS_CLEANUP");
  expect(f.calls.some((call) => call.includes("kill"))).toBe(true);
  expect(f.files.has(f.directory)).toBe(false);
});

test("cleanup escalates only an owned stubborn PID and rejects reuse or redirected socket", async () => {
  for (const mode of ["stubborn", "reused", "socket", "binary"]) {
    const f = await connectionFixture(mode); await f.connect(f.deps);
    if (mode === "binary") f.files.delete(`${f.directory}/tailscale_1.102.4_amd64/tailscaled`);
    if (mode === "socket") {
      const stat = f.deps.io.lstat;
      f.deps.io.lstat = async (path) => ({ ...await stat(path), isSymbolicLink: () => path.endsWith(".sock") });
    }
    if (mode === "stubborn") {
      await f.cleanup(f.directory, f.deps);
      expect(f.calls.filter((call) => call.includes("kill")).map((call) => call[3])).toEqual(["-TERM", "-KILL"]);
    } else {
      await expect(f.cleanup(f.directory, f.deps)).rejects.toThrow("TS_CLEANUP");
      expect(f.calls.some((call) => call.includes("kill"))).toBe(mode === "socket");
      if (mode === "socket") expect(f.calls.some((call) => call.includes("logout"))).toBe(false);
    }
    expect(f.files.has(f.directory)).toBe(["reused", "binary"].includes(mode));
  }
});

test("absent identity still stops owned daemon; stop failure is not full success", async () => {
  for (const mode of ["success", "stop"]) {
    const f = await connectionFixture(mode); await f.connect(f.deps);
    f.files.delete(`${f.directory}/identity`);
    if (mode === "stop") {
      for (const attempt of [1, 2]) {
        await expect(f.cleanup(f.directory, f.deps)).rejects.toThrow("TS_CLEANUP");
        expect(f.files.has(f.directory) && f.files.has(`${f.directory}/daemon.pid`)).toBe(true);
        expect(f.calls.filter((call) => call.includes("kill")).length).toBe(attempt);
      }
      f.deps.proc = async () => ""; // Subsequently verified absent, not silently orphaned.
    }
    await f.cleanup(f.directory, f.deps);
    expect(f.calls.some((call) => call.includes("logout"))).toBe(false);
    expect(f.calls.some((call) => call.includes("kill"))).toBe(true);
    expect(f.files.has(f.directory)).toBe(false);
  }
});

test("platform and unsafe client validation reject before download or launch", async () => {
  const f = await connectionFixture();
  for (const changes of [{ platform: "darwin" }, { arch: "arm64" }, { env: { ...f.deps.env, RUNNER_ENVIRONMENT: "self-hosted" } },
    { env: { ...f.deps.env, "INPUT_CLIENT-ID": "client?unsafe=true" } }]) {
    await expect(f.connect({ ...f.deps, ...changes })).rejects.toThrow("TS_SETUP");
    expect(f.calls).toEqual([]);
  }
});

test("foreign PID and foreign directory never receive logout, kill or removal", async () => {
  const f = await connectionFixture("foreign");
  await expect(f.connect(f.deps)).rejects.toThrow(/^TS_/);
  expect(f.calls.some((call) => call.includes("logout") || call.includes("kill"))).toBe(false);
  await expect(f.cleanup("/foreign", f.deps)).rejects.toThrow("TS_CLEANUP");
  expect(f.calls.some((call) => call[0] === "remove" && call[1] === "/foreign")).toBe(false);
  await f.cleanup(undefined, f.deps);
});

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
  const network = steps.findIndex((step) => step.uses === "./.github/actions/tailscale-connection");
  const ssh = steps.findIndex((step) => step.name === "Transfer and execute over pinned SSH");
  expect(check).toBeGreaterThanOrEqual(0);
  expect(network).toBeGreaterThan(check);
  expect(ssh).toBeGreaterThan(network);
  expect(steps[network]!.uses).toBe("./.github/actions/tailscale-connection");
  expect(steps[network]!.with).toEqual({
    "client-id": "${{ vars.PRODUCTION_TAILSCALE_CLIENT_ID }}",
    audience: "${{ vars.PRODUCTION_TAILSCALE_AUDIENCE }}",
  });
  expect(steps[0]).toEqual(workflowYaml(".github/workflows/deploy.yml").jobs.connection_check!.steps[0]);
  for (const step of steps.slice(1, ssh)) expect(JSON.stringify(step)).not.toContain("secrets.");
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

test("connection-only dispatch is isolated from release and reusable deployment", () => {
  const deploy = workflowYaml(".github/workflows/deploy.yml");
  const dispatch = deploy.on as { workflow_dispatch?: { inputs?: Record<string, { description?: string; required?: boolean; default?: boolean; type?: string }> }; workflow_call?: { inputs?: Record<string, { required?: boolean }> } };
  expect(dispatch.workflow_dispatch?.inputs?.connection_only).toEqual({
    description: "Verify the protected private connection without deploying",
    required: false, type: "boolean", default: false,
  });
  expect(dispatch.workflow_dispatch?.inputs?.release?.required).toBe(false);
  expect(dispatch.workflow_call?.inputs?.release?.required).toBe(true);
  const diagnosticPreflight = deploy.jobs.connection_preflight!;
  expect(diagnosticPreflight.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(diagnosticPreflight.if).toContain("inputs.connection_only == true");
  expect(diagnosticPreflight.if).toContain("github.repository == 'valerubio7/agendia'");
  expect(diagnosticPreflight.if).toContain("refs/heads/main");
  expect(diagnosticPreflight.if).toContain("refs/heads/ci/tailscale-private-deploy");
  expect(diagnosticPreflight.permissions).toEqual({ contents: "read" });
  expect(diagnosticPreflight.environment).toBeUndefined();
  expect(JSON.stringify(diagnosticPreflight)).not.toMatch(/secrets\.|id-token|PRODUCTION_TAILSCALE|PRODUCTION_SSH|SSH_KEY/i);
  expect(diagnosticPreflight.steps[0]!.env).toEqual({ GH_TOKEN: "${{ github.token }}", REPOSITORY: "${{ github.repository }}" });
  expect(diagnosticPreflight.steps[0]!.run).toContain('.protection_rules | any(.type == "required_reviewers"');
  expect(diagnosticPreflight.steps[0]!.run).not.toContain("compare/");
  expect(diagnosticPreflight.steps[0]!.run).not.toContain("contents/");
  expect(diagnosticPreflight.steps[0]!.run).not.toMatch(/publisher|RELEASE|PUBLISHER_RUN/i);
  const protectionScript = diagnosticPreflight.steps[0]!.run!;
  for (const mode of ["protected", "missing"]) {
    const dir = mkdtempSync(join(tmpdir(), "agendia-protection-"));
    const bin = join(dir, "bin"); mkdirSync(bin); const log = join(dir, "calls");
    writeFileSync(join(bin, "gh"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$MOCK_LOG"\n[[ "$*" == "api repos/fixture/repo/environments/production" ]] || exit 9\nif [[ "$MODE" == protected ]]; then echo '{"protection_rules":[{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":1,"type":"User","login":"owner"}}]}]}'; else echo '{"protection_rules":[]}'; fi\n`);
    chmodSync(join(bin, "gh"), 0o700);
    const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", protectionScript], {
      cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, MOCK_LOG: log, MODE: mode,
        GH_TOKEN: "fixture-token", REPOSITORY: "fixture/repo" },
    });
    expect(result.exitCode === 0).toBe(mode === "protected");
    expect(readFileSync(log, "utf8").trim()).toBe("api repos/fixture/repo/environments/production");
    expect(result.stdout.toString()).not.toContain("fixture-token");
  }
  const diagnostic = deploy.jobs.connection_check!;
  expect(diagnostic.needs).toBe("connection_preflight");
  expect(diagnostic.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(diagnostic.if).toContain("inputs.connection_only == true");
  expect(diagnostic.if).toContain("github.repository == 'valerubio7/agendia'");
  expect(diagnostic.if).toContain("refs/heads/main");
  expect(diagnostic.if).toContain("refs/heads/ci/tailscale-private-deploy");
  expect(diagnostic.environment).toBe("production");
  expect(diagnostic["runs-on"]).toBe("ubuntu-latest");
  expect(diagnostic.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(deploy.permissions).not.toHaveProperty("id-token");
  expect(deploy.jobs.preflight!.if).toContain("!inputs.connection_only");
  expect(deploy.jobs.deploy!.needs).toBe("preflight");
  expect(diagnostic.steps.map((step) => step.name)).toEqual([
    "Mask pinned connection host", "Download version-matched connection action after approval", "Validate private connection credentials", "Connect private deployment network", "Verify read-only SSH identity",
  ]);
  const [mask, , validate, network, ssh] = diagnostic.steps;
  expect(mask!.env).toEqual({ KNOWN_HOSTS: "${{ secrets['PRODUCTION_KNOWN_HOSTS'] }}" });
  expect(mask!.run).not.toContain("${{ vars.");
  expect(network!.uses).toBe("./.github/actions/tailscale-connection");
  expect(network!.with).toEqual({
    "client-id": "${{ vars.PRODUCTION_TAILSCALE_CLIENT_ID }}", audience: "${{ vars.PRODUCTION_TAILSCALE_AUDIENCE }}",
  });
  expect(validate!.env).toMatchObject({
    TS_CLIENT_ID: "${{ vars.PRODUCTION_TAILSCALE_CLIENT_ID }}", TS_AUDIENCE: "${{ vars.PRODUCTION_TAILSCALE_AUDIENCE }}",
    SSH_HOST: "${{ vars.PRODUCTION_SSH_HOST }}", SSH_USER: "${{ vars.PRODUCTION_SSH_USER }}",
    SSH_PORT: "${{ vars.PRODUCTION_SSH_PORT }}", SSH_KEY: "${{ secrets['PRODUCTION_SSH_KEY'] }}",
    KNOWN_HOSTS: "${{ secrets['PRODUCTION_KNOWN_HOSTS'] }}",
  });
  expect(ssh!.run).toContain("ssh -F /dev/null");
  expect(ssh!.run).toContain('"id -un"');
  expect(ssh!.run).toContain("StrictHostKeyChecking=yes");
  expect(ssh!.run).toContain('trap cleanup EXIT');
  expect(ssh!.run!.match(/\bssh\b/g)).toHaveLength(1);
  expect(JSON.stringify(diagnostic)).not.toMatch(/scp|deploy-release|compose\.production|APP_DIR|PROJECT|docker|service |migration/i);
  expect(JSON.stringify(diagnostic)).not.toMatch(/hostkeyscan|StrictHostKeyChecking=no|ssh-agent/i);
  expect(ssh!.run).not.toMatch(/echo.*(SSH_KEY|KNOWN_HOSTS)/i);
});

test("connection-only SSH script uses isolated fixtures and cleans its private key on success and failure", () => {
  const diagnostic = workflowYaml(".github/workflows/deploy.yml").jobs.connection_check!;
  const script = diagnostic.steps.find((step) => step.name === "Verify read-only SSH identity")!.run!;
  for (const mode of ["success", "failure", "mismatch"]) {
    const dir = mkdtempSync(join(tmpdir(), "agendia-connection-"));
    const bin = join(dir, "bin"); mkdirSync(bin); const log = join(dir, "log"); const temp = join(dir, "temp"); mkdirSync(temp);
    writeFileSync(join(bin, "ssh"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$MOCK_LOG"\n[[ "$*" == *'id -un' ]] || exit 9\n[[ "$MODE" != failure ]] || { echo 'fixture.example private error' >&2; exit 8; }\necho sysadmin\n`);
    chmodSync(join(bin, "ssh"), 0o700);
    const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", script], {
      cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temp, MOCK_LOG: log, MODE: mode,
        TS_CLIENT_ID: "fixture-client", TS_AUDIENCE: "fixture-audience", SSH_HOST: "fixture-host",
        SSH_USER: mode === "mismatch" ? "fixtureaccount" : "sysadmin", SSH_PORT: "22", SSH_KEY: "fixture-private-key", KNOWN_HOSTS: "fixture known host", },
    });
    if (mode === "success") expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(mode === "success" ? 0 : mode === "failure" ? 8 : 1);
    expect(result.stderr.toString()).toBe(mode === "failure" ? "SSH connection failed.\n" : "");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(log, "utf8")).toContain("id -un");
    expect(result.stdout.toString()).not.toContain("sysadmin");
    expect(result.stdout.toString()).not.toContain("fixture-private-key");
    expect([...new Bun.Glob("**/*").scanSync({ cwd: temp })]).toEqual([]);
  }
});

test("pinned host masking fails closed before any host-variable logging", () => {
  const mask = workflowYaml(".github/workflows/deploy.yml").jobs.connection_check!.steps[0]!;
  expect(mask.name).toBe("Mask pinned connection host");
  for (const [pin, valid] of [
    ["# fixture comment\nfixture.example ssh-ed25519 Zml4dHVyZQ==", true],
    ["|1|hashed|fixture ssh-ed25519 Zml4dHVyZQ==", false],
    ["fixture.example ssh-rsa Zml4dHVyZQ==", false],
    ["fixture.example ssh-ed25519", false],
    ["", false],
  ] as const) {
    const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", mask.run!], {
      env: { PATH: "", KNOWN_HOSTS: pin },
    });
    expect(result.exitCode === 0).toBe(valid);
    expect(result.stdout.toString()).toBe(valid ? "::add-mask::fixture.example\n" : "");
    expect(result.stderr.toString()).toBe("");
  }
});

test("protected local action materialization binds each job to its exact immutable source", () => {
  const workflow = workflowYaml(".github/workflows/deploy.yml");
  const helper = ".github/actions/tailscale-connection";
  for (const jobName of ["deploy", "connection_check"]) {
    const job = workflow.jobs[jobName]!;
    const diagnostic = jobName === "connection_check";
    const download = job.steps.findIndex((step) => step.name === (diagnostic
      ? "Download version-matched connection action after approval" : "Download version-matched deployment files after approval"));
    const network = job.steps.findIndex((step) => step.uses === `./${helper}`);
    expect(job.environment).toBe("production");
    expect(job.steps[0]!.name).toBe("Mask pinned connection host");
    expect(download).toBeGreaterThan(0); expect(network).toBeGreaterThan(download);
    const step = job.steps[download]!;
    expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}", REPOSITORY: "${{ github.repository }}",
      [diagnostic ? "SOURCE_SHA" : "RELEASE"]: diagnostic ? "${{ github.sha }}" : "${{ inputs.release }}" });
    expect(step.run).not.toMatch(/checkout|tailscale up|ref=(main|HEAD)|releases\/|secrets\.|\$\{\{/);
    expect(step.if).toBeUndefined(); expect(step["continue-on-error"]).toBeUndefined();
    const expected = [...(diagnostic ? [] : ["deploy/deploy-release.sh", "compose.production.yml"]),
      ...["action.yml", "main.mjs", "post.mjs"].map((file) => `${helper}/${file}`)];
    for (const mode of ["success", "failure", "invalid-sha"]) {
      const dir = mkdtempSync(join(tmpdir(), "agendia-source-"));
      const bin = join(dir, "bin"); mkdirSync(bin); const log = join(dir, "calls");
      writeFileSync(log, "");
      writeFileSync(join(bin, "gh"), `#!/bin/bash
set -eu
[[ "$1" == api && "$2" == -H && "$3" == 'Accept: application/vnd.github.raw+json' ]] || exit 9
request="$4"
printf '%s\\n' "$request" >> "$MOCK_LOG"
[[ "$request" == "repos/fixture/repo/contents/"*"?ref=$EXPECTED_SHA" ]] || exit 9
file="\${request#repos/fixture/repo/contents/}"; file="\${file%\\?ref=*}"
[[ "$MODE" != failure || "$file" != */main.mjs ]] || exit 8
printf 'fixture:%s\\n' "$file"
`);
      chmodSync(join(bin, "gh"), 0o700);
      const env = { PATH: `${bin}:/usr/bin:/bin`, GH_TOKEN: "fixture-token", REPOSITORY: "fixture/repo",
        RELEASE: diagnostic ? "b".repeat(40) : mode === "invalid-sha" ? "main" : sha,
        SOURCE_SHA: diagnostic ? mode === "invalid-sha" ? "main" : sha : "b".repeat(40), EXPECTED_SHA: sha, MOCK_LOG: log, MODE: mode };
      expect(Bun.spawnSync(["/bin/bash", "-n", "-c", step.run!], { env }).exitCode).toBe(0);
      const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", step.run!], { cwd: dir, env });
      expect(result.exitCode).toBe(mode === "success" ? 0 : mode === "failure" ? 8 : 1);
      const requests = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      expect(requests).toEqual((mode === "invalid-sha" ? [] : mode === "failure" ? expected.slice(0, -1) : expected)
        .map((file) => `repos/fixture/repo/contents/${file}?ref=${sha}`));
      if (mode === "success") for (const file of expected) {
        const output = file.startsWith(helper) ? file : file.split("/").at(-1)!;
        expect(readFileSync(join(dir, output), "utf8")).toBe(`fixture:${file}\n`);
      }
      else expect(existsSync(join(dir, helper, "post.mjs"))).toBe(false);
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain("fixture-token");
    }
  }
  const condition = "github.event_name == 'workflow_dispatch' && inputs.connection_only == true && github.repository == 'valerubio7/agendia' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/ci/tailscale-private-deploy' || github.ref == 'refs/heads/ci/tailscale-cli-integration')";
  for (const name of ["connection_preflight", "connection_check"]) expect(workflow.jobs[name]!.if).toBe(condition);
});

test("workflow trust, source matching and SSH policies remain explicit", () => {
  const publish = read(".github/workflows/publish.yml");
  for (const guard of ["tags: ['v*']", "run-name: Publish ${{ github.sha }}", "github.event_name == 'push'", '.conclusion == "success"', '.event == "push"', '.head_branch == "main"', '.head_repository.full_name == $repo', "actions: read", "packages: write", "tarball/$RELEASE"]) expect(publish).toContain(guard);
  expect(publish).not.toContain("workflow_run:");
  const deploy = read(".github/workflows/deploy.yml");
  for (const guard of ["workflow_dispatch:", "github.ref == 'refs/heads/main'", "environment: production", "cancel-in-progress: false", "compare/$RELEASE...main", "actions/workflows/ci.yml", ".display_title == (\"Publish \" + $sha)", "?ref=$RELEASE", "StrictHostKeyChecking=yes", "BatchMode=yes"]) expect(deploy).toContain(guard);
  expect(deploy).not.toContain("pull_request:");
  expect(deploy.match(/uses: .+/g)).toEqual([
    "uses: ./.github/actions/tailscale-connection",
    "uses: ./.github/actions/tailscale-connection",
  ]);
  expect(publish.match(/uses: .+/g)).toEqual(["uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2"]);
  expect(publish).toContain("bun-version: 1.4.0");
  expect(read("compose.production.yml")).toContain("${AGENDIA_IMAGE:-agendia:local}");
});

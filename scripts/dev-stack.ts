import { connect } from "node:net";
import postgres from "postgres";

export type ManagedService = { stop(): Promise<void> };
export interface DevStackDependencies {
  probePort(host: string, port: number): Promise<boolean>;
  waitPort?(host: string, port: number): Promise<void>;
  isMigrated?(databaseUrl: string): Promise<boolean>;
  run(command: string, args: string[]): Promise<void>;
  spawn(name: string, command: string, args: string[]): ManagedService;
  waitHttp(url: string): Promise<void>;
}
type DevEnvironment = Record<string, string | undefined>;

const required = [
  "DATABASE_URL",
  "APP_ORIGIN",
  "AGENDIA_API_ORIGIN",
  "AGENDIA_ADMIN_EMAIL",
  "AGENDIA_ADMIN_PASSWORD",
  "DEEPSEEK_API_KEY",
  "BAILEYS_KMS_VERSION",
  "BAILEYS_KMS_KEY",
  "WHATSAPP_LINK_CODE_KEY",
] as const;
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function validateDevEnvironment(env: DevEnvironment) {
  for (const name of required)
    if (!env[name]?.trim()) throw new Error(`${name} is required`);
  if (env.APP_ORIGIN !== "http://127.0.0.1:3000")
    throw new Error("APP_ORIGIN must be the local UI origin");
  if (env.API_HOST && !localHosts.has(env.API_HOST))
    throw new Error("API_HOST must be local");
  if (env.API_PORT && env.API_PORT !== "3001")
    throw new Error("API_PORT must be 3001 for local development");
  if (
    env.AGENDIA_API_ORIGIN &&
    env.AGENDIA_API_ORIGIN !== "http://127.0.0.1:3001"
  )
    throw new Error("AGENDIA_API_ORIGIN must be the local API origin");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.AGENDIA_ADMIN_EMAIL!.trim()))
    throw new Error("AGENDIA_ADMIN_EMAIL is invalid");
  if (
    env.AGENDIA_ADMIN_PASSWORD!.length < 16 ||
    /^(password|contraseña|123456)/i.test(env.AGENDIA_ADMIN_PASSWORD!)
  )
    throw new Error("AGENDIA_ADMIN_PASSWORD does not meet policy");
  for (const name of ["BAILEYS_KMS_KEY", "WHATSAPP_LINK_CODE_KEY"] as const) {
    const value = env[name]!;
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      Buffer.from(value, "base64").length !== 32
    )
      throw new Error(`${name} must contain 32 base64-encoded bytes`);
  }
  const databaseNames = [
    "DATABASE_URL",
    "API_DATABASE_URL",
    "ADMIN_DATABASE_URL",
    "MANAGER_DATABASE_URL",
    "WORKER_DATABASE_URL",
  ] as const;
  let database!: URL;
  for (const name of databaseNames) {
    if (!env[name]) continue;
    let parsed: URL;
    try {
      parsed = new URL(env[name]);
    } catch {
      throw new Error(`${name} must be a PostgreSQL URL`);
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !localHosts.has(parsed.hostname)
    )
      throw new Error(`${name} must target local PostgreSQL`);
    if (name === "DATABASE_URL") database = parsed;
  }
  return { database };
}

const systemServices: ManagedService[] = [];
const serviceShutdownGraceMs = 1_000;
const groupExists = (groupId: number) => {
  if (groupId <= 0 || groupId === process.pid) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
};
const signalGroup = (groupId: number, signal: NodeJS.Signals) => {
  if (groupId <= 0 || groupId === process.pid)
    throw new Error("Refusing to signal the dev supervisor process group");
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
const waitForGroupExit = async (groupId: number, milliseconds: number) => {
  const deadline = Date.now() + milliseconds;
  while (groupExists(groupId) && Date.now() < deadline) await delay(25);
  return !groupExists(groupId);
};
const probePort = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(500);
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
const waitForPort = async (host: string, port: number) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await probePort(host, port)) return;
    await delay(500);
  }
  throw new Error("Local PostgreSQL did not become ready");
};
const isMigrated = async (databaseUrl: string) => {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return Boolean(
      (
        await sql<
          { installed: boolean }[]
        >`select to_regprocedure('append_runtime_audit(uuid,text,text,text,text,text)') is not null installed`
      )[0]?.installed,
    );
  } finally {
    await sql.end();
  }
};
const runCommand = async (command: string, args: string[]) => {
  const child = Bun.spawn([command, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (await child.exited) throw new Error(`${command} failed`);
};
const spawnService = (
  name: string,
  command: string,
  args: string[],
): ManagedService => {
  const ownsProcessGroup = process.platform !== "win32";
  const child = Bun.spawn([command, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    detached: ownsProcessGroup,
  });
  let requestedStop = false;
  let stopping: Promise<void> | undefined;
  const service: ManagedService = {
    stop: () =>
      (stopping ??= (async () => {
        requestedStop = true;
        if (ownsProcessGroup) {
          signalGroup(child.pid, "SIGTERM");
          if (!(await waitForGroupExit(child.pid, serviceShutdownGraceMs)))
            signalGroup(child.pid, "SIGKILL");
        } else if (child.exitCode === null) child.kill("SIGTERM");
        await child.exited;
      })()),
  };
  systemServices.push(service);
  void child.exited.then(() => {
    if (!requestedStop) {
      console.error(
        JSON.stringify({ event: "dev.service.exit", service: name }),
      );
      process.kill(process.pid, "SIGTERM");
    }
  });
  return service;
};
const waitHttp = async (url: string) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(url, { redirect: "manual" })).status < 500) return;
    } catch (error) {
      void error;
    }
    await delay(500);
  }
  throw new Error("A local service did not become ready");
};
export const systemDependencies: DevStackDependencies = {
  probePort,
  waitPort: waitForPort,
  isMigrated,
  run: runCommand,
  spawn: spawnService,
  waitHttp,
};

export async function runDevStack(
  env: DevEnvironment = process.env,
  dependencies: DevStackDependencies = systemDependencies,
) {
  const { database } = validateDevEnvironment(env),
    host = database.hostname,
    port = Number(database.port || 5432),
    services: ManagedService[] = [];
  try {
    if (!(await dependencies.probePort(host, port))) {
      if (port !== 5432)
        throw new Error(
          "Compose PostgreSQL is available only on local port 5432",
        );
      await dependencies.run("docker", ["compose", "up", "-d", "postgres"]);
      await dependencies.waitPort?.(host, port);
    }
    if (!(await dependencies.isMigrated?.(database.toString())))
      await dependencies.run("bun", ["run", "db:migrate"]);
    await dependencies.run("bun", ["run", "scripts/bootstrap-admin.ts"]);
    const specs: [string, string, string[]][] = [
      ["api", "bun", ["run", "scripts/start-api.ts"]],
      [
        "web",
        "bun",
        [
          "run",
          "--cwd",
          "apps/web",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "3000",
        ],
      ],
      [
        "whatsapp-manager",
        "bun",
        ["run", "--cwd", "apps/whatsapp-manager", "start"],
      ],
      [
        "message-worker",
        "bun",
        ["run", "--cwd", "apps/message-worker", "start"],
      ],
    ];
    for (const [name, command, args] of specs)
      services.push(dependencies.spawn(name, command, args));
    await dependencies.waitHttp("http://127.0.0.1:3001/auth/session");
    await dependencies.waitHttp("http://127.0.0.1:3000");
    console.log(
      JSON.stringify({ event: "dev.stack.ready", ui: "http://127.0.0.1:3000" }),
    );
    return {
      stop: async () => {
        for (const service of services.reverse()) await service.stop();
      },
    };
  } catch (error) {
    for (const service of services.reverse()) await service.stop();
    throw error;
  }
}

if (import.meta.main) {
  let stack: Awaited<ReturnType<typeof runDevStack>> | undefined,
    stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (stack) await stack.stop();
    else for (const service of systemServices.reverse()) await service.stop();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit()));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit()));
  try {
    stack = await runDevStack();
  } catch {
    console.error(JSON.stringify({ event: "dev.stack", outcome: "failure" }));
    process.exitCode = 1;
  }
}

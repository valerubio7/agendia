import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  runDevStack,
  systemDependencies,
  validateDevEnvironment,
  type DevStackDependencies,
} from "./dev-stack.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
const waitForProcessExit = async (pid: number) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!processExists(pid)) return true;
    await delay(25);
  }
  return false;
};
const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });

const validEnv = {
  DATABASE_URL: "postgresql://agendia_migrator:secret@127.0.0.1:5432/agendia",
  APP_ORIGIN: "http://127.0.0.1:3000",
  AGENDIA_API_ORIGIN: "http://127.0.0.1:3001",
  AGENDIA_ADMIN_EMAIL: "owner@example.com",
  AGENDIA_ADMIN_PASSWORD: "correct horse battery staple",
  DEEPSEEK_API_KEY: "configured",
  BAILEYS_KMS_VERSION: "local-v1",
  BAILEYS_KMS_KEY: Buffer.alloc(32, 1).toString("base64"),
  WHATSAPP_LINK_CODE_KEY: Buffer.alloc(32, 2).toString("base64"),
};

const fakeDependencies = (databaseReady: boolean, migrated = false) => {
  const events: string[] = [];
  const dependencies: DevStackDependencies = {
    probePort: async () => databaseReady,
    isMigrated: async () => migrated,
    run: async (command, args) => {
      events.push(`run:${command} ${args.join(" ")}`);
    },
    spawn: (name, command, args) => {
      events.push(`spawn:${name}:${command} ${args.join(" ")}`);
      return {
        stop: async () => {
          events.push(`stop:${name}`);
        },
      };
    },
    waitHttp: async (url) => {
      events.push(`ready:${url}`);
    },
  };
  return { dependencies, events };
};

describe("local development supervisor", () => {
  test("root development commands load secrets only from the external config file", async () => {
    const packageJson = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as {
      scripts: Record<string, string>;
    };
    const externalEnvOption = '--env-file="$HOME/.config/agendia/dev.env"';

    expect(packageJson.scripts.dev).toBe(
      `bun ${externalEnvOption} run scripts/dev-stack.ts`,
    );
    expect(packageJson.scripts["bootstrap:admin"]).toBe(
      `bun ${externalEnvOption} run scripts/bootstrap-admin.ts`,
    );
    expect(
      Object.values(packageJson.scripts).some((command) =>
        /--env-file(?:=|\s+)["']?\.env["']?(?:\s|$)/.test(command),
      ),
    ).toBe(false);
  });

  test("Node TypeScript loader imports service entrypoints without starting them", () => {
    const result = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const [manager, worker] = await Promise.all([
          import("./apps/whatsapp-manager/src/index.ts"),
          import("./apps/message-worker/src/index.ts"),
        ]); console.log(JSON.stringify([manager.serviceName, worker.serviceName]));`,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENDIA_RUN_WHATSAPP_MANAGER: "0",
          AGENDIA_RUN_MESSAGE_WORKER: "0",
        },
      },
    );

    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    expect(result.stdout.trim()).toBe('["whatsapp-manager","message-worker"]');
  });

  test("stops the managed service process tree, including a real grandchild", async () => {
    if (process.platform === "win32") return;
    let resolveReady!: (value: { pid: number; port: number }) => void;
    const ready = new Promise<{ pid: number; port: number }>((resolve) => {
      resolveReady = resolve;
    });
    const callback = createServer((socket) => {
      let payload = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        payload += chunk;
      });
      socket.on("end", () => {
        resolveReady(JSON.parse(payload) as { pid: number; port: number });
      });
    });
    await new Promise<void>((resolve) =>
      callback.listen(0, "127.0.0.1", resolve),
    );
    const callbackAddress = callback.address();
    if (!callbackAddress || typeof callbackAddress === "string")
      throw new Error("Missing callback address");
    const script = `
      import { connect, createServer } from "node:net";
      process.on("SIGTERM", () => undefined);
      const server = createServer(() => undefined);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const socket = connect(${callbackAddress.port}, "127.0.0.1", () => {
          socket.end(JSON.stringify({ pid: process.pid, port: address.port }));
        });
      });
    `;
    const service = systemDependencies.spawn("process-tree-regression", "sh", [
      "-c",
      `node --input-type=module --eval ${shellQuote(script)} & wait`,
    ]);
    let grandchildPid = 0;
    let grandchildPort = 0;
    try {
      ({ pid: grandchildPid, port: grandchildPort } = await Promise.race([
        ready,
        delay(2_000).then(() => {
          throw new Error("Grandchild did not become ready");
        }),
      ]));
      expect(await canConnect(grandchildPort)).toBe(true);
      await service.stop();
      expect(await waitForProcessExit(grandchildPid)).toBe(true);
      expect(await canConnect(grandchildPort)).toBe(false);
    } finally {
      await service.stop();
      if (grandchildPid && processExists(grandchildPid))
        process.kill(grandchildPid, "SIGKILL");
      await new Promise<void>((resolve, reject) =>
        callback.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("validates required shape without accepting remote databases", () => {
    expect(validateDevEnvironment(validEnv).database.hostname).toBe(
      "127.0.0.1",
    );
    expect(() =>
      validateDevEnvironment({ ...validEnv, DEEPSEEK_API_KEY: "" }),
    ).toThrow("DEEPSEEK_API_KEY");
    expect(() =>
      validateDevEnvironment({
        ...validEnv,
        DATABASE_URL: "postgresql://user:pass@db.example.com/agendia",
      }),
    ).toThrow("local PostgreSQL");
    expect(() =>
      validateDevEnvironment({ ...validEnv, BAILEYS_KMS_KEY: "not-base64" }),
    ).toThrow("BAILEYS_KMS_KEY");
  });

  test("starts PostgreSQL when needed, prepares in order, waits for readiness, and stops children in reverse", async () => {
    const { dependencies, events } = fakeDependencies(false);
    const stack = await runDevStack(validEnv, dependencies);
    expect(events).toEqual([
      "run:docker compose up -d postgres",
      "run:bun run db:migrate",
      "run:bun run scripts/bootstrap-admin.ts",
      "spawn:api:bun run scripts/start-api.ts",
      "spawn:web:bun run --cwd apps/web dev --hostname 127.0.0.1 --port 3000",
      "spawn:whatsapp-manager:bun run --cwd apps/whatsapp-manager start",
      "spawn:message-worker:bun run --cwd apps/message-worker start",
      "ready:http://127.0.0.1:3001/auth/session",
      "ready:http://127.0.0.1:3000",
    ]);
    await stack.stop();
    expect(events.slice(-4)).toEqual([
      "stop:message-worker",
      "stop:whatsapp-manager",
      "stop:web",
      "stop:api",
    ]);
  });

  test("does not take ownership of an already-running local PostgreSQL", async () => {
    const { dependencies, events } = fakeDependencies(true);
    const stack = await runDevStack(validEnv, dependencies);
    expect(events.some((event) => event.startsWith("run:docker"))).toBe(false);
    await stack.stop();
  });

  test("does not reapply non-repeatable migrations to an initialized database", async () => {
    const { dependencies, events } = fakeDependencies(true, true);
    const stack = await runDevStack(validEnv, dependencies);
    expect(events).not.toContain("run:bun run db:migrate");
    await stack.stop();
  });
});

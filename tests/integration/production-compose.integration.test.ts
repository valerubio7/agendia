import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Exercise the production Compose dependency graph without production credentials or data.
test("each deployment runs migrations before starting database consumers and blocks on failure", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".compose-migration-test-"));
  const project = `migration-test-${crypto.randomUUID().replaceAll("-", "")}`;
  const envFile = join(directory, "env");
  const composeFile = join(directory, "compose.json");
  await writeFile(envFile, "");
  const env = { ...process.env, API_DATABASE_URL: "api", ADMIN_DATABASE_URL: "admin", WORKER_DATABASE_URL: "worker",
    MANAGER_DATABASE_URL: "manager", MIGRATOR_DATABASE_URL: "migrator", APP_ORIGIN: "http://example.test",
    WHATSAPP_LINK_CODE_KEY: "example", DEEPSEEK_API_KEY: "example", BAILEYS_KMS_VERSION: "1", BAILEYS_KMS_KEY: "example" };
  async function command(args: string[]) {
    const child = Bun.spawn(["docker", "compose", "--project-name", project, "--env-file", envFile, ...args], {
      env, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  try {
    const config = await command(["-f", "compose.production.yml", "config", "--format", "json"]);
    expect(config.code).toBe(0);
    const definition = JSON.parse(config.stdout);
    const migration = definition.services["agendia-db-migrate"];
    expect(migration).toBeDefined();
    expect(migration.build.target).toBe("db-setup");
    expect(migration.environment.DATABASE_URL).toBe("migrator");
    for (const name of ["agendia-api-runtime", "agendia-message-worker", "agendia-whatsapp-manager"]) {
      expect(definition.services[name].depends_on["agendia-db-migrate"].condition).toBe("service_completed_successfully");
      expect(Object.values(definition.services[name].environment)).not.toContain("migrator");
    }
    // Substitute inert containers while retaining the actual Compose dependency graph.
    for (const [name, service] of Object.entries(definition.services) as [string, any][]) {
      delete service.build;
      service.image = "postgres:16-alpine";
      service.networks = { isolated: {} };
      service.volumes = [{ type: "bind", source: directory, target: "/state" }];
      service.restart = "no";
      service.entrypoint = ["sh", "-c"];
      service.command = name === "agendia-db-migrate"
        ? ["test ! -e /state/fail || exit 42; echo migrate >> /state/events"]
        : [`echo ${name} >> /state/events; exec sleep 300`];
    }
    definition.networks = { isolated: {} };
    await writeFile(composeFile, JSON.stringify(definition));
    const consumers = ["agendia-api-runtime", "agendia-message-worker", "agendia-whatsapp-manager"];
    const up = () => command(["-f", composeFile, "up", "-d", ...consumers]);
    expect((await up()).code).toBe(0);
    let events = (await readFile(join(directory, "events"), "utf8")).trim().split("\n");
    expect(events.filter((event) => event === "migrate")).toHaveLength(1);
    for (const name of ["agendia-api-runtime", "agendia-message-worker", "agendia-whatsapp-manager"])
      expect(events.indexOf(name)).toBeGreaterThan(events.indexOf("migrate"));
    expect((await up()).code).toBe(0);
    events = (await readFile(join(directory, "events"), "utf8")).trim().split("\n");
    expect(events.filter((event) => event === "migrate")).toHaveLength(2);
    await writeFile(join(directory, "fail"), "");
    const failed = await command(["-f", composeFile, "up", "-d", "--force-recreate", ...consumers]);
    expect(failed.code).not.toBe(0);
    expect((await readFile(join(directory, "events"), "utf8")).trim().split("\n")).toEqual(events);
  } finally {
    if (await Bun.file(composeFile).exists()) await command(["-f", composeFile, "down", "--remove-orphans"]);
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { migrateDevelopmentDatabase, type MigrationDependencies } from "./db-migrate.ts";

function fixture(failure?: "list" | "read" | "execute" | "end") {
  const events: string[] = [];
  const dependencies: MigrationDependencies = {
    connect: () => {
      events.push("connect");
      return {
        unsafe: async (query) => {
          events.push(query);
          if (failure === "execute") throw new Error("private driver details");
        },
        end: async () => {
          events.push("end");
          if (failure === "end") throw new Error("close failed");
        },
      };
    },
    list: () => {
      if (failure === "list") throw new Error("list failed");
      return ["0002.sql", "notes.md", "0001.sql"];
    },
    read: (name) => {
      if (failure === "read") throw new Error("read failed");
      return name;
    },
  };
  return { dependencies, events };
}

test("replays SQL only in filename order and closes on success", async () => {
  const { dependencies, events } = fixture();
  await migrateDevelopmentDatabase("configured", dependencies);
  expect(events).toEqual(["connect", "0001.sql", "0002.sql", "end"]);
});

for (const failure of ["list", "read", "execute", "end"] as const) {
  test(`closes the connection and rejects on ${failure} failure`, async () => {
    const { dependencies, events } = fixture(failure);
    await expect(migrateDevelopmentDatabase("configured", dependencies)).rejects.toThrow();
    expect(events.at(-1)).toBe("end");
    expect(events.filter((event) => event === "end")).toHaveLength(1);
  });
}

for (const url of ["", "   "]) {
  test(`rejects missing/blank configuration before connecting (${JSON.stringify(url)})`, async () => {
    const { dependencies, events } = fixture();
    await expect(migrateDevelopmentDatabase(url, dependencies)).rejects.toThrow("DATABASE_URL is required");
    expect(events).toEqual([]);
  });
}

test("CLI exits nonzero for empty DATABASE_URL despite automatic env loading", async () => {
  const child = Bun.spawn([process.execPath, "run", "scripts/db-migrate.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr.trim()).toBe("DATABASE_URL is required");
});

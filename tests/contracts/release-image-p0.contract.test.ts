import { describe, expect, test } from "bun:test";
import {
  inspectReleaseLayout,
  releaseCommands,
  writableMounts,
} from "../../scripts/release-build-p0.ts";
import nextConfig from "../../apps/web/next.config.ts";
import { runRuntimeProbe } from "../../deploy/p0/runtime-probe.ts";

const completeLayout = [
  "api/index.js",
  "api/argon2.linux-x64-gnu.node",
  "whatsapp-manager/index.js",
  "message-worker/index.js",
  "probe/runtime-probe.js",
  "web/server.js",
  "web/.next/static/chunks/app.js",
];

describe("P0 release image feasibility contract", () => {
  test("fails closed when the native argon2 asset is deliberately omitted", () => {
    expect(
      inspectReleaseLayout(
        completeLayout.filter((path) => !path.includes("argon2")),
      ),
    ).toEqual({ viable: false, missing: ["native-argon2"] });
  });

  test("accepts generated output containing native, dynamic, and static runtime assets", () => {
    expect(nextConfig).toMatchObject({
      output: "standalone",
      outputFileTracingRoot: process.cwd(),
    });
    expect(inspectReleaseLayout(completeLayout)).toEqual({
      viable: true,
      missing: [],
    });
    expect(
      Object.values(releaseCommands).every(
        (command) => !/(tsx|next dev|src\/|\.ts\b)/.test(command.join(" ")),
      ),
    ).toBe(true);
  });

  test("loads native argon2 and Baileys runtime behavior through a deterministic socket", async () => {
    expect(await runRuntimeProbe("native")).toEqual({ nativeArgon2: true });
    expect(await runRuntimeProbe("baileys")).toMatchObject({
      baileys: true,
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      qr: "p0-deterministic-qr",
    });
  });

  test("triangulates Baileys and Next omissions and exact writable mounts", () => {
    expect(
      inspectReleaseLayout(
        completeLayout.filter((path) => path !== "probe/runtime-probe.js"),
      ).missing,
    ).toEqual(["dynamic-baileys-probe"]);
    expect(
      inspectReleaseLayout(
        completeLayout.filter((path) => !path.includes(".next/static")),
      ).missing,
    ).toEqual(["next-static"]);
    expect(writableMounts).toEqual({
      web: ["/tmp", "/run/agendia/web", "/opt/agendia/web/.next/cache"],
      api: ["/tmp", "/run/agendia/api"],
      "whatsapp-manager": ["/tmp", "/run/agendia/whatsapp-manager"],
      "message-worker": ["/tmp", "/run/agendia/message-worker"],
    });
  });
});

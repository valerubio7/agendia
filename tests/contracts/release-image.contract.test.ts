import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("universal release image", () => {
  test("fails closed when release bases are unpinned or runtime layout includes source tooling", () => {
    const dockerfile = read("Dockerfile");
    const lock = read("deploy/images.lock");
    const ignore = read(".dockerignore");
    expect(lock).toMatch(/oven\/bun@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toMatch(/FROM oven\/bun@sha256:[a-f0-9]{64} AS builder/);
    expect(dockerfile).toMatch(/FROM oven\/bun@sha256:[a-f0-9]{64} AS runtime/);
    expect(dockerfile).toMatch(/USER 10001:10001/);
    expect(dockerfile).not.toMatch(/next dev|tsx|COPY \. \/opt\/agendia/);
    expect(ignore).toContain(".env*");
    expect(ignore).toContain("tests/");
  });

  test("dispatches every supported release command from generated output only", () => {
    const dockerfile = read("Dockerfile");
    const dispatcher = read("deploy/entrypoint");
    expect(dockerfile).toContain("/release/api");
    expect(dockerfile).toContain("/release/web");
    expect(dispatcher).toMatch(/web\|api\|whatsapp-manager\|message-worker\|migrate\|queue-init\|bootstrap-admin\|verify-config/);
    for (const command of ["web", "api", "whatsapp-manager", "message-worker"])
      expect(dispatcher).toContain(`${command})`);
  });

  test("keeps Next standalone and native runtime output independently present", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/\.next\/standalone/);
    expect(dockerfile).toMatch(/argon2\.linux-x64/);
  });
});

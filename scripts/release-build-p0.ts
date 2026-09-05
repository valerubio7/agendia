import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const releaseCommands: Record<string, string[]> = {
  web: ["bun", "/opt/agendia/web/server.js"],
  api: ["bun", "/opt/agendia/api/index.js"],
  "whatsapp-manager": ["bun", "/opt/agendia/whatsapp-manager/index.js"],
  "message-worker": ["bun", "/opt/agendia/message-worker/index.js"],
};

export const writableMounts: Record<string, string[]> = {
  web: ["/tmp", "/run/agendia/web", "/opt/agendia/web/.next/cache"],
  api: ["/tmp", "/run/agendia/api"],
  "whatsapp-manager": ["/tmp", "/run/agendia/whatsapp-manager"],
  "message-worker": ["/tmp", "/run/agendia/message-worker"],
};

export function inspectReleaseLayout(paths: string[]) {
  const missing: string[] = [];
  if (
    !paths.some((path) =>
      /^api\/argon2\.linux-x64-(gnu|musl).*\.node$/.test(path),
    )
  )
    missing.push("native-argon2");
  if (!paths.includes("probe/runtime-probe.js"))
    missing.push("dynamic-baileys-probe");
  if (!paths.some((path) => path.startsWith("web/.next/static/")))
    missing.push("next-static");
  return { viable: missing.length === 0, missing };
}

export function listFiles(root: string, directory = root): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? listFiles(root, path)
        : [relative(root, path)];
    })
    .sort();
}

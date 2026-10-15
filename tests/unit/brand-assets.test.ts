import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Approved handoff bytes: fixed pins, independent of the external identity repository.
const resources = [
  ["brand/avatar.svg", 321, "61c52cca7cd30bbf70b5d3083de5af53a8b3bebfc9f61e8679873735fa208916"],
  ["brand/favicon.svg", 315, "5d1e4bb9faa67137482d2822bdaf31523a70b574839f6e73e02cc9d4d275569d"],
  ["brand/logo-inverse.svg", 553, "0ee47b2c77af7b0f7f31cb42a23f37a8ef8249939c8b919a6b867b4f47332c77"],
  ["brand/logo-mono.svg", 415, "797c2a55bfb00de4d6c703f195a221e7406c80fbfe30bfeccef471cdec5afae1"],
  ["brand/logo-primary.svg", 586, "91c6bc52d1efe5a5ab2aaf23f43bad50578ef9c4aee0306e6cd8abd4c71a1103"],
  ["brand/logo-symbol-inverse.svg", 257, "8e979b1d4b306e8e10de4c6bd9e926eed2d83b4d4d92ff8a47992e24b3dc2d6c"],
  ["brand/logo-symbol.svg", 320, "31dbc0953e5b46f2afa73c047daeb97905e012e1e7eb77c14bf03023f7c1896f"],
  ["brand/logo-wordmark.svg", 466, "f8c72a599f249068b844cf0ee2977d716c6dddf6d59301c341a3ff346a3249bb"],
  ["fonts/Bricolage.ttf", 408496, "413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682"],
  ["fonts/JetBrainsMono.ttf", 187208, "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda"],
  ["fonts/SourceSans3.ttf", 646340, "042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9"],
] as const;

const publicRoot = new URL("../../apps/web/public/", import.meta.url);

describe("official local brand resources", () => {
  test.each(resources)("%s retains approved bytes as an ordinary local file", (relativePath, size, sha256) => {
    const path = fileURLToPath(new URL(relativePath, publicRoot));
    const stat = lstatSync(path);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(realpathSync(path)).toBe(path);
    const bytes = readFileSync(path);
    expect(bytes.byteLength).toBe(size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  });
});

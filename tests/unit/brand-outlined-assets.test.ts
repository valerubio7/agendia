import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pins = {
  "brand/avatar.svg": "61c52cca7cd30bbf70b5d3083de5af53a8b3bebfc9f61e8679873735fa208916",
  "brand/favicon.svg": "5d1e4bb9faa67137482d2822bdaf31523a70b574839f6e73e02cc9d4d275569d",
  "brand/logo-inverse.svg": "0ee47b2c77af7b0f7f31cb42a23f37a8ef8249939c8b919a6b867b4f47332c77",
  "brand/logo-mono.svg": "797c2a55bfb00de4d6c703f195a221e7406c80fbfe30bfeccef471cdec5afae1",
  "brand/logo-primary.svg": "91c6bc52d1efe5a5ab2aaf23f43bad50578ef9c4aee0306e6cd8abd4c71a1103",
  "brand/logo-symbol-inverse.svg": "8e979b1d4b306e8e10de4c6bd9e926eed2d83b4d4d92ff8a47992e24b3dc2d6c",
  "brand/logo-symbol.svg": "31dbc0953e5b46f2afa73c047daeb97905e012e1e7eb77c14bf03023f7c1896f",
  "brand/logo-wordmark.svg": "f8c72a599f249068b844cf0ee2977d716c6dddf6d59301c341a3ff346a3249bb",
  "fonts/Bricolage.ttf": "413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682",
  "fonts/JetBrainsMono.ttf": "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda",
  "fonts/SourceSans3.ttf": "042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9",
};
const root = fileURLToPath(new URL("../../apps/web/public/", import.meta.url));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function read(path: string) {
  const full = root + path;
  expect(lstatSync(full).isFile()).toBe(true);
  expect(lstatSync(full).isSymbolicLink()).toBe(false);
  expect(realpathSync(full)).toBe(full);
  return readFileSync(full, "utf8");
}
function lettering(source: string, output: string) {
  const match = /<text\b[^>]*>[\s\S]*?<\/text>/.exec(source)!;
  const prefix = source.slice(0, match.index);
  const suffix = source.slice(match.index + match[0].length);
  if (!output.startsWith(prefix) || !output.endsWith(suffix)) throw Error("nontext changed");
  const body = output.slice(prefix.length, -suffix.length);
  if (!/<path\b[^>]*\bd="[^"]+"/.test(body)) throw Error("missing lettering");
  if (/<\/?(?!g\b|path\b)[a-zA-Z]|\b(?:font[^=\s]*|href|id)=|font|url\(|<!|<\?/.test(body)) {
    throw Error("lettering dependency");
  }
  return body;
}
function outputHash(output: string, expected: string) {
  if (sha(output) !== expected) throw Error("output hash mismatch");
}

test("outlined provenance binds original resources and the private reference recipe", () => {
  const manifest = JSON.parse(read("brand/outlined-provenance.json"));
  expect(manifest.generated).toBe(true);
  expect(manifest.recipe).toBe("raw-text-only/rsvg-svg/literal-splice/strict-reference-v1");
  expect(manifest.effective_axes).toBe(null);
  expect(manifest.axis_overrides).toEqual([]);
  expect(manifest.sources).toEqual(pins);
  for (const [path, hash] of Object.entries(pins)) {
    expect(sha(readFileSync(root + path))).toBe(hash);
  }
  expect(manifest.font.sha256).toBe("413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682");
  expect(manifest.font).toMatchObject({ file: "font-input/Bricolage.ttf", index: "0", weight: "205" });
  expect(sha(manifest.fontconfig)).toBe(manifest.fontconfig_sha256);
  expect(manifest.fontconfig_sha256).toBe("a11137a7d87ad79efa5ec2ffa9d58894c1f011ed69337125e2c591630d50c488");
  expect(manifest.fontconfig).toContain('<alias binding="strong">');
  expect(manifest.fontconfig).not.toMatch(/<include|<match|axis|\/home\//);
  expect(Object.keys(manifest.versions)).toEqual(["rsvg", "fontconfig", "magick", "cairo", "pango", "harfbuzz"]);
  for (const version of Object.values(manifest.versions)) expect(version).toBeTruthy();
});

for (const name of ["primary", "inverse", "mono", "wordmark"]) {
  test(`${name} retains its literal source envelope with dependency-free lettering`, () => {
    const manifest = JSON.parse(read("brand/outlined-provenance.json"));
    const source = read(`brand/logo-${name}.svg`);
    const output = read(`brand/logo-${name}-outlined.svg`);
    const record = manifest.outputs[name];
    const body = lettering(source, output);
    outputHash(output, record.sha256);
    expect(record.nontext).toBe("BYTE_EQUAL_PREFIX_SUFFIX");
    expect(record.determinism).toBe("EXACT_BYTES");
    expect(record.source_params.viewBox).toBe(name === "wordmark" ? "0 0 300 90" : "0 0 388 120");
    const attributes = Object.fromEntries([...source.match(/<text\b[^>]*>/)![0].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(record.source_params.text).toEqual(attributes);
    expect(record.source_params.text["font-size"]).toBe(name === "wordmark" ? "56" : "58");
    for (const [label, factor] of [["normal", 1], ["high", 4]] as const) {
      expect(record.reference[label]).toEqual({ dimensions: name === "wordmark" ? [300 * factor, 90 * factor] : [388 * factor, 120 * factor], AE: "0 (0)", RMSE: "0 (0)", exit: 0 });
    }
    expect(() => lettering(source, "BAD" + output)).toThrow("nontext changed");
    expect(() => lettering(source, output + "BAD")).toThrow("nontext changed");
    expect(() => lettering(source, output.replace(body, ""))).toThrow("missing lettering");
    for (const node of ['<text font-family="external">x</text>', '<script/>', '<use href="https://invalid/"/>']) {
      expect(() => lettering(source, output.replace(body, body + node))).toThrow("lettering dependency");
    }
    expect(() => outputHash(output, "0".repeat(64))).toThrow("output hash mismatch");
  });
}

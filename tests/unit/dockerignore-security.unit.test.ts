import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("local Docker context excludes the root cookie export using synthetic paths only", () => {
  const rules = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")
    .split(/\r?\n/).map(rule => rule.trim()).filter(rule => rule && !rule.startsWith("#"));
  // This exact root rule needs no Docker build or access to the protected file.
  expect(rules).toContain("/biz_cookies.txt");
  const excluded = (path: string) => rules.reduce((ignored, rule) => {
    const negative = rule.startsWith("!");
    const pattern = negative ? rule.slice(1) : rule;
    return pattern.replace(/^\//, "") === path ? !negative : ignored;
  }, false);
  expect(excluded("biz_cookies.txt")).toBe(true);
  expect(excluded("synthetic-source.ts")).toBe(false);
});

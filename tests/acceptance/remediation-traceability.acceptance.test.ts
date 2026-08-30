import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  acceptanceTraceability,
  collectNormativeIds,
  criticalSemanticMappings,
  semanticAssertions,
  validateAcceptanceTraceability,
} from "../../packages/test-support/src/v1-traceability.ts";

const load = (path: string) => readFileSync(path, "utf8");
const sources = {
  proposal: load("openspec/changes/agendia-v1/proposal.md"),
  specs: Object.fromEntries(
    [
      "administration-and-isolation",
      "configuration-and-whatsapp",
      "messaging-and-ai",
      "persistence-and-operations",
    ].map((name) => [
      name,
      load(`openspec/changes/agendia-v1/specs/${name}/spec.md`),
    ]),
  ),
  acceptanceDoc: load("docs/acceptance.md"),
  tddEvidence: load("docs/tdd-remediation-evidence.md"),
  readEvidenceFile: load,
};

describe("executable v1 acceptance traceability", () => {
  test("maps every current requirement, scenario and proposal criterion to exact executable evidence", () => {
    const ids = collectNormativeIds(sources);
    expect(ids).toHaveLength(82);
    expect(
      validateAcceptanceTraceability(sources, acceptanceTraceability),
    ).toEqual([]);
    expect(Object.keys(acceptanceTraceability)).toHaveLength(ids.length);
  });

  test("fails closed for every acceptance and semantic anti-bypass mutation", () => {
    const criticalId = "messaging-and-ai:scenario:evento-de-sesion-conocida";
    const systemEntry = Object.entries(acceptanceTraceability).find(
      ([, item]) => item.layer === "system-e2e",
    )!;
    const cases: Array<{
      name: string;
      mutate: (
        mapping: typeof acceptanceTraceability,
        catalog: typeof semanticAssertions,
      ) => void;
      expected: string;
    }> = [
      {
        name: "removed acceptance mapping",
        mutate: (mapping) => {
          delete mapping[criticalId];
        },
        expected: `missing mapping: ${criticalId}`,
      },
      {
        name: "renamed mapping",
        mutate: (mapping) => {
          mapping[`${criticalId}-renamed`] = mapping[criticalId]!;
          delete mapping[criticalId];
        },
        expected: `obsolete mapping: ${criticalId}-renamed`,
      },
      {
        name: "extra obsolete mapping",
        mutate: (mapping) => {
          mapping["obsolete:scenario"] = mapping[criticalId]!;
        },
        expected: "obsolete mapping: obsolete:scenario",
      },
      {
        name: "semantic catalog key/id mismatch",
        mutate: (_mapping, catalog) => {
          catalog["socket-ingress"] = {
            ...catalog["socket-ingress"]!,
            id: "renamed-socket-ingress",
          };
        },
        expected:
          "semantic assertion id mismatch: socket-ingress != renamed-socket-ingress",
      },
      {
        name: "missing assertion",
        mutate: (_mapping, catalog) => {
          delete catalog["socket-ingress"];
        },
        expected: "missing semantic assertion: socket-ingress",
      },
      {
        name: "unrelated critical mapping",
        mutate: (mapping) => {
          mapping[criticalId]!.assertions = ["safe-audit-activity"];
        },
        expected: `semantic mismatch: ${criticalId} requires ${criticalSemanticMappings[criticalId]}`,
      },
      {
        name: "obsolete production path",
        mutate: (_mapping, catalog) => {
          catalog["socket-ingress"]!.production = ["apps/obsolete-inbound.ts"];
        },
        expected:
          "obsolete production boundary: socket-ingress:apps/obsolete-inbound.ts",
      },
      {
        name: "historical renderer harness rejection",
        mutate: (mapping) => {
          mapping[systemEntry[0]] = {
            ...systemEntry[1],
            file: "tests/e2e/acceptance.spec.ts",
          };
        },
        expected: `invalid system E2E evidence: ${systemEntry[0]}`,
      },
    ];
    for (const item of cases) {
      const mapping = structuredClone(acceptanceTraceability),
        catalog = structuredClone(semanticAssertions);
      item.mutate(mapping, catalog);
      expect(
        validateAcceptanceTraceability(sources, mapping, catalog),
        item.name,
      ).toContain(item.expected);
    }
  });

  test("rejects bypassed runtime assertion markers", () => {
    for (const assertion of Object.values(semanticAssertions)) {
      const bypassed = {
        ...sources,
        readEvidenceFile: (path: string) =>
          path === assertion.file
            ? load(path).replace(assertion.marker, "unrelated scenario text")
            : load(path),
      };
      expect(
        validateAcceptanceTraceability(
          bypassed,
          acceptanceTraceability,
          semanticAssertions,
        ),
      ).toContain(`missing runtime semantic assertion: ${assertion.id}`);
    }
  });

  test("keeps focused acceptance in the aggregate blocking test command", () => {
    const scripts = JSON.parse(load("package.json")).scripts as Record<
      string,
      string
    >;
    expect(scripts["test:acceptance"]).toBe("bun test tests/acceptance");
    expect(scripts.test).toContain("bun run test:acceptance");
  });
});

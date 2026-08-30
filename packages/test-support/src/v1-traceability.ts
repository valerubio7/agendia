import { existsSync, readFileSync } from "node:fs";

export type EvidenceLayer =
  | "contract"
  | "integration"
  | "isolation"
  | "system-e2e"
  | "operational";
export interface AcceptanceEvidence {
  layer: EvidenceLayer;
  file: string;
  test: string;
  command: string;
  tddUnit: number;
  assertions?: string[];
}
export interface SemanticAssertion {
  id: string;
  file: string;
  test: string;
  command: string;
  marker: string;
  boundary: string;
  production: string[];
}
export interface AcceptanceSources {
  proposal: string;
  specs: Record<string, string>;
  acceptanceDoc: string;
  tddEvidence: string;
  readEvidenceFile?: (path: string) => string;
}

const cmd = (value: string) => `PATH="$HOME/.bun/bin:$PATH" ${value}`;
const evidence = (
  layer: EvidenceLayer,
  file: string,
  test: string,
  command: string,
  tddUnit: number,
  assertions?: string[],
): AcceptanceEvidence => ({
  layer,
  file,
  test,
  command: cmd(command),
  tddUnit,
  ...(assertions ? { assertions } : {}),
});
const happyFile = "tests/e2e/system-happy-path.spec.ts",
  failureFile = "tests/e2e/system-failure-isolation.spec.ts";
const happyTest =
    "real services complete the deterministic multi-tenant happy path",
  failureTest =
    "contains hostile access and provider failures while preserving isolated recovery";
const semantic = (
  id: string,
  file: string,
  test: string,
  boundary: string,
  production: string[],
): SemanticAssertion => ({
  id,
  file,
  test,
  boundary,
  production,
  command: cmd(`bunx playwright test ${file} --project=system`),
  marker: `assertSemanticBoundary("${id}"`,
});
export const semanticAssertions: Record<string, SemanticAssertion> =
  Object.fromEntries(
    [
      semantic(
        "socket-ingress",
        happyFile,
        happyTest,
        "Baileys messages.upsert → production inbound",
        [
          "packages/whatsapp-baileys/src/baileys-gateway.ts",
          "apps/whatsapp-manager/src/inbound-handler.ts",
        ],
      ),
      semantic(
        "socket-ingress-filters",
        failureFile,
        failureTest,
        "Baileys messages.upsert rejects unknown/group/fromMe/media",
        [
          "packages/whatsapp-baileys/src/baileys-gateway.ts",
          "apps/whatsapp-manager/src/inbound-handler.ts",
        ],
      ),
      semantic(
        "exact-recipient",
        happyFile,
        happyTest,
        "owned outbound remote_jid → Baileys sendMessage",
        [
          "apps/whatsapp-manager/src/outbound-dispatcher.ts",
          "packages/whatsapp-baileys/src/baileys-gateway.ts",
        ],
      ),
      semantic(
        "qr-visible-ui",
        happyFile,
        happyTest,
        "socket QR → encrypted store → owner API → browser",
        [
          "apps/whatsapp-manager/src/lifecycle.ts",
          "apps/api/src/app.ts",
          "apps/web/src/live-panel.tsx",
        ],
      ),
      semantic(
        "qr-lifecycle-api",
        failureFile,
        failureTest,
        "owner-only no-store QR expiry/open lifecycle",
        ["apps/whatsapp-manager/src/lifecycle.ts", "apps/api/src/app.ts"],
      ),
      semantic(
        "durable-outbox-recovery",
        failureFile,
        failureTest,
        "committed ai.generate outbox → pg-boss → restarted worker",
        [
          "apps/whatsapp-manager/src/ai-outbox-dispatcher.ts",
          "apps/message-worker/src/index.ts",
        ],
      ),
      semantic(
        "summary-update",
        happyFile,
        happyTest,
        "raw history → monotonic summary → response context",
        [
          "apps/message-worker/src/ai-job.ts",
          "packages/db/src/repositories.ts",
        ],
      ),
      semantic(
        "summary-fallback",
        failureFile,
        failureTest,
        "summary failure → safe event/current response → restart recovery",
        [
          "apps/message-worker/src/ai-job.ts",
          "packages/db/src/repositories.ts",
        ],
      ),
      semantic(
        "safe-audit-activity",
        failureFile,
        failureTest,
        "runtime failures → safe audit/activity → admin UI",
        [
          "packages/db/src/repositories.ts",
          "apps/api/src/app.ts",
          "apps/web/src/live-panel.tsx",
        ],
      ),
    ].map((item) => [item.id, item]),
  );
export const criticalSemanticMappings: Record<string, string> = {
  "messaging-and-ai:scenario:evento-de-sesion-conocida": "socket-ingress",
  "messaging-and-ai:scenario:evento-de-sesion-desconocida":
    "socket-ingress-filters",
  "messaging-and-ai:scenario:respuesta-basada-en-el-negocio": "exact-recipient",
  "configuration-and-whatsapp:scenario:vinculacion-correcta":
    "qr-lifecycle-api",
  "proposal:criterion:8": "qr-visible-ui",
  "persistence-and-operations:scenario:recuperacion-de-estado-persistido":
    "durable-outbox-recovery",
  "messaging-and-ai:scenario:contexto-completo-del-mismo-chat":
    "summary-update",
  "persistence-and-operations:scenario:fallos-tecnicos-criticos-auditables":
    "safe-audit-activity",
};
const E = {
  admin: evidence(
    "integration",
    "tests/integration/http-auth-admin-me.integration.test.ts",
    "supports admin CRUD, user password replacement, status and safe role/ID rejection",
    "bun test tests/integration/http-auth-admin-me.integration.test.ts",
    21,
  ),
  auth: evidence(
    "integration",
    "tests/integration/http-auth-admin-me.integration.test.ts",
    "sets a secure opaque cookie and enforces expiration, logout, CSRF and Origin",
    "bun test tests/integration/http-auth-admin-me.integration.test.ts",
    21,
  ),
  tenant: evidence(
    "isolation",
    "tests/integration/tenant-rls.integration.test.ts",
    "denies cross-tenant data across every v1 repository boundary",
    "bun run test:tenant-isolation",
    19,
  ),
  happy: evidence(
    "system-e2e",
    happyFile,
    happyTest,
    "bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system",
    33,
    ["socket-ingress", "exact-recipient", "qr-visible-ui", "summary-update"],
  ),
  failure: evidence(
    "system-e2e",
    failureFile,
    failureTest,
    "bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system",
    33,
    [
      "socket-ingress-filters",
      "qr-lifecycle-api",
      "durable-outbox-recovery",
      "summary-fallback",
      "safe-audit-activity",
    ],
  ),
  baileys: evidence(
    "integration",
    "tests/integration/baileys-manager-persistence.integration.test.ts",
    "claims a durable API link command, owns one advisory lock, heartbeats and restores",
    "bun test tests/integration/baileys-manager-persistence.integration.test.ts",
    22,
  ),
  worker: evidence(
    "integration",
    "tests/integration/message-processing-worker.integration.test.ts",
    "routes before tenant access, deduplicates and filters text-only events",
    "bun test tests/integration/message-processing-worker.integration.test.ts",
    23,
  ),
  context: evidence(
    "integration",
    "tests/integration/message-processing-worker.integration.test.ts",
    "generates monotonic summaries from ordered raw history without blocking responses",
    "bun test tests/integration/message-processing-worker.integration.test.ts",
    31,
  ),
  delivery: evidence(
    "integration",
    "tests/integration/message-processing-worker.integration.test.ts",
    "dispatches once through the owned connection and preserves crash ambiguity",
    "bun test tests/integration/message-processing-worker.integration.test.ts",
    23,
  ),
  provider: evidence(
    "contract",
    "tests/contracts/worker-provider.contract.test.ts",
    "keeps DeepSeek behind AiProvider with a deterministic fetch boundary",
    "bun run test:contracts",
    23,
  ),
  restore: evidence(
    "operational",
    "scripts/restore-drill.ts",
    "restore drill passed:",
    "bun run backup:drill",
    26,
  ),
  scope: evidence(
    "operational",
    "scripts/scope-check.ts",
    "scope:check passed:",
    "bun run scope:check",
    27,
  ),
} as const;

const slug = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const group = (
  spec: string,
  requirement: string,
  scenarios: string[],
  item: AcceptanceEvidence,
) => [
  [`${spec}:requirement:${requirement}`, item] as const,
  ...scenarios.map(
    (scenario) => [`${spec}:scenario:${scenario}`, item] as const,
  ),
];
const criterion = (numbers: number[], item: AcceptanceEvidence) =>
  numbers.map((number) => [`proposal:criterion:${number}`, item] as const);

export const acceptanceTraceability: Record<string, AcceptanceEvidence> =
  Object.fromEntries([
    ...group(
      "administration-and-isolation",
      "autenticacion-y-administracion-de-plataforma",
      ["administracion-autorizada", "administracion-sin-autorizacion"],
      E.admin,
    ),
    ...group(
      "administration-and-isolation",
      "un-unico-usuario-de-negocio-y-ambito-de-acceso",
      ["usuario-opera-su-propio-negocio", "intento-de-cruzar-tenants"],
      E.auth,
    ),
    ...group(
      "administration-and-isolation",
      "autorizacion-y-aislamiento-estricto-por-tenant",
      [
        "acceso-indirecto-a-datos-de-otro-tenant",
        "datos-de-identidad-invalidos",
      ],
      E.tenant,
    ),
    ...group(
      "administration-and-isolation",
      "ciclo-de-vida-del-negocio",
      [
        "suspension-contiene-la-operacion",
        "reactivacion-preserva-el-estado-del-asistente",
      ],
      E.failure,
    ),
    ...group(
      "administration-and-isolation",
      "estados-de-supervision-administrativa",
      ["supervision-de-estado", "visibilidad-limitada-del-usuario-de-negocio"],
      E.happy,
    ),
    ...group(
      "configuration-and-whatsapp",
      "configuracion-comercial-por-negocio",
      [
        "guardado-de-informacion-comercial",
        "datos-invalidos-o-de-otro-negocio",
      ],
      E.happy,
    ),
    ...group(
      "configuration-and-whatsapp",
      "configuracion-y-activacion-del-asistente",
      ["activacion-con-configuracion-valida-minima", "asistente-inactivo"],
      E.failure,
    ),
    ...group(
      "configuration-and-whatsapp",
      "vinculacion-unica-de-whatsapp-mediante-baileys",
      ["vinculacion-correcta", "segundo-vinculo-no-permitido"],
      E.failure,
    ),
    ...group(
      "configuration-and-whatsapp",
      "estado-y-metadatos-de-la-sesion-de-whatsapp",
      ["desconexion-observable", "sesion-no-disponible-para-envio"],
      E.failure,
    ),
    ...group(
      "configuration-and-whatsapp",
      "proteccion-de-material-sensible",
      ["consulta-de-material-de-sesion-por-usuario-no-autorizado"],
      E.failure,
    ),
    ...group(
      "messaging-and-ai",
      "resolucion-de-sesion-y-tenant-antes-del-acceso",
      ["evento-de-sesion-conocida"],
      E.happy,
    ),
    ...group(
      "messaging-and-ai",
      "resolucion-de-sesion-y-tenant-antes-del-acceso",
      ["evento-de-sesion-desconocida"],
      E.failure,
    ),
    ...group(
      "messaging-and-ai",
      "admisibilidad-de-mensajes-entrantes",
      ["texto-individual-admisible"],
      E.happy,
    ),
    ...group(
      "messaging-and-ai",
      "admisibilidad-de-mensajes-entrantes",
      ["evento-no-admisible"],
      E.failure,
    ),
    ...group(
      "messaging-and-ai",
      "historial-conversacional-completo-y-aislado",
      ["contexto-completo-del-mismo-chat", "no-cruce-entre-chats-o-tenants"],
      E.happy,
    ),
    ...group(
      "messaging-and-ai",
      "respuesta-contextual-mediante-deepseek",
      [
        "respuesta-basada-en-el-negocio",
        "credenciales-de-ia-fuera-del-navegador",
      ],
      E.happy,
    ),
    ...group(
      "messaging-and-ai",
      "limite-reemplazable-del-proveedor-de-ia",
      ["dependencia-de-proveedor-contenida"],
      E.provider,
    ),
    ...group(
      "messaging-and-ai",
      "fallo-de-ia-y-envio-de-respuestas",
      ["indisponibilidad-de-deepseek", "fallo-de-envio"],
      E.failure,
    ),
    ...group(
      "messaging-and-ai",
      "operacion-continua-del-asistente-activo",
      ["consulta-fuera-de-horario-comercial"],
      E.happy,
    ),
    ...group(
      "persistence-and-operations",
      "persistencia-principal-y-alcance-de-datos",
      ["recuperacion-de-estado-persistido", "negocio-inexistente"],
      E.failure,
    ),
    ...group(
      "persistence-and-operations",
      "auditoria-de-eventos-criticos",
      [
        "cambio-critico-auditable",
        "fallos-tecnicos-criticos-auditables",
        "auditoria-no-accesible-entre-tenants",
      ],
      E.failure,
    ),
    ...group(
      "persistence-and-operations",
      "actividad-tecnica-errores-y-visibilidad-segura",
      ["fallo-tecnico-visible-al-administrador", "error-sin-filtracion"],
      E.failure,
    ),
    ...group(
      "persistence-and-operations",
      "sin-visor-de-conversaciones-en-agendia",
      ["panel-sin-consulta-de-conversaciones"],
      E.scope,
    ),
    ...group(
      "persistence-and-operations",
      "validacion-y-tratamiento-seguro-de-errores",
      [
        "solicitud-invalida-no-produce-efectos",
        "mensaje-de-negocio-suspendido",
      ],
      E.failure,
    ),
    ...criterion([1, 2, 3], E.admin),
    ...criterion([4, 5], E.tenant),
    ...criterion([6, 7], E.happy),
    ...criterion([8], E.happy),
    ...criterion([9], E.failure),
    ...criterion([10, 11], E.happy),
    ...criterion([12], E.context),
    ...criterion([13, 14], E.happy),
    ...criterion([15, 16, 17], E.failure),
    ...criterion([18], E.scope),
    ...criterion([19], E.provider),
  ]);

export function collectNormativeIds(
  sources: Pick<AcceptanceSources, "proposal" | "specs">,
): string[] {
  const ids = Object.entries(sources.specs).flatMap(([spec, text]) => [
    ...[...text.matchAll(/^### Requirement: (.+)$/gm)].map(
      (match) => `${spec}:requirement:${slug(match[1]!)}`,
    ),
    ...[...text.matchAll(/^#### Scenario: (.+)$/gm)].map(
      (match) => `${spec}:scenario:${slug(match[1]!)}`,
    ),
  ]);
  const success =
    sources.proposal.split("## Criterios de éxito")[1]?.split("\n## ")[0] ?? "";
  return [
    ...ids,
    ...[...success.matchAll(/^- \[ \] /gm)].map(
      (_, index) => `proposal:criterion:${index + 1}`,
    ),
  ];
}

const evidenceText = (sources: AcceptanceSources, path: string) =>
  sources.readEvidenceFile?.(path) ??
  (existsSync(path) ? readFileSync(path, "utf8") : "");

export function validateAcceptanceTraceability(
  sources: AcceptanceSources,
  mapping: Record<string, AcceptanceEvidence>,
  catalog: Record<string, SemanticAssertion> = semanticAssertions,
): string[] {
  const ids = collectNormativeIds(sources);
  const expected = new Set(ids);
  const findings: string[] = [];
  for (const id of ids)
    if (!mapping[id]) findings.push(`missing mapping: ${id}`);
  for (const id of Object.keys(mapping))
    if (!expected.has(id)) findings.push(`obsolete mapping: ${id}`);
  for (const id of Object.keys(semanticAssertions))
    if (!catalog[id]) findings.push(`missing semantic assertion: ${id}`);
  for (const [key, assertion] of Object.entries(catalog))
    if (key !== assertion.id)
      findings.push(
        `semantic assertion id mismatch: ${key} != ${assertion.id}`,
      );
  for (const assertion of Object.values(catalog)) {
    const source = evidenceText(sources, assertion.file);
    if (
      !/^tests\/e2e\/system-.*\.spec\.ts$/.test(assertion.file) ||
      !assertion.command.includes("--project=system") ||
      !source.includes(assertion.test)
    )
      findings.push(`invalid semantic system case: ${assertion.id}`);
    if (!source.includes(assertion.marker))
      findings.push(`missing runtime semantic assertion: ${assertion.id}`);
    for (const path of assertion.production)
      if (!existsSync(path))
        findings.push(`obsolete production boundary: ${assertion.id}:${path}`);
  }
  for (const [id, item] of Object.entries(mapping)) {
    if (
      !item.file ||
      !item.test ||
      !item.command.startsWith(cmd("")) ||
      !item.tddUnit
    )
      findings.push(`inexact evidence: ${id}`);
    if (
      item.layer === "system-e2e" &&
      (!/^tests\/e2e\/system-.*\.spec\.ts$/.test(item.file) ||
        !item.command.includes("--project=system") ||
        !item.assertions?.length)
    )
      findings.push(`invalid system E2E evidence: ${id}`);
    if (!evidenceText(sources, item.file).includes(item.test))
      findings.push(`missing exact test reference: ${id}`);
    if (!sources.tddEvidence.includes(`## Unidad ${item.tddUnit}`))
      findings.push(`missing TDD unit evidence: ${id}`);
  }
  for (const [id, assertion] of Object.entries(criticalSemanticMappings))
    if (!mapping[id]?.assertions?.includes(assertion))
      findings.push(`semantic mismatch: ${id} requires ${assertion}`);
  for (const spec of Object.keys(sources.specs))
    if (
      !sources.acceptanceDoc.includes(
        `openspec/changes/agendia-v1/specs/${spec}/spec.md`,
      )
    )
      findings.push(`missing acceptance document spec path: ${spec}`);
  if (
    !sources.acceptanceDoc.includes("tests/e2e/system-happy-path.spec.ts") ||
    !sources.acceptanceDoc.includes("tests/e2e/acceptance.spec.ts") ||
    !sources.acceptanceDoc.includes("históricos")
  )
    findings.push(
      "acceptance document does not distinguish system E2E from historical harnesses",
    );
  return findings;
}

# Aceptación y trazabilidad ejecutable de AgendIA v1

## Fuentes normativas vigentes

La fuente tipada `packages/test-support/src/v1-traceability.ts` asigna de forma exacta los **22 requisitos**, **41 escenarios** y **19 criterios de éxito** (82 IDs) extraídos de:

- `openspec/changes/agendia-v1/specs/administration-and-isolation/spec.md`
- `openspec/changes/agendia-v1/specs/configuration-and-whatsapp/spec.md`
- `openspec/changes/agendia-v1/specs/messaging-and-ai/spec.md`
- `openspec/changes/agendia-v1/specs/persistence-and-operations/spec.md`
- `openspec/changes/agendia-v1/proposal.md`, criterios 1–19.

Cada ID apunta a una ruta existente, nombre exacto de test o resultado operacional, comando literal con Bun y unidad TDD. `tests/acceptance/remediation-traceability.acceptance.test.ts` vuelve a extraer los IDs de Markdown y falla ante mappings ausentes, sobrantes, rutas renombradas, títulos inexistentes o evidencia TDD ausente.

## Catálogo de evidencia automatizada

| Capa | Evidencia exacta | Comando enfocado |
| --- | --- | --- |
| Contrato | `tests/contracts/worker-provider.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts` |
| Integración HTTP/PostgreSQL | `tests/integration/http-auth-admin-me.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/http-auth-admin-me.integration.test.ts` |
| Aislamiento RLS | `tests/integration/tenant-rls.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:tenant-isolation` |
| Baileys/manager | `tests/integration/baileys-manager-persistence.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/baileys-manager-persistence.integration.test.ts` |
| Workers | `tests/integration/message-processing-worker.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts` |
| E2E de sistema feliz | `tests/e2e/system-happy-path.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system` |
| E2E de sistema de fallos | `tests/e2e/system-failure-isolation.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system` |
| Operación | `scripts/restore-drill.ts`, `scripts/scope-check.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run backup:drill`; `PATH="$HOME/.bun/bin:$PATH" bun run scope:check` |

## Catálogo semántico anti-bypass

`semanticAssertions` enlaza cada assertion nombrada con el caso Playwright exacto, comando y frontera productiva. El validador falla si falta, se relabela, apunta a una ruta obsoleta o se asigna a un escenario normativo no relacionado.

| Assertion | Hecho observado en sistema | Frontera productiva |
| --- | --- | --- |
| `socket-ingress` / `socket-ingress-filters` | IDs emitidos por `messages.upsert` llegan a inbox o filtro sin handler directo | gateway → manager inbound |
| `exact-recipient` | JID vacío es rechazado y cada ACK coincide con `conversation.remote_jid` | claim owned outbound → `sendMessage` |
| `qr-visible-ui` / `qr-lifecycle-api` | QR owner-only aparece en UI, usa API `no-store` y desaparece por expiry/open | lifecycle → API → browser |
| `durable-outbox-recovery` | outbox persistido/publicado termina enviado tras reiniciar worker | outbox dispatcher → pg-boss → worker |
| `summary-update` / `summary-fallback` | watermark crece, entra al contexto y un fallo conserva respuesta/recovery | summary job → repositorio → context builder |
| `safe-audit-activity` | fallos críticos tenant-scoped y redactados actualizan actividad visible | runtime audit/activity → API → UI |

Las assertions usan hechos expuestos por el fixture del sistema; el navegador solo observa UI/API autorizadas y nunca inspecciona PostgreSQL. Los contratos/integraciones siguen siendo apoyo, no sustitutos de estos límites de sistema.

## E2E real frente a harnesses históricos

Solo los dos archivos `tests/e2e/system-*.spec.ts`, ejecutados por el proyecto Playwright `system`, arrancan navegador, Next, Fastify, manager, worker y PostgreSQL reales con dobles deterministas de Baileys/DeepSeek. El flujo feliz es **admin → tenant → vínculo único → mensaje → IA doble → ACK**. Los siete archivos históricos, incluido `tests/e2e/acceptance.spec.ts`, usan renderers o servicios en memoria; se conservan bajo `bun run test:harness`, pero **no** se etiquetan ni aceptan como E2E de sistema.

## Comandos bloqueantes

La aceptación enfocada es `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` y está incluida en `bun run test`. El cierre completo ejecuta, en orden, `bun run test`, `bun run test:e2e`, `bun run db:check`, `bun run backup:drill`, `bun run security:scan`, `bun run scope:check`, `bun run lint`, `bun run typecheck` y `bun run build`. Ningún comando usa credenciales o redes reales de WhatsApp o DeepSeek.

## Alcance negativo y reversión

No existen `/conversations` ni `/messages`. `scope:check` y los contratos HTTP mantienen ausentes registro, invitaciones, recuperación de contraseña, usuarios/sesiones adicionales y grupos/multimedia. La unidad 33 se revierte retirando únicamente catálogo/assertions semánticas, metadata de fixtures, validador y esta actualización documental; no modifica comportamiento de producto ni datos operativos. Los renderer harnesses históricos permanecen identificados como no-system.

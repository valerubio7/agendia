# Evidencia TDD de remediación

## Unidad 19 — Base estricta y gates reales (2026-08-26)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Scaffolding enfocado previo | — | — | — | — | `tests/scaffolding.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts` | 0 | 2 pass, 0 fail; no estaba agregado |
| Agregado previo | — | — | — | — | `package.json` | `PATH="$HOME/.bun/bin:$PATH" bun run test` | 0 | 55 unit, 9 integration, 6 contracts, 8 isolation, 7 E2E; scaffolding ausente |
| Check previo solo textual | — | — | — | — | `scripts/db-check.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run db:check` | 0 | 12 migraciones inspeccionadas como texto; no arrancó PostgreSQL |
| Tipos previos | — | — | — | — | `tsconfig.json` | `PATH="$HOME/.bun/bin:$PATH" bun run lint` | 0 | tsc sin errores |
| — | Agregado exige scaffolding | — | — | — | `tests/scaffolding.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts` | 1 | 2 pass, 1 fail; test:scaffolding era undefined |
| — | Colección vacía debe fallar | — | — | — | `tests/integration/tenant-rls.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/tenant-rls.integration.test.ts` | 1 | 0 pass, 1 fail, 1 error; assertNonEmptyTenantRows no exportado |
| — | Migración limpia y drift reales | — | — | — | `tests/integration/db-check.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/db-check.integration.test.ts` | 1 | 0 pass, 1 fail, 1 error; verifyPostgresMigrations no exportado |
| — | Registro TDD centralizado | — | — | — | `tests/scaffolding.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts` | 1 | 0 pass, 1 fail, 1 error; formatTddCycleRecord no exportado |
| — | — | Scaffolding agregado | — | — | `tests/scaffolding.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts` | 0 | 3 pass, 0 fail |
| — | — | Aislamiento no vacío | — | — | `tests/integration/tenant-rls.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/tenant-rls.integration.test.ts` | 0 | 9 pass, 0 fail |
| — | — | Dos PostgreSQL limpios coinciden | — | — | `tests/integration/db-check.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/db-check.integration.test.ts` | 0 | 3 pass, 0 fail |
| — | — | — | Migración inválida y drift rechazados | — | `tests/integration/db-check.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/db-check.integration.test.ts --test-name-pattern "rejects"` | 0 | 2 pass, 1 filtered, 0 fail |
| — | — | — | — | PostgreSQL y registro centralizados | `packages/test-support/src` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts && PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/tenant-rls.integration.test.ts && PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/db-check.integration.test.ts` | 0 | 4 scaffolding, 9 isolation y 3 db-check pass |
| — | — | — | — | Agregado final | `package.json` | `PATH="$HOME/.bun/bin:$PATH" bun run test` | 0 | 4 scaffolding, 55 unit, 13 integration, 6 contracts, 9 isolation, 7 E2E pass |
| — | — | — | — | Migración y drift final | `scripts/db-check.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run db:check` | 0 | 12 migraciones aplicadas dos veces; fingerprint 60fb35033be4eb62d0090ddd8e1c1fb2e4ab95de41bdc0307872b47bc54178a5 coincide |
| — | — | — | — | Gate final | `tsconfig.json` | `PATH="$HOME/.bun/bin:$PATH" bun run lint` | 0 | tsc sin errores |
| — | — | — | — | Gate final | `tsconfig.json` | `PATH="$HOME/.bun/bin:$PATH" bun run typecheck` | 0 | tsc sin errores |
| — | — | — | — | Gate final | `apps/web` | `PATH="$HOME/.bun/bin:$PATH" bun run build` | 0 | Next.js compiló y generó 7 páginas estáticas |

## Unidad 20 — PostgreSQL, UoW, grants y pg-boss (2026-08-26)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Integración previa | — | — | — | — | `tests/integration` | `PATH="$HOME/.bun/bin:$PATH" bun run test:integration` | 0 | 13 pass, 0 fail |
| Aislamiento previo | — | — | — | — | `tenant-rls.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:tenant-isolation` | 0 | 9 pass, 0 fail |
| — | Repositorios/UoW ausentes | — | — | — | `postgres-repositories.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/postgres-repositories.integration.test.ts` | 1 | 0 pass; export `createRuntimePools` ausente |
| — | Worker/pg-boss ausentes | — | — | — | `worker-grants-pgboss.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/worker-grants-pgboss.integration.test.ts` | 1 | 0 pass; export `createRuntimePools` ausente |
| — | — | Repositorios y UoW reales | — | — | `postgres-repositories.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/postgres-repositories.integration.test.ts` | 0 | 3 pass, 0 fail; persistencia, aislamiento y rollback |
| — | — | Worker mínimo y pg-boss | — | — | `worker-grants-pgboss.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/worker-grants-pgboss.integration.test.ts` | 0 | 2 pass, 0 fail |
| — | — | — | Segundo tenant sin outbox y denegaciones | — | `worker-grants-pgboss.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/worker-grants-pgboss.integration.test.ts` | 0 | 2 pass, 8 assertions |
| — | — | — | — | Contexto y login de rol extraídos | `packages/test-support/src/postgres.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/postgres-repositories.integration.test.ts tests/integration/worker-grants-pgboss.integration.test.ts` | 0 | 5 pass, 18 assertions |
| — | — | — | — | Gates finales | `tests/integration` | `PATH="$HOME/.bun/bin:$PATH" bun run test:integration && bun run test:tenant-isolation && bun run db:check && bun run test && bun run lint && bun run typecheck` | 0 | 18 integración, 9 aislamiento; 13 migraciones; agregado, lint y tipos verdes |

## Unidad 21 — Fastify, auth y rutas PostgreSQL (2026-08-26)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Contratos 6/6 e integración 18/18 | — | — | — | — | `tests/contracts`, `tests/integration` | `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts && bun run test:integration` | 0 | 6 contratos y 18 integración pass |
| — | API PostgreSQL/cookie/CSRF/rutas ausente | — | — | — | `http-auth-admin-me.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/http-auth-admin-me.integration.test.ts` | 1 | 0 pass, 3 fail; login sin Origin devolvió 401 y no emitió cookie |
| — | — | Sesiones, admin y me funcionales | — | — | `http-auth-admin-me.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/http-auth-admin-me.integration.test.ts` | 0 | 3 pass, 31 assertions |
| — | — | — | Sesión nueva revocada por suspensión; tenant B no recibe datos de A | — | `http-auth-admin-me.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/http-auth-admin-me.integration.test.ts` | 0 | 3 pass, 31 assertions |
| — | — | — | — | Bootstrap/pools, guardas, errores y proyecciones consolidados | `apps/api/src` | `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts && bun run test:integration && bun run test:tenant-isolation && bun run test && bun run lint && bun run typecheck && bun run build` | 0 | 6 contracts, 21 integration, 9 isolation, aggregate 4+55+21+6+9+7; lint/typecheck/build verdes |

## Unidad 22 — Baileys real y gestor PostgreSQL (2026-08-26)

No se conserva un RED histórico reproducible de los intentos parciales anteriores: la dependencia Baileys 6.7.21, el contrato, el auth store y las dos primeras integraciones ya estaban presentes al iniciar esta continuación. La tabla registra únicamente resultados observados; el caso nuevo de limpieza produjo el RED fresco requerido.

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 55 unit y 23 integración previas | — | — | — | — | `tests/unit`, `tests/integration` | `PATH="$HOME/.bun/bin:$PATH" bun run test:unit && PATH="$HOME/.bun/bin:$PATH" bun run test:integration` | 0 | 55 unit y 23 integration pass antes del nuevo caso de limpieza |
| — | El heartbeat configurable y la limpieza de ownership faltaban | — | — | — | `tests/integration/baileys-manager-persistence.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/baileys-manager-persistence.integration.test.ts` | 1 | 2 pass, 1 fail; versión esperada mayor que 8, recibida 8 |
| — | — | Gateway real, heartbeat y stop | — | — | `tests/integration/baileys-manager-persistence.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/baileys-manager-persistence.integration.test.ts` | 0 | 3 pass, 16 assertions; `manager.stop()` cierra socket, intervalo, owner y advisory lock |
| — | — | — | Contrato doble/fake y ownership competido | — | `baileys-gateway.contract.test.ts`, `baileys-manager-persistence.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/baileys-gateway.contract.test.ts tests/integration/baileys-manager-persistence.integration.test.ts` | 0 | 6 pass, 33 assertions; QR expiry, segundo vínculo, restart, secretos, fake socket y manager competidor |
| — | — | — | — | El agregado detectó bootstrap incompatible con Playwright | `apps/whatsapp-manager/src/index.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test` | 1 | unit/integration/contracts/isolation verdes; E2E falló por `import.meta` fuera de módulo |
| — | — | — | — | Bootstrap por guard explícito y cleanup serializado | `apps/whatsapp-manager/src`, `packages/db/src/repositories.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test` | 0 | 4 scaffolding, 55 unit, 24 integration, 9 contracts, 9 isolation y 7 E2E pass |
| — | — | — | — | Gates finales | `tsconfig.json` | `PATH="$HOME/.bun/bin:$PATH" bun run lint && PATH="$HOME/.bun/bin:$PATH" bun run typecheck` | 0 | ambos `tsc --noEmit` sin errores |

## Unidad 23 — Workers PostgreSQL de mensaje (2026-08-27)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 24 integración, 9 contratos y 9 aislamiento pass | — | — | — | — | suites existentes | `PATH="$HOME/.bun/bin:$PATH" bun run test:integration && bun run test:contracts && bun run test:tenant-isolation` | 0 | PostgreSQL, contratos y aislamiento verdes antes de la unidad |
| — | Composición productiva ausente | — | — | — | `message-processing-worker.integration.test.ts`, `worker-provider.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts tests/contracts/worker-provider.contract.test.ts` | 1 | 0 pass, 2 fail; exports PostgreSQL/bootstraps ausentes |
| — | — | Flujo PostgreSQL/pg-boss/DeepSeek/salida | — | — | mismas pruebas | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts tests/contracts/worker-provider.contract.test.ts` | 0 | 6 pass, 25 assertions |
| — | — | — | Dos tenants, filtros, suspensión/inactivo, 24/7, resumen ausente, timeout y crash ambiguo | — | mismas pruebas | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts tests/contracts/worker-provider.contract.test.ts` | 0 | 6 pass, 29 assertions; máximo una salida |
| — | — | — | — | Bootstrap, locks/claims y fetch double separados | `packages/test-support/src/worker-fixtures.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts tests/contracts/worker-provider.contract.test.ts` | 0 | 6 pass, 29 assertions después del refactor |
| — | — | — | — | Gates finales | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test:unit && bun run test:integration && bun run test:contracts && bun run test:tenant-isolation && bun run test && bun run db:check && bun run lint && bun run typecheck` | 0 | 55 unit, 27 integration, 12 contracts, 9 isolation, agregado con 7 E2E, 16 migraciones, lint y tipos verdes |

## Unidad 24 — Paneles Next.js vivos (2026-08-27)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Next aislado verde | — | — | — | — | `apps/web` | `PATH="$HOME/.bun/bin:$PATH" bun run --cwd apps/web build` | 0 | Next generó 7 páginas |
| 12 contratos previos verdes | — | — | — | — | contratos 21–23 | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/http-events.contract.test.ts tests/contracts/baileys-gateway.contract.test.ts tests/contracts/worker-provider.contract.test.ts` | 0 | 12 pass, 33 assertions |
| — | El root build encontró la unidad parcial sin tipar | — | — | — | `api-client.ts`, `web-api-client.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run build` | 2 | `RequestInit` rechazó `cache: undefined`, el transport exigía `fetch.preconnect` y el adaptador de headers no compiló |
| — | — | Cliente y contrato Fastify reales | — | — | `tests/contracts/web-api-client.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/web-api-client.contract.test.ts` | 0 | 3 pass, 20 assertions; cookie, CSRF, admin/me y QR no-store |
| — | — | — | Mutaciones, suspensión, revisión y rol | — | `tests/contracts/web-api-client.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/web-api-client.contract.test.ts` | 0 | 3 pass, 23 assertions; reemplazo de contraseña, headers CSRF, validación, conflicto y cero tenant/conversaciones |
| — | — | — | — | Transporte y mensajes seguros centralizados | `apps/web/src/api-client.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/web-api-client.contract.test.ts` | 0 | 3 pass, 23 assertions después del refactor |
| — | — | — | — | Gates finales | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts && bun run test && bun run lint && bun run typecheck && bun run build` | 0 | 15 contratos; agregado 4+55+27+15+9+7; lint, tipos y build verdes |

## Unidad 25 — E2E feliz de sistema (2026-08-27)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Siete harnesses históricos verdes | — | — | — | — | `tests/e2e/{acceptance,admin,assistant,profile,whatsapp}.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e` | 0 | 7 pass; evidencia histórica basada en `page.setContent`, aún no sistémica |
| — | Fixture de sistema ausente | — | — | — | `tests/e2e/system-happy-path.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-happy-path.spec.ts` | 1 | módulo `support/fixtures.ts` ausente; no se encontraron tests ejecutables |
| — | — | Navegador y servicios reales | — | — | `system-happy-path.spec.ts`, `support/*` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system` | 0 | 1 pass; admin, dos tenants, perfil, asistente, vínculo, IA y ACK |
| — | — | — | Dos tenants/chats y grupo ignorado | — | `system-happy-path.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system` | 0 | 1 pass; dos salidas aisladas, horarios no bloquean y grupo no genera IA |
| — | — | — | — | Lifecycle y dobles centralizados | `tests/e2e/support/{system,providers,fixtures}.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e` | 0 | 1 system E2E pass después de refactor, puertos dinámicos y cleanup |
| — | — | — | — | Gates finales | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test && bun run test:tenant-isolation && bun run db:check && bun run lint && bun run typecheck && bun run build` | 0 | agregado 4+55+27+15+9+7 harness+1 sistema; aislamiento 9; 16 migraciones; lint/tipos/build verdes |

## Unidad 26 — E2E de fallos, aislamiento y recuperación (2026-08-27)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 1 E2E de sistema, 9 aislamiento y restore drill verdes | — | — | — | — | sistema/aislamiento/backup | `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e && bun run test:tenant-isolation && bun run backup:drill` | 0 | 1 system pass; 9 isolation pass; restore de dos tenants, RLS, jobs y auth cifrada pass |
| — | Harness sin superficie de fallos | — | — | — | `tests/e2e/system-failure-isolation.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system` | 1 | 1 fail: `apiUrl`/controles de fallo y recuperación ausentes (`undefined/auth/login`) |
| — | — | Contención y recuperación ejecutables | — | — | spec y `support/{system,providers}.ts` | mismo comando enfocado | 0 | 1 pass; auth/IDOR, lifecycle, filtros, IA, salida y reinicios sobre cuatro procesos/PostgreSQL |
| — | — | — | Silencio y eventos del tenant correcto | — | misma spec | mismo comando enfocado | 0 | 1 pass; timeout/error sin outbound, dos tenants no vacíos y rechazo/crash divergentes |
| — | — | — | — | Fixtures por test, provider doubles y exposición segura extraídos | `tests/e2e/support`, `playwright.config.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e` | 0 | 2 system pass seriales, sin estado compartido ni lock Next concurrente |
| — | — | — | — | Gates finales | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test:tenant-isolation && bun run test && bun run backup:drill && bun run security:scan && bun run lint && bun run typecheck && bun run build` | 0 | aislamiento 9; agregado 4+55+27+15+9+7+2; backup, scan 87 archivos, lint, tipos y Next 7 páginas verdes |

## Unidad 27 — Trazabilidad y aceptación integrada (2026-08-27)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Agregado, E2E, DB y build previos | — | — | — | — | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test && bun run test:e2e && bun run db:check && bun run build` | 0 | 4 scaffolding, 55 unit, 27 integration, 15 contracts, 9 isolation, 7 harness y 2 system; E2E 2; 16 migraciones; Next 7 páginas |
| — | Fuente tipada ausente | — | — | — | `tests/acceptance/remediation-traceability.acceptance.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/acceptance/remediation-traceability.acceptance.test.ts` | 1 | 0 pass, 1 fail y 1 error; módulo `v1-traceability.ts` inexistente |
| — | — | 82 IDs exactos | — | — | misma prueba | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` | 0 | 4 pass, 8 assertions; 22 requisitos, 41 escenarios y 19 criterios mapeados |
| — | — | — | Mapping retirado y harness histórico rechazados | — | misma prueba | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` | 0 | el mapping incompleto falla cerrado y `acceptance.spec.ts` no puede fingir E2E de sistema |
| — | — | — | — | IDs, catálogo y lectura deduplicados | `packages/test-support/src/v1-traceability.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` | 0 | 4 pass, 8 assertions después de extraer helpers tipados |
| — | — | — | — | Cierre bloqueante | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test && bun run test:e2e && bun run db:check && bun run backup:drill && bun run security:scan && bun run scope:check && bun run lint && bun run typecheck && bun run build` | 0 | agregado 4+55+27+15+9+4 acceptance+7 harness+2 system; E2E 2; 16 migraciones; restore, scan 88, scope 11, lint, tipos y Next 7 páginas verdes |

## Unidad 28 — Ingress Baileys y destinatario exacto (2026-08-28)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| Contratos, integración y E2E solicitados | — | — | — | — | suites focalizadas | `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts`; `bun run test:integration`; `bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system` | 1 | Docker no pudo crear interfaces `veth`; fallo de infraestructura previo a ejecutar PostgreSQL/E2E, no fallo de assertions. |
| — | Listener y destinatario ausentes | — | — | — | `tests/contracts/baileys-gateway.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/baileys-gateway.contract.test.ts --test-name-pattern "routes socket | exact validated"` | 1 | 0 pass, 2 fail: `messages.upsert` produjo `[]` y `sendMessage("")` devolvió `rejected`. |
| — | — | Socket/JID funcionales | — | — | contrato Baileys y unit delivery | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/baileys-gateway.contract.test.ts tests/unit/outbound-delivery.unit.test.ts` | 0 | 11 pass, 40 assertions; socket normalizado y ACK solo al JID exacto. |
| — | — | — | Grupo, propio, media, sesión desconocida y dos JID | — | contratos, integración y system fixtures | mismo contrato enfocado; suites PostgreSQL/E2E preparadas | 0/infra | Contrato 6/6 cubre grupo/propio/media/JID inválido; integración y E2E emiten socket, pero Docker bloqueó su ejecución. |
| — | — | — | — | Normalización y claim centralizados | producción y fixtures | `PATH="$HOME/.bun/bin:$PATH" bun run lint && PATH="$HOME/.bun/bin:$PATH" bun run typecheck` | 0 | ambos checks TypeScript verdes; no quedan llamadas directas E2E al inbound handler ni `sendMessage("")`. |
| — | — | — | — | Gates dependientes de Docker | integración/E2E/DB/agregado | focused integration; system E2E; `bun run db:check`; `bun run test:tenant-isolation`; `bun run test` | 1 | Todos fueron intentados y bloqueados por `failed to add the host veth <=> sandbox: operation not supported`; el agregado alcanzó 55/55 unit antes del bloqueo. |
| Post-reboot | — | — | — | Infraestructura recuperada | `baileys-manager-persistence.integration.test.ts` | `timeout 180s env PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/baileys-manager-persistence.integration.test.ts` | 0 | Smoke observado tras reinicio: kernel `7.1.9-arch1-2`, veth funcional y 3 pass, 0 fail, 17 assertions; no sustituye el fallo de infraestructura anterior. |
| — | — | Socket/JID revalidados | — | — | contrato Baileys y outbound | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/baileys-gateway.contract.test.ts tests/unit/outbound-delivery.unit.test.ts` | 0 | 11 pass, 0 fail, 40 assertions. |
| — | — | Persistencia manager verde | — | — | `baileys-manager-persistence.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/baileys-manager-persistence.integration.test.ts` | 0 | 3 pass, 0 fail, 17 assertions. |
| — | — | Worker/JID PostgreSQL verde | — | — | `message-processing-worker.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts` | 0 | 3 pass, 0 fail, 21 assertions; `remote_jid` exacto confirmado. |
| — | — | E2E por socket verde | Dos tenants/JID exactos | — | `system-happy-path.spec.ts` | `PATH="$HOME/.bun/bin:$PATH" bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system` | 0 | 1 pass; `messages.upsert` del fake socket produjo dos ACK cuyos JID igualan exactamente los destinatarios aceptados. |
| — | — | — | — | Cierre bloqueante post-reboot | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run db:check && bun run test:tenant-isolation && bun run test && bun run lint && bun run typecheck` | 0 | 17 migraciones; aislamiento 9/9; agregado 4+55+27+18+9+4+7+2 system; lint y tipos verdes. |

## Unidad 29 — QR efímero autorizado y visible (2026-08-28)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 27 integración, 18 contratos y 2 E2E system | — | — | — | — | suites focalizadas | `PATH="$HOME/.bun/bin:$PATH" bun run test:integration && bun run test:contracts && bunx playwright test tests/e2e/system-happy-path.spec.ts tests/e2e/system-failure-isolation.spec.ts --project=system` | 0 | PostgreSQL/Testcontainers y ambos sistemas verdes antes del cambio. |
| — | QR persistido sobrevivía logout tras restart | — | — | — | `tests/integration/baileys-manager-persistence.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/baileys-manager-persistence.integration.test.ts --test-name-pattern "restarted socket logs out"` | 1 | 0 pass, 1 fail: quedaba 1 código tras logout. |
| — | — | Token vigente recuperado e invalidado condicionalmente | — | — | misma integración | mismo comando focalizado | 0 | 1 pass, 3 filtered, 2 assertions. |
| — | — | — | Owner obtiene QR; otro tenant/admin no; expirado/opened no disponible | — | `tests/contracts/web-api-client.contract.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/web-api-client.contract.test.ts --test-name-pattern "live admin, profile"` | 0 | 1 pass, 24 assertions; POST→evento QR→GET real, reemplazo, no-store y render E2E. |
| — | — | — | Restart/logout y reemplazo no borran QR más nuevo | Cleanup determinista y referencia de aceptación restaurada | manager/contratos/system E2E | `PATH="$HOME/.bun/bin:$PATH" bun run test` | 0 | 4 scaffolding + 55 unit + 28 integration + 18 contracts + 9 isolation + 4 acceptance + 7 harness + 2 system. |
| — | — | — | — | Gates finales | raíz | `PATH="$HOME/.bun/bin:$PATH" bun run db:check && bun run security:scan && bun run lint && bun run typecheck && bun run build` | 0 | 18 migraciones, scan 88 archivos, TypeScript verde y Next generó 7 páginas. |

## Unidad 30 — Outbox `ai.generate` durable (2026-08-28)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 28 integración y failure E2E verdes | — | — | — | — | integración/sistema | `PATH="$HOME/.bun/bin:$PATH" bun run test:integration`; `bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system` | 0 | 28 pass y 1 system pass antes del cambio. |
| — | Dispatcher ausente y envío directo | — | — | — | `message-processing-worker.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts` | 1 | 0 pass, export `AiOutboxDispatcher` ausente. |
| — | — | Persistencia y recovery | — | — | misma integración | mismo comando enfocado | 0 | 4 pass; broker caído deja outbox y restart publica/marca tras ACK. |
| — | — | — | Crash pre/post publish, replay, concurrencia y dos tenants | — | misma integración | mismo comando enfocado | 0 | 5 pass, 40 assertions; dos jobs estables y consumidor idempotente. |
| — | — | — | — | Política/fixture y claims separados | producción/fixtures | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts && bun run lint && bun run typecheck` | 0 | 5 pass; tipos verdes tras refactor. |
| — | — | — | — | Gates solicitados | raíz | `bun run test; bun run test:tenant-isolation; bun run db:check; bun run backup:drill` | 0 | agregado 4+55+30+18+9+4+7+2; DB 19 migraciones; backup verde. |

## Unidad 31 — Resúmenes conversacionales productivos (2026-08-28)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 19 contratos, 32 integración y failure E2E verdes | — | — | — | — | suites focalizadas | `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts && bun run test:integration && bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system` | 0 | Baseline PostgreSQL, proveedor y sistema verde antes del cambio de esta ejecución. |
| — | La última fila estructuralmente inválida ocultaba el resumen válido anterior | — | — | — | `tests/integration/message-processing-worker.integration.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/message-processing-worker.integration.test.ts --test-name-pattern "contains summary timeout"` | 1 | 0 pass, 1 fail: el contexto recibió `null` en lugar de `estado previo`. |
| — | — | Carga de la última versión válida | — | — | misma integración | mismo comando focalizado | 0 | 1 pass, 6 filtered; fallo de summary no altera la versión previa y la respuesta actual continúa. |
| — | — | — | Umbral, incremento, replay stale, retry, dos tenants y raw retenido | — | integración y contrato de proveedor | `PATH="$HOME/.bun/bin:$PATH" bun test tests/contracts/worker-provider.contract.test.ts tests/integration/message-processing-worker.integration.test.ts` | 0 | 11 pass, 70 assertions; retry añade versión 3/watermark 1 y replay queda stale. |
| — | — | — | Restart/no-summary en suites existentes y failure E2E | Selección válida y versión física separadas | PostgreSQL/system | comando anterior; `bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system` | 0 | E2E 1/1; historial crudo, fallback y aislamiento permanecen verdes con dobles deterministas. |
| — | — | — | — | Cierre post-reset y gates solicitados | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test:tenant-isolation && bun run test && bun run db:check && bun run backup:drill && bun run lint && bun run typecheck` | 0 | 9 aislamiento; agregado 4+55+32+19+9+4+7+2; DB 20 migraciones; restore, lint y tipos verdes. |

## Unidad 32 — Auditoría crítica y actividad administrativa (2026-08-28)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| HTTP 3, manager 5, worker 7, web 3 y failure E2E 1 verdes | — | — | — | — | suites focalizadas heredadas | comandos focalizados de la tarea 32 | 0 | La implementación parcial era verde, pero el verificador detectó controles negativos y procedencia de actividad ausentes. |
| — | Caller/source/tenant, rechazo connect, login denied y timestamp humano fallan | — | — | — | HTTP, manager y web contract | `bun test tests/integration/http-auth-admin-me.integration.test.ts`; `bun test tests/integration/baileys-manager-persistence.integration.test.ts`; `bun test tests/contracts/web-api-client.contract.test.ts` | 1 | HTTP 2/3, manager 4/7 y web 0/3; se observaron outcome `failure`, auditoría impersonable, error provider rethrow y formatter ausente. |
| — | — | Auditoría y rechazo contenidos | — | — | mismas suites + failure E2E | comandos focalizados de unidad 32 | 0 | HTTP 3/3, manager 7/7, worker 7/7, web 3/3 y failure E2E 1/1. |
| — | — | — | Dos tenants, platform target, source impersonation, worker sin grant y secreto provider | — | manager/HTTP/system | mismos comandos focalizados | 0 | Cero eventos cruzados; login tenant denegado, logout/revocación auditados; actividad coincide con `connection_failed`; raw error ausente. |
| — | — | — | — | Política DB y formatter centralizados; gates completos | migración, lifecycle y web | `bun run test:tenant-isolation && bun run test && bun run db:check && bun run security:scan && bun run scope:check && bun run lint && bun run typecheck && bun run build` | 0 | 9 aislamiento; agregado 4+55+35+19+9+4+7+2; DB 21 migraciones; scans, tipos y build verdes. |

## Unidad 33 — E2E semántico y aceptación anti-bypass (2026-08-28)

| SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR | file | literal command | exit code | result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 4 aceptación y 2 system E2E verdes | — | — | — | — | aceptación y ambos sistemas | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance`; `bunx playwright test tests/e2e/system-happy-path.spec.ts tests/e2e/system-failure-isolation.spec.ts --project=system` | 0 | Baseline verde antes de assertions semánticas. |
| — | Catálogo semántico ausente | — | — | — | `remediation-traceability.acceptance.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` | 1 | 0 pass; exports `semanticAssertions`/`criticalSemanticMappings` ausentes. |
| — | Assertion detecta scope incorrecto | — | — | — | `system-failure-isolation.spec.ts` | comando Playwright focalizado | 1 | 1 system fail: audit tenant scope estaba definido demasiado ampliamente; eventos críticos de envío se acotaron al tenant esperado. |
| — | — | Catálogo y hechos de frontera ejecutables | Cada mapping/assertion removido, relabelado, unrelated u obsoleto falla cerrado | Helpers tipados y metadata deduplicada | aceptación + ambos system specs | comandos focalizados de unidad 33 | 0 | Assertions nombradas cubren socket, JID, QR, outbox, summary y audit/activity; resultados finales se registran en apply-progress. |
| — | — | — | — | Gates finales | suites raíz | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance && bunx playwright test tests/e2e/system-happy-path.spec.ts tests/e2e/system-failure-isolation.spec.ts --project=system && bun run test && bun run db:check && bun run backup:drill && bun run security:scan && bun run scope:check && bun run lint && bun run typecheck && bun run build` | 0 | 4 aceptación, 2 system E2E, agregado 4+55+35+19+9+4+7+2, DB 21 migraciones, restore, scan 89, scope 11, lint, tipos y build de 7 páginas verdes. |

## Unidad 34 — Disposición de procedencia strict-TDD (2026-08-28)

- **Decisión humana explícita:** `re-baseline explícito`, elegida por el responsable del cambio ante las opciones re-baseline, waiver histórico o mantener FAIL.
- **Hecho no alterado:** no existen registros confiables de SAFETY NET/RED para las unidades 1–18 ni para el alcance ya implementado antes de la evidencia prospectiva; no se crean timestamps, salidas fallidas ni ciclos retrospectivos.
- **Nueva línea base:** la evidencia ejecutable de las unidades 28–33, incluidos sus RED observados, triangulaciones, gates y cierre semántico, constituye la baseline verificable desde 2026-08-28.
- **Alcance de la excepción:** autoriza evaluar C7 como re-baseline documentado; no afirma que el trabajo histórico haya seguido strict TDD y no convierte suites verdes actuales en procedencia pasada.
- **Regla futura:** toda modificación posterior a esta disposición debe registrar SAFETY NET, RED conductual, GREEN, TRIANGULATE y REFACTOR de forma prospectiva, o volver a bloquear verify/archive.
- **Gate de gobernanza:** ningún test prueba esta decisión. Un verify independiente fresco debe citarla expresamente y decidir PASS/FAIL; recién un PASS puede habilitar archive.

## Segunda re-baseline explícita y remediación prospectiva (2026-08-30)

- **Autorización humana explícita:** el usuario seleccionó remediar los tres bloqueadores, establecer esta frontera prospectiva honesta y repetir después una verificación independiente.
- **Baseline de seguridad:** los arreglos de runtime anteriores a esta frontera se aceptan únicamente como baseline contemporánea de safety net; no se fabrica para ellos historia de SAFETY NET ni RED.
- **Evidencia prospectiva:** los dos fallos ejecutables observados por el verifier y el nuevo helper de reconexión tienen RED/GREEN verificables en esta remediación.
- **Regla futura:** todo cambio posterior a esta frontera requiere prospectivamente SAFETY NET, RED, GREEN, TRIANGULATE y REFACTOR completos.

| Tarea | SAFETY NET | RED | GREEN | TRIANGULATE | REFACTOR |
| --- | --- | --- | --- | --- | --- |
| Identidad durable de revínculo | El gate ya estaba rojo; no se reclasifica como safety net. | `PATH="$HOME/.bun/bin:$PATH" bun run test:integration` del verifier: exit 1, 34/35; `http-auth-admin-me.integration.test.ts:378` esperaba `link:<business_id>`. | `PATH="$HOME/.bun/bin:$PATH" bun test tests/integration/http-auth-admin-me.integration.test.ts`: exit 0, 3/3 y 51 assertions. | Dos POST explícitos producen dos eventos durables distintos y cada `stable_key` cumple `whatsapp.link_requested:<uuid-v4>`; CSRF/Origin, tenant y estado siguen ejercitados. | Expectativas centradas en contrato durable observable; suite enfocada 3/3 verde. |
| Marcador semántico durable | El gate ya estaba rojo; no se reclasifica como safety net. | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` del verifier: exit 1, 3/4; faltaba el literal contiguo `assertSemanticBoundary("durable-outbox-recovery"`. | `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance`: exit 0, 4/4 y 22 assertions. | El validador anti-bypass conserva sus mutaciones cerradas y la assertion sigue ejecutando `system.outboxEvidence("worker-recovery")`. | Solo se restauró el marcador en una línea, sin cambiar semántica ejecutable. |
| Throttle serializado de reconexión | `PATH="$HOME/.bun/bin:$PATH" bun run test:unit` del verifier: exit 0, 57/57 antes del nuevo caso. | `PATH="$HOME/.bun/bin:$PATH" bun test tests/unit/whatsapp-manager-reconnect.unit.test.ts`: exit 1, 0 pass; exports `MIN_RECONNECT_INTERVAL_MS` y `createReconnectThrottle` ausentes. | Mismo comando: exit 0, 1/1 y 4 assertions tras extraer el helper mínimo. | Mismo comando con segundo caso: exit 0, 2/2 y 13 assertions; intervalo ≥15 s, llamada no solapada y `nextAt` actualizado solo después de completar. | Estado temporal y constante centralizados; el timer productivo conserva `restart()` y 2/2 siguen verdes. |

El primer agregado llegó verde hasta 4 scaffolding, 59 unit, 35 integration, 33 contracts, 9 isolation, 4 acceptance y 7 harness, pero sus dos system E2E no arrancaron por el lock del runtime protegido. En la ventana segura posterior, el command runner independiente ejecutó `PATH="$HOME/.bun/bin:$PATH" bun run test` con exit 0: 153 passed, 0 failed (4 scaffolding, 59 unit, 35 integration, 33 contracts, 9 isolation, 4 acceptance, 7 Playwright históricos y 2 Playwright de sistema). También confirmó `bun run db:check` con exit 0 sobre 21 migraciones y el fingerprint esperado, `git diff --check` con exit 0, restauración del stack persistente, UI HTTP 200 y sesión API no autenticada HTTP 401. Este cierre no reclasifica el bloqueo anterior ni las suites verdes como procedencia TDD histórica.

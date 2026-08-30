# Plan de implementación: AgendIA v1

Este plan entrega el alcance completo mediante 18 unidades autónomas y secuenciales. El usuario aceptó explícitamente `size:exception`, por lo que `apply` podrá ejecutarlas dentro de una única entrega excepcional, manteniendo verdes las verificaciones de cada unidad.

## Review Workload Forecast

| Field | Value |
| ------- | ------- |
| Estimated changed lines | 5.550–7.020 en total; 220–400 por unidad/slice |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Slice 1 (unidad 1) → Slice 2 (unidad 2) → Slice 3 (unidad 3) → Slice 4 (unidad 4) → Slice 5 (unidad 5) → Slice 6 (unidad 6) → Slice 7 (unidad 7) → Slice 8 (unidad 8) → Slice 9 (unidad 9) → Slice 10 (unidad 10) → Slice 11 (unidad 11) → Slice 12 (unidad 12) → Slice 13 (unidad 13) → Slice 14 (unidad 14) → Slice 15 (unidad 15) → Slice 16 (unidad 16) → Slice 17 (unidad 17) → Slice 18 (unidad 18) |
| Delivery strategy | exception-ok |
| Chain strategy | no aplicable mientras rija `size:exception` |

Decision needed before apply: No
Chained PRs recommended: Yes
Size exception accepted: Yes
400-line budget risk: High

### Secuencia interna de implementación

Aunque la entrega tendrá una excepción de tamaño, cada unidad interna conserva su prueba, verificación y límite de reversión. Las unidades no se implementan en paralelo y cada una debe quedar verde antes de comenzar la siguiente.

| Slice | Unidad | Estimación | Inicio y final verificable | Límite de reversión |
| --- | --- | ---: | --- | --- |
| 1 | 1. Monorepo reproducible y arnés de pruebas | 260–340 | Repositorio documental → workspaces y arnés verdes. | Solo scaffolding y lockfile de la unidad. |
| 2 | 2. Roles PostgreSQL, migración base y aislamiento RLS | 360–400 | Arnés verde → RLS y migración limpia verificados. | Migración correctiva aditiva. |
| 3 | 3. Contratos, errores seguros y transacción auditada/outbox | 320–390 | RLS verde → transacción atómica y contratos verificados. | Puertos, contratos y migración aditiva de la unidad. |
| 4 | 4. Autenticación opaca, CSRF y bootstrap operativo | 350–400 | Contratos verdes → login, sesión y CSRF verificados. | Código de auth y bootstrap, sin borrar identidades/sesiones. |
| 5 | 5. Administración de negocios y usuario único | 330–400 | Auth verde → administración y unicidad verificadas. | Rutas/proyección y migración correctiva que preserve tenants. |
| 6 | 6. Panel administrativo accesible | 260–350 | API admin verde → flujo E2E administrativo verificado. | Rutas/componentes admin de la unidad. |
| 7 | 7. Perfil comercial aislado | 270–350 | Panel admin verde → perfil aislado E2E verificado. | Ruta/UI; columnas preservadas aditivamente. |
| 8 | 8. Configuración y control del asistente | 260–340 | Perfil verde → activación persistente E2E verificada. | Rutas/UI y migración aditiva sin otros tenants. |
| 9 | 9. Conexión única y máquina de estados de WhatsApp | 300–390 | Asistente verde → conexión 1:1 y estados persistentes verificados. | Migración correctiva y rutas; conexión preservada. |
| 10 | 10. Custodia cifrada y propiedad exclusiva de sesión Baileys | 350–400 | Estados verdes → cifrado y propietario único verificados. | Detener gestor; conservar ciphertext/DEK. |
| 11 | 11. Vínculo Baileys y ciclo de vida persistente | 340–400 | Custodia verde → vínculo y reinicio persistente verificados. | Detener comandos; conservar metadatos/material protegido. |
| 12 | 12. Panel del negocio para estado y vínculo | 220–300 | Gestor verde → QR temporal y estado propio E2E verificados. | Rutas UI, sin afectar gestor/sesión. |
| 13 | 13. Ingesta idempotente, filtros y cola durable | 350–400 | Vínculo verde → ingesta única y filtrada verificada. | Detener dispatcher/worker; conservar inbox/mensajes. |
| 14 | 14. Historial completo y representación contextual segura | 330–400 | Ingesta verde → contexto aislado y recuperable verificado. | Detener generación contextual; conservar historial/versiones. |
| 15 | 15. Adaptador DeepSeek y procesamiento asíncrono | 330–400 | Contexto verde → IA sustituible y silencio ante fallo verificados. | Pausar cola IA; conservar mensajes/outbox. |
| 16 | 16. Outbox saliente, ACK y estados de entrega conservadores | 300–380 | IA verde → ACK y no duplicación verificados. | Pausar dispatcher; conservar filas trazables. |
| 17 | 17. Observabilidad, auditoría verificable y seguridad transversal | 320–400 | Salida verde → trazabilidad segura y kill switch verificados. | Desactivar exportadores/alertas, sin borrar auditoría. |
| 18 | 18. CI, backup/restore y aceptación integral | 300–380 | Observabilidad verde → CI, restore y aceptación integral verificados. | Workflow/runbooks/scripts, sin borrar backups/datos. |

## Convenciones de ejecución

- Cada unidad mantiene juntos migración, código, pruebas y documentación del comportamiento; comienza desde la unidad anterior verde y termina con un diff reversible independiente.
- La evidencia TDD obligatoria de cada unidad se registra en el PR: **RED** (prueba nueva que falla), **GREEN** (mínimo comportamiento que pasa), **TRIANGULATE** (caso límite/segundo tenant/fallo que evita una implementación accidental) y **REFACTOR** (simplificación sin cambio observable). Ejecutar `bun run lint`, `bun run typecheck`, la suite indicada, `bun run db:check` cuando toque PostgreSQL y `bun run build` antes de cerrarla.
- No crear rutas, tablas ni UI para recuperación de contraseña, registro/invitaciones, más de un usuario o conexión WhatsApp por negocio, canales adicionales, grupos, mensajes propios, multimedia, ni visor/búsqueda/gestión de conversaciones.

## Unidades de implementación

### 1. Monorepo reproducible y arnés de pruebas — 260–340 líneas

**Trazabilidad:** Diseño §§1, 11 y 13; `persistence-and-operations`/Persistencia principal; escenario Recuperación de estado persistido.

- [x] RED: crear pruebas de resolución de workspaces y scripts bloqueantes que fallen; GREEN: inicializar `package.json`, `bunfig.toml`, `tsconfig.base.json`, `apps/{web,api,whatsapp-manager,message-worker}/`, `packages/{domain,contracts,db,auth,observability,test-support}/`, configuración Vitest/Playwright, `.env.example`, Docker de desarrollo y scripts raíz; TRIANGULATE: probar instalación limpia y workspaces internos; REFACTOR: unificar configuración TypeScript y documentar en `README.md`/`docs/development.md`. Verificar con `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`; runtime: `bun run test` debe descubrir las suites vacías configuradas; rollback: eliminar únicamente el scaffolding y lockfile de esta unidad. <!-- sdd-owner: implementation -->

### 2. Roles PostgreSQL, migración base y aislamiento RLS — 360–400 líneas

**Trazabilidad:** Diseño §§3, 5, 8 y 11; `administration-and-isolation`/Autorización y aislamiento estricto, escenarios Intento de cruzar tenants y Datos de identidad inválidos; `persistence-and-operations`/Persistencia principal.

- [x] RED: añadir `packages/db/test/tenant-rls.integration.test.ts` que demuestre denegación sin contexto, con tenant falsificado y entre dos tenants; GREEN: crear `packages/db/migrations/0000_base.sql`, esquema Drizzle, roles DDL/runtime, grants mínimos, `ENABLE/FORCE RLS`, `business_id`, FKs compuestas, índices y helper transaccional `TenantContext` con `set_config(..., true)`; TRIANGULATE: verificar pool limpio, rol admin limitado y que no hay filas/efectos cruzados; REFACTOR: centralizar políticas SQL y fixtures Testcontainers. Verificar con `bun run test:integration`, `bun run test:tenant-isolation`, `bun run db:generate`, revisión del SQL generado, `bun run db:migrate`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: levantar PostgreSQL efímero desde las suites y aplicar migración desde cero; rollback: migración correctiva de expansión, nunca `down` destructivo. <!-- sdd-owner: implementation -->

### 3. Contratos, errores seguros y transacción auditada/outbox — 320–390 líneas

**Trazabilidad:** Diseño §§2, 5, 8–10; `persistence-and-operations`/Validación y tratamiento seguro de errores, escenario Solicitud inválida no produce efectos; Auditoría de eventos críticos.

- [x] RED: escribir pruebas de contratos Zod y de atomicidad para error uniforme, auditoría y outbox; GREEN: implementar `packages/contracts/src/{http,events}.ts`, OpenAPI desde esquemas, `packages/domain/src` para puertos/casos de uso y `packages/db` para `audit_event`, `technical_event`, `outbox_event`, `inbox_event` append-only y Unit of Work; TRIANGULATE: forzar fallo después de la mutación y confirmar rollback total, redacción de secretos y rechazo de UPDATE/DELETE de auditoría; REFACTOR: extraer catálogo de códigos y constructor de eventos. Verificar con `bun run test:unit`, `bun run test:contracts`, `bun run test:integration`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: una transacción Testcontainers persiste estado+auditoría+outbox o ninguno; rollback: retirar los puertos/contratos y migración aditiva de estas tablas. <!-- sdd-owner: implementation -->

### 4. Autenticación opaca, CSRF y bootstrap operativo — 350–400 líneas

**Trazabilidad:** Diseño §4, §§8–10; `administration-and-isolation`/Autenticación y administración, Usuario único y ámbito, Autorización estricta; escenarios Administración sin autorización y Datos de identidad inválidos.

- [x] RED: crear pruebas de Argon2id, login/logout, cookie `__Host-agendia_session`, expiración/revocación, CSRF/Origin y bootstrap único; GREEN: implementar `packages/auth`, migraciones `auth_identity`/`web_session`, middleware Fastify y `apps/api/src/routes/auth.ts`, más comando `scripts/bootstrap-admin.ts` auditado; TRIANGULATE: cubrir sesión expirada, contraseña cambiada, cuenta desactivada, CORS hostil y ausencia de endpoints de registro/recuperación; REFACTOR: concentrar guardas y políticas de cookie. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: `bun run test:integration` autentica contra API y PostgreSQL reales; rollback: deshabilitar el bootstrap y revertir código de auth sin borrar identidades/sesiones. <!-- sdd-owner: implementation -->

### 5. Administración de negocios y usuario único — 330–400 líneas

**Trazabilidad:** Diseño §§3–5 y 10; `administration-and-isolation`/Autenticación y administración, Ciclo de vida del negocio y Estados de supervisión; escenarios Administración autorizada, Suspensión contiene la operación y Reactivación preserva el estado.

- [x] RED: añadir pruebas API y aislamiento para alta/edición, credencial inicial, unicidad del usuario y proyección administrativa; GREEN: implementar migraciones, repositorios/casos de uso, rutas `/admin/businesses`, `/admin/businesses/:id/user`, `/admin/businesses/:id/status` y auditoría/outbox atómico; TRIANGULATE: probar segundo usuario rechazado, ID ajeno no revelado, suspensión que revoca sesiones y reactivación que conserva asistente inactivo; REFACTOR: separar capacidad administrativa de repositorios tenant. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: Testcontainers demuestra que admin no obtiene conversaciones ni credenciales; rollback: retirar rutas/proyección y usar migración correctiva que preserve tenants. <!-- sdd-owner: implementation -->

### 6. Panel administrativo accesible — 260–350 líneas

**Trazabilidad:** Diseño §§1, 4 y 10; `administration-and-isolation`/Estados de supervisión, escenario Supervisión de estado; `persistence-and-operations`/Sin visor de conversaciones.

- [x] RED: escribir Playwright para login admin, alta/edición y tabla de estados; GREEN: construir `apps/web/app/(admin)` y componentes/formularios que consuman solo los contratos administrativos; TRIANGULATE: comprobar redirección de usuario de negocio, errores utilizables y ausencia de enlaces/rutas de conversaciones; REFACTOR: extraer componentes accesibles de estado/formulario y actualizar `docs/user-guide.md`. Verificar con `bun run test:contracts`, `bun run test:e2e`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: `bun run test:e2e` completa alta con dobles y no visualiza contenido conversacional; rollback: eliminar únicamente rutas/componentes admin de la unidad. <!-- sdd-owner: implementation -->

### 7. Perfil comercial aislado — 270–350 líneas

**Trazabilidad:** Diseño §§3, 5, 7 y 10; `configuration-and-whatsapp`/Configuración comercial, ambos escenarios; `messaging-and-ai`/Respuesta contextual mediante DeepSeek.

- [x] RED: añadir pruebas de esquema y API para todos los campos comerciales y escritura cruzada; GREEN: implementar `business_profile`, límites Zod/DB, caso de uso, `/me/business-profile` y formulario `apps/web/app/(business)/profile`; TRIANGULATE: validar datos inválidos sin cambios parciales, acceso con ID inyectado de otro tenant y horarios informativos; REFACTOR: consolidar serialización allowlisted de perfil y documentación de campos. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: E2E guarda y recarga perfil solo del tenant autenticado; rollback: retirar ruta/UI y preservar columnas con migración correctiva. <!-- sdd-owner: implementation -->

### 8. Configuración y control del asistente — 260–340 líneas

**Trazabilidad:** Diseño §§5, 7 y 10; `configuration-and-whatsapp`/Configuración y activación, ambos escenarios; `messaging-and-ai`/Operación continua, escenario fuera de horario.

- [x] RED: crear pruebas para configuración mínima válida, activación/desactivación y aislamiento; GREEN: implementar `assistant_config`, revisión optimista, caso de uso, `/me/assistant`, formulario de configuración y estado en panel; TRIANGULATE: demostrar que horarios no bloquean activación y que suspensión no reactiva un asistente previamente inactivo; REFACTOR: extraer política de elegibilidad reutilizable y documentar el control. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: E2E activa con esquema mínimo y persiste estado; rollback: desactivar rutas/UI y migrar de forma aditiva sin modificar otros tenants. <!-- sdd-owner: implementation -->

### 9. Conexión única y máquina de estados de WhatsApp — 300–390 líneas

**Trazabilidad:** Diseño §§5–6 y 10; `configuration-and-whatsapp`/Vinculación única y Estado/metadatos, todos los escenarios; `persistence-and-operations`/Actividad técnica.

- [x] RED: escribir pruebas de unicidad 1:1, transiciones y proyección de estados; GREEN: crear `packages/db/migrations/0003_whatsapp_connection.sql`, `packages/domain/src/whatsapp/connection.ts`, repositorios, estados internos/públicos, lease/heartbeat y `apps/api/src/routes/me-whatsapp.ts` para `/me/whatsapp`/`status`; TRIANGULATE: cubrir segunda conexión rechazada, desconectado/link-required/error, negocio suspendido y sesión no apta para envío; REFACTOR: centralizar tabla de transición y proyección del panel. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:tenant-isolation`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: Testcontainers simula transición y recupera estado persistido tras reinicio; rollback: migración correctiva y desactivación de rutas, preservando la conexión existente. <!-- sdd-owner: implementation -->

### 10. Custodia cifrada y propiedad exclusiva de sesión Baileys — 350–400 líneas

**Trazabilidad:** Diseño §6 y §8; `configuration-and-whatsapp`/Protección de material sensible, escenario Consulta no autorizada; Estado/metadatos, escenario Desconexión observable.

- [x] RED: añadir pruebas de AES-256-GCM con AAD, DEK envuelta, versión optimista, advisory lock y redacción; GREEN: implementar `packages/whatsapp-baileys/src/auth-store.ts`, tablas `whatsapp_auth_record`, puerto KMS, permisos exclusivos de `apps/whatsapp-manager` y recuperación de sesión; TRIANGULATE: probar nonce/AAD de otro tenant, lock competido, corrupción, rotación de KEK y que QR/credenciales nunca llegan a logs/API; REFACTOR: encapsular criptografía y acceso mínimo. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: integración PostgreSQL adquiere un único propietario y reconstruye auth cifrada; rollback: detener gestor y conservar ciphertext/DEK para recuperación, sin borrado. <!-- sdd-owner: implementation -->

### 11. Vínculo Baileys y ciclo de vida persistente — 340–400 líneas

**Trazabilidad:** Diseño §§2 y 6; `configuration-and-whatsapp`/Vinculación única y Estado/metadatos, escenarios Vinculación correcta, Desconexión observable y Sesión no disponible.

- [x] RED: crear contrato determinista Baileys para QR efímero, apertura, cierre transitorio, logout y reinicio; GREEN: implementar `apps/whatsapp-manager/src`, `WhatsAppGateway`, comandos durables de vínculo, endpoint `/me/whatsapp/link` con `Cache-Control: no-store`, backoff/jitter y actualización auditada/técnica; TRIANGULATE: cubrir QR expirado/no autorizado, logout que exige nuevo vínculo, corrupción a ERROR y recuperación de sockets tras reinicio; REFACTOR: aislar el adaptador de Baileys del dominio y documentar operación de vínculo. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: E2E completa vínculo con doble y gestor persistente; rollback: apagar consumidores de comandos y conservar metadatos/material protegido. <!-- sdd-owner: implementation -->

### 12. Panel del negocio para estado y vínculo — 220–300 líneas

**Trazabilidad:** Diseño §§1, 6 y 10; `configuration-and-whatsapp`/Vinculación única y Estado/metadatos; `administration-and-isolation`/Visibilidad limitada del usuario.

- [x] RED: escribir Playwright para panel propio, QR efímero y estados visibles; GREEN: implementar `apps/web/app/(business)/{assistant,whatsapp}` y componentes que no acepten tenant desde cliente; TRIANGULATE: comprobar sesión suspendida/redirección, segundo vínculo rechazado y que nunca se muestra material persistente; REFACTOR: reutilizar vistas de estado accesibles y actualizar guía de usuario. Verificar con `bun run test:e2e`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: E2E con doble muestra sólo QR temporal y estado del tenant propio; rollback: eliminar rutas UI sin afectar gestor ni sesión persistida. <!-- sdd-owner: implementation -->

### 13. Ingesta idempotente, filtros y cola durable — 350–400 líneas

**Trazabilidad:** Diseño §§2, 5–6 y 9; `messaging-and-ai`/Resolución de sesión y tenant, Admisibilidad, ambos escenarios; `persistence-and-operations`/Mensaje de negocio suspendido.

- [x] RED: crear integración que falle para sesión desconocida, duplicado, orden concurrente, grupo, propio y multimedia; GREEN: implementar `apps/whatsapp-manager/src/inbound-handler.ts`, la función de enrutamiento mínima `session_public_id -> business_id`, `packages/db/migrations/0005_messages.sql` para `conversation`/`message`, deduplicación inbox/constraints, filtro antes de persistir contenido y outbox/pg-boss; TRIANGULATE: demostrar cero acceso tenant para sesión desconocida, cero IA/salida para filtros/inactivo/suspendido y secuencia por conversación; REFACTOR: separar clasificación de evento de persistencia. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: PostgreSQL real procesa dos eventos iguales y mantiene una sola fila/efecto; rollback: detener dispatcher/worker y conservar inbox/mensajes para diagnóstico. <!-- sdd-owner: implementation -->

### 14. Historial completo y representación contextual segura — 330–400 líneas

**Trazabilidad:** Diseño §§5, 7–8 y 11; `messaging-and-ai`/Historial conversacional completo y aislado, ambos escenarios; Respuesta contextual.

- [x] RED: añadir pruebas de resumen versionado, full-text con tenant/conversación obligatorios, ventana reciente y ausencia de resumen; GREEN: implementar `packages/db/migrations/0006_conversation_context.sql` con `conversation_summary` e índices, `packages/domain/src/messaging/conversation-context-builder.ts`, puerto de resumen estructurado y límites de tamaño; TRIANGULATE: comprobar que todo crudo se conserva, que un resumen ausente/fallido bloquea IA y que no entran chats/secretos de otro tenant; REFACTOR: normalizar presupuesto de contexto y serializador allowlisted. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:tenant-isolation`, `bun run test:contracts`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: Testcontainers reconstruye contexto desde prefijo+recuperación+ventana después de reinicio; rollback: detener generación contextual conservando historial crudo y versiones. <!-- sdd-owner: implementation -->

### 15. Adaptador DeepSeek y procesamiento asíncrono — 330–400 líneas

**Trazabilidad:** Diseño §§2, 7–8 y 11; `messaging-and-ai`/Respuesta contextual, Límite reemplazable y Fallo de IA, todos los escenarios.

- [x] RED: crear pruebas de contrato `AiProvider`, prompt con prioridad de negocio, timeouts, 429/5xx, respuesta inválida y no filtración de clave; GREEN: implementar `packages/ai-deepseek/src/deepseek-adapter.ts`, `apps/message-worker/src/ai-job.ts`, advisory lock por conversación, llamada única con AbortSignal (5 s conexión/30 s total), estado `ai_failed` y auditoría/evento técnico; TRIANGULATE: demostrar que el adaptador es sustituible, que prompt injection no añade herramientas/secretos y que fallo produce silencio; REFACTOR: extraer constructor de request y clasificador de errores. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: worker con doble determinista consume job y no llama salida al fallar IA; rollback: pausar cola de IA y dejar mensajes/outbox auditables sin reenviar. <!-- sdd-owner: implementation -->

### 16. Outbox saliente, ACK y estados de entrega conservadores — 300–380 líneas

**Trazabilidad:** Diseño §§2, 6 y 9; `messaging-and-ai`/Respuesta contextual y Fallo de envío; `configuration-and-whatsapp`/Sesión no disponible para envío.

- [x] RED: escribir pruebas de `pending/processing/generated/sending/sent/failed/delivery_unknown`, crash durante envío, ACK y eco `fromMe`; GREEN: implementar `packages/domain/src/messaging/outbound-delivery.ts`, `apps/whatsapp-manager/src/outbound-dispatcher.ts` y migración de comando saliente con `outbound_id`, claim del gestor dueño, uso obligatorio de la misma conexión, reconciliación de ACK y actualización de estado/auditoría/actividad; TRIANGULATE: comprobar que no hay reintento tras inicio ambiguo, que rechazo inequívoco es `failed` y que conexión no apta no envía; REFACTOR: encapsular máquina de entrega y contrato del gateway. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: doble Baileys simula caída/ACK y confirma que no duplica una respuesta; rollback: pausar dispatcher saliente y conservar filas para trazabilidad. <!-- sdd-owner: implementation -->

### 17. Observabilidad, auditoría verificable y seguridad transversal — 320–400 líneas

**Trazabilidad:** Diseño §§8–9 y 11; `persistence-and-operations`/Auditoría, Actividad técnica y Errores seguros; todos sus escenarios; `administration-and-isolation`/Aislamiento estricto.

- [x] RED: añadir pruebas de auditoría append-only/HMAC, redacción de logs, métricas/trazas y matriz negativa multi-tenant de todos los repositorios/endpoints; GREEN: implementar `packages/observability/src/index.ts`, instrumentación OpenTelemetry HTTP/jobs/DB/proveedores, logs JSON pseudónimos, proyección `last_technical_activity_at`, métricas/alertas y kill switch operacional; TRIANGULATE: verificar fallo IA/conexión/envío auditado sin secreto, admin sin contenido conversacional y ausencia contractual de rutas `/conversations`/`/messages`; REFACTOR: centralizar redactor y catálogo de eventos. Verificar con `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run lint`, `bun run typecheck`, `bun run db:check`, `bun run build`; runtime: suite integra un fallo simulado y comprueba trazabilidad segura y estado visible; rollback: desactivar exportadores/alertas sin eliminar auditoría primaria. <!-- sdd-owner: implementation -->

### 18. CI, backup/restore y aceptación integral — 300–380 líneas

**Trazabilidad:** Diseño §§9, 11 y 13; `persistence-and-operations`/Persistencia principal y Sin visor de conversaciones; criterios de éxito de las cuatro specs.

- [x] RED: definir en `.github/workflows/ci.yml` y `docs/operations.md` verificaciones que fallen ante migración/drift, restore, secretos o ruta fuera de alcance; GREEN: configurar CI con Docker/Testcontainers, `bun install --frozen-lockfile`, lint, tipos, todas las suites, migración limpia, `db:check` y build; añadir runbooks de backup cifrado, PITR, restore trimestral, KEK histórica, rollback binario/migración correctiva y despliegue gradual; TRIANGULATE: ensayar restore aislado con conteos por tenant, RLS, jobs y auth Baileys cifrada, y Playwright del flujo admin→tenant→vínculo doble→mensaje→IA doble→ACK; REFACTOR: consolidar fixtures, scripts y matriz de aceptación en `docs/acceptance.md`. Verificar con `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run test`, `bun run db:check`, `bun run build`; runtime: CI y ensayo de restore completan los flujos sin proveedores reales; rollback: revertir workflow/runbooks/scripts de prueba sin eliminar backups ni datos restaurados. <!-- sdd-owner: implementation -->

## Decisión previa del responsable

- [x] El usuario aceptó explícitamente `size:exception`; `delivery_strategy: exception-ok`. La elección condicional `stacked-to-main` queda inactiva mientras no se use entrega encadenada. <!-- sdd-owner: parent -->

## Plan de remediación posterior a verify

El informe `openspec/changes/agendia-v1/verify-report.md` falló y bloqueó el archivo: los 18 checkboxes históricos permanecen como registro de lo ejecutado, pero **no prueban completitud funcional**. Las nueve unidades nuevas, sin marcar, sustituyen esa implicación de finalización falsa mediante composición de producción y evidencia ejecutable; no reducen el PRD ni las specs. Se mantiene Bun para tooling, Node LTS para runtime, un usuario y una sesión WhatsApp por negocio, y los no objetivos existentes (incluidos visor de conversaciones, registro, recuperación, usuarios o sesiones adicionales). No crear commits, push, PR ni revisiones; receipt-driven development sigue `disabled/unmanaged`.

### Forecast de carga de remediación

| Unidad | Límite verificable | Estimación exacta | Inicio → final | Reversión independiente |
| --- | ---: | ---: | --- | --- |
| 19. Base TDD y gates reales | ≤400 | 330 líneas | Harnesses reclamados → suites agregadas y checks reales. | Scripts, configuración y evidencia de la unidad. |
| 20. PostgreSQL, UoW, grants y pg-boss | ≤400 | 390 líneas | Servicios en memoria → repositorios/UoW productivos con worker autorizado. | Adaptadores/repositorios y grants aditivos. |
| 21. Composición Fastify, auth y rutas | ≤400 | 390 líneas | Tres rutas incompletas → API autenticada admin/me. | Bootstrap HTTP y rutas, preservando datos. |
| 22. Baileys real y gestor persistente | ≤400 | 390 líneas | Doble único → adaptador real compuesto con dobles de contrato. | Manager/adaptador; detener consumidores sin borrar credenciales. |
| 23. Workers ejecutables de ingesta a salida | ≤400 | 400 líneas | Funciones aisladas → cola, contexto, IA y salida PostgreSQL. | Pausar workers/dispatchers, conservar inbox/outbox/mensajes. |
| 24. Paneles Next.js conectados | ≤400 | 350 líneas | Páginas estáticas → formularios/sesión/API reales. | Componentes cliente y rutas UI de la unidad. |
| 25. E2E de sistema del flujo feliz | ≤400 | 380 líneas | `page.setContent` → web/API/manager/worker/PG arrancados. | Harness, fixtures y dobles de sistema. |
| 26. E2E de fallos, aislamiento y continuidad | ≤400 | 370 líneas | Flujos felices → contención, no cruce y recuperación reales. | Escenarios/fixtures de esta unidad. |
| 27. Trazabilidad y aceptación integrada | ≤400 | 260 líneas | Evidencia por piezas → matriz normativa y aceptación ejecutable final. | Documentación, matriz y scripts de aceptación. |
| **Total** | **cada unidad ≤400** | **3.260 líneas** | **9 unidades acotadas** | **Reversiones separadas** |

## Review Workload Forecast

| Field | Value |
| ------- | ------- |
| Estimated changed lines | 3.260 total; unidades 19–27 de 260–400 cada una |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Unidad 19 → 20 → 21 → 22 → 23 → 24 → 25 → 26 → 27 |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

### Evidencia TDD obligatoria para cada unidad

Cada unidad añade una fila fechada y verificable a `docs/tdd-remediation-evidence.md` con las columnas exactas **SAFETY NET, RED, GREEN, TRIANGULATE, REFACTOR**, archivo de prueba, comando literal, código de salida y resultado. `SAFETY NET` es la ejecución verde previa de la suite afectada; `RED` conserva la salida no-cero de la prueba nueva antes de implementar; `GREEN` registra el primer verde; `TRIANGULATE` registra el caso independiente; y `REFACTOR` registra la suite verde tras simplificar. Ninguna prueba nueva queda fuera de `bun run test`: la unidad 19 corrige su agregación y las posteriores actualizan el selector raíz al añadir una suite. Los comandos se ejecutan con `PATH="$HOME/.bun/bin:$PATH"` mientras Bun no esté publicado en el PATH de la shell.

### Unidades de remediación

#### 19. Base de evidencia estricta y gates que ejercitan lo que declaran — 330 líneas

**Bloqueadores:** TDD estricto incompleto, assertion vacía y gates engañosos; prepara el safety net de las unidades 20–27.

- [x] SAFETY NET: ejecutar y registrar en `docs/tdd-remediation-evidence.md` los resultados previos de `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts`, `bun run test`, `bun run db:check` y `bun run lint`; RED: crear pruebas fallidas en `tests/scaffolding.test.ts`, `tests/integration/tenant-rls.integration.test.ts` y `tests/integration/db-check.integration.test.ts` que demuestren respectivamente inclusión en `bun run test`, colección no vacía antes de `every`, y migración limpia/drift real; GREEN: actualizar `package.json`, `scripts/db-check.ts`, `tests/scaffolding.test.ts` y la assertion de `tests/integration/tenant-rls.integration.test.ts` para agregar scaffolding, exigir `rows.length > 0` y levantar PostgreSQL/migrar con rol DDL; TRIANGULATE: añadir a `tests/integration/db-check.integration.test.ts` una migración/drift inválido temporal que el check rechace; REFACTOR: centralizar el arranque PostgreSQL y el registro de ciclos en `packages/test-support/src/index.ts` y crear la tabla con las cinco columnas en `docs/tdd-remediation-evidence.md`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck` y `bun run build`; rollback: revertir solo `package.json`, scripts, fixtures, pruebas y evidencia de esta unidad. <!-- sdd-owner: implementation -->

#### 20. Repositorios PostgreSQL, Unit of Work, permisos y cola durable — 390 líneas

**Bloqueadores:** persistencia desconectada y `agendia_worker_runtime` sin permiso de outbox; depende de 19.

- [x] SAFETY NET: registrar en `docs/tdd-remediation-evidence.md` el verde de `PATH="$HOME/.bun/bin:$PATH" bun run test:integration` y `bun run test:tenant-isolation`; RED: crear `tests/integration/postgres-repositories.integration.test.ts` y `tests/integration/worker-grants-pgboss.integration.test.ts` que fallen al persistir/recuperar auth, administración, perfil, asistente, conexiones, auditoría, inbox/outbox y al consumir `outbox_events`/un job pg-boss como `agendia_worker_runtime`; GREEN: implementar repositorios concretos, `TenantUnitOfWork` transaccional y composición de pools por rol en `packages/db/src/{index.ts,repositories.ts,unit-of-work.ts}`, y migración/grants aditivos en `packages/db/migrations/0012_runtime_repositories_grants.sql` para API, manager y worker con mínimo privilegio y pg-boss; TRIANGULATE: probar contexto ausente, falsificado y dos tenants, rollback de mutación+auditoría+outbox y denegación de conversaciones/credenciales al pool admin; REFACTOR: extraer fixtures y builders de contexto/rol a `packages/test-support/src/postgres.ts`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:integration`, `bun run test:tenant-isolation`, `bun run db:check`, `bun run test`, `bun run lint` y `bun run typecheck`; rollback: deshabilitar los adaptadores y aplicar solo migración correctiva/grants aditivos, sin borrar filas operativas. <!-- sdd-owner: implementation -->

#### 21. Composición Fastify con sesiones cookie, CSRF/Origin y rutas admin/me — 390 líneas

**Bloqueadores:** API/auth no funcionales y rutas no registradas; depende de 20.

- [x] SAFETY NET: registrar el resultado previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts` y `bun run test:integration`; RED: crear `tests/integration/http-auth-admin-me.integration.test.ts` que falle para `Set-Cookie` `__Host-agendia_session`, logout/revocación y expiración, CSRF/Origin hostil, `/auth/session`, CRUD/admin de negocio/usuario/estado y `/me/{business-profile,assistant,whatsapp}` con tenant exclusivamente derivado de sesión; GREEN: componer repositorios PostgreSQL en `apps/api/src/app.ts` e `apps/api/src/index.ts`, registrar `apps/api/src/routes/{auth.ts,admin.ts,business-profile.ts,assistant.ts,me-whatsapp.ts}`, y conectar `packages/auth/src/index.ts` a sesiones opacas cookie/CSRF/Origin y UoW auditada; TRIANGULATE: cubrir negocio suspendido, cambio de contraseña, rol equivocado, ID ajeno, body con `business_id`, Origin ausente y errores Zod sin efectos; REFACTOR: consolidar guardas, serializadores allowlisted y manejo uniforme de errores en `apps/api/src/{auth-context.ts,http-errors.ts}`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts`, `bun run test:integration`, `bun run test:tenant-isolation`, `bun run test`, `bun run lint`, `bun run typecheck` y `bun run build`; rollback: retirar solo la composición/rutas HTTP y conservar sesiones/datos mediante migración correctiva no destructiva. <!-- sdd-owner: implementation -->

#### 22. Dependencia Baileys, adaptador real y manager con sesión PostgreSQL — 390 líneas

**Bloqueadores:** Baileys ausente y ciclo de vida no ejecutable; depende de 20 y consume el contrato HTTP de 21.

- [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:unit` y `bun run test:integration`; RED: crear `tests/contracts/baileys-gateway.contract.test.ts` y `tests/integration/baileys-manager-persistence.integration.test.ts` que fallen para QR efímero, vínculo 1:1, auth cifrada PostgreSQL, advisory lock/heartbeat, reinicio, desconexión/logout/corrupción y no exposición de secretos; GREEN: añadir la dependencia Baileys compatible al `package.json` y lockfile Bun, implementar `packages/whatsapp-baileys/src/{baileys-gateway.ts,auth-store.ts}` y componerla en `apps/whatsapp-manager/src/{index.ts,lifecycle.ts}` con repositorios PostgreSQL, KMS por entorno y comandos durables; TRIANGULATE: ejecutar los mismos contratos contra `DeterministicBaileysDouble` y un fake socket determinista sin cuenta real, incluyendo lock competido, QR expirado y segunda vinculación rechazada; REFACTOR: mantener Baileys aislado tras `WhatsAppGateway` y trasladar fixtures a `packages/test-support/src/baileys.ts`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:unit`, `bun run test:contracts`, `bun run test:integration`, `bun run test:tenant-isolation`, `bun run test`, `bun run lint` y `bun run typecheck`; runtime: arrancar manager contra PostgreSQL/Testcontainers y fake socket, sin cuenta ni red WhatsApp real; rollback: detener el manager y consumidores de vínculo, preservando ciphertext, DEK envuelta y metadatos. <!-- sdd-owner: implementation -->

#### 23. Workers de ingesta, contexto, DeepSeek y salida contra PostgreSQL/cola — 400 líneas

**Bloqueadores:** flujo de mensajería desconectado, pg-boss sin uso y worker no ejecutable; depende de 20 y 22.

- [x] SAFETY NET: registrar el verde de `PATH="$HOME/.bun/bin:$PATH" bun run test:integration`, `bun run test:contracts` y `bun run test:tenant-isolation`; RED: crear `tests/integration/message-processing-worker.integration.test.ts` y `tests/contracts/worker-provider.contract.test.ts` que fallen para evento Baileys conocido/desconocido, deduplicación y filtros, router `session_public_id→business_id` antes de acceso tenant, historial/contexto PostgreSQL, job pg-boss, timeout/error DeepSeek silencioso, outbox/salida por la misma sesión y `delivery_unknown`; GREEN: componer `apps/whatsapp-manager/src/{inbound-handler.ts,outbound-dispatcher.ts}` y `apps/message-worker/src/{index.ts,ai-job.ts}` con repositorios/UoW/pg-boss, `packages/domain/src/messaging/{conversation-context-builder.ts,outbound-delivery.ts}` y `packages/ai-deepseek/src/deepseek-adapter.ts`; TRIANGULATE: usar dobles deterministas de socket y `fetch` para grupo/propio/media, negocio suspendido, asistente inactivo, fuera de horario, crash posterior a inicio de envío, dos tenants y resumen ausente; REFACTOR: separar bootstrap de procesos, claims/locks y clasificación de errores en `packages/test-support/src/worker-fixtures.ts`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test`, `bun run db:check`, `bun run lint` y `bun run typecheck`; runtime: iniciar manager y worker contra PostgreSQL/pg-boss con providers dobles y constatar un mensaje persistido y como máximo una salida; rollback: pausar workers/dispatchers y conservar inbox, outbox, historial y auditoría. <!-- sdd-owner: implementation -->

#### 24. Paneles Next.js vivos contra contratos HTTP reales — 350 líneas

**Bloqueadores:** paneles estáticos y formularios sin submit; depende de 21 y 22.

- [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run build` y `bun run test:contracts`; RED: crear `tests/contracts/web-api-client.contract.test.ts` que falle para login cookie/CSRF, lectura de sesión, tabla admin y guardado de perfil/asistente/vínculo mediante los contratos HTTP reales; GREEN: sustituir `sample = []`, estado fijo y formularios inertes en `apps/web/app/(admin)/businesses/page.tsx`, `apps/web/app/(business)/{profile,assistant,whatsapp}/page.tsx` y `apps/web/src/{admin-view.ts,profile-view.ts,assistant-view.ts,whatsapp-view.ts}` por clientes/form actions que llamen a `/api`, muestren errores seguros y no acepten tenant del navegador; TRIANGULATE: probar sesión expirada/suspendida, error de validación, conflicto de revisión, rol equivocado, QR `no-store` y ausencia de enlaces a conversaciones; REFACTOR: unificar fetch autenticado, CSRF y estados accesibles en `apps/web/src/api-client.ts` y componentes compartidos. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts`, `bun run test`, `bun run lint`, `bun run typecheck` y `bun run build`; runtime: ejecutar Next contra API real de pruebas y comprobar requests HTTP con cookie, nunca acceso directo a PostgreSQL/proveedores; rollback: retirar solo clientes/componentes de esta unidad sin alterar API ni persistencia. <!-- sdd-owner: implementation -->

#### 25. Harness E2E de sistema y flujos felices reales — 380 líneas

**Bloqueadores:** `page.setContent` no acredita E2E; depende de 21–24.

- [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e` y preservar los siete harnesses como evidencia histórica no E2E; RED: crear `tests/e2e/system-happy-path.spec.ts` que inicialmente falle al requerir `page.goto`, web Next, API Fastify, manager, worker, PostgreSQL y doubles de proveedor arrancados para admin→alta/credencial→login tenant→perfil→asistente activo→vínculo→texto individual→DeepSeek doble→ACK; GREEN: implementar arranque/paro aislado en `tests/e2e/support/{system.ts,providers.ts,fixtures.ts}`, actualizar `playwright.config.ts`, `docker-compose.yml` y scripts de `package.json` para usar PostgreSQL real, pg-boss y procesos reales; TRIANGULATE: ejecutar dos tenants y dos chats, confirmar que solo el evento admisible del tenant correcto genera una salida por su misma conexión y que los horarios no bloquean; REFACTOR: eliminar/reclasificar los `page.setContent` como unitarios de renderer fuera de `tests/e2e` y compartir lifecycle de servicios. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e`, `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck` y `bun run build`; rollback: eliminar únicamente orchestration/fixtures E2E y restaurar scripts sin tocar servicios o datos. <!-- sdd-owner: implementation -->

#### 26. E2E de contención, aislamiento, fallos y recuperación — 370 líneas

**Bloqueadores:** cobertura funcional, seguridad y operación todavía no demostradas como sistema; depende de 25.

- [x] SAFETY NET: registrar el verde de `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e`, `bun run test:tenant-isolation` y `bun run backup:drill`; RED: crear `tests/e2e/system-failure-isolation.spec.ts` que falle para cookie expirada/CSRF-Origin hostil, IDOR admin/me, suspensión/reactivación conservando asistente inactivo, segunda sesión WhatsApp, sesión desconocida, grupo/propio/media, DeepSeek timeout, rechazo/caída ambigua de salida, reconexión y reinicio de manager/worker; GREEN: conectar los estados/auditoría/actividad y readiness necesarios en `apps/api/src`, `apps/whatsapp-manager/src`, `apps/message-worker/src` y `packages/observability/src/index.ts` para que los resultados persistan y se observen por las rutas autorizadas; TRIANGULATE: ejecutar los casos con dos tenants y datos no vacíos, verificando cero filas, contexto, IA o salida cruzados y redacción de secretos en API/log collector; REFACTOR: extraer fixtures de doble proveedor y assertions de aislamiento a `tests/e2e/support` sin volver a `page.setContent`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e`, `bun run test:tenant-isolation`, `bun run test`, `bun run backup:drill`, `bun run security:scan`, `bun run lint`, `bun run typecheck` y `bun run build`; runtime: los cuatro procesos y PostgreSQL sobreviven reinicio controlado y los dobles no requieren cuentas reales; rollback: retirar exclusivamente escenarios/fixtures y desactivar procesos de prueba, conservando persistencia. <!-- sdd-owner: implementation -->

#### 27. Trazabilidad normativa, aceptación integrada y cierre TDD — 260 líneas

**Bloqueadores:** 18/19 criterios sin evidencia funcional y Safety Net/RED no trazables; depende de 19–26 y se ejecuta solo cuando los flujos integrados existan.

- [x] SAFETY NET: registrar en `docs/tdd-remediation-evidence.md` el estado verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test`, `bun run test:e2e`, `bun run db:check` y `bun run build`; RED: crear `tests/acceptance/remediation-traceability.acceptance.test.ts` que falle si una requirement/escenario de `openspec/changes/agendia-v1/specs/{administration-and-isolation,configuration-and-whatsapp,messaging-and-ai,persistence-and-operations}/spec.md` o criterio 1–19 de `proposal.md` carece de prueba de sistema, comando y evidencia TDD; GREEN: completar `docs/acceptance.md`, `docs/tdd-remediation-evidence.md`, `packages/test-support/src/v1-acceptance.ts`, `tests/acceptance/remediation-traceability.acceptance.test.ts` y `package.json` con matriz requisito→escenario→prueba real→comando, incluyendo los ocho bloqueadores y la ausencia continuada de capacidades fuera de alcance; TRIANGULATE: hacer fallar el validador al retirar temporalmente una referencia de escenario y comprobar que distingue una prueba en memoria de una E2E real; REFACTOR: deduplicar IDs de escenarios y comandos en una fuente tipada, manteniendo las pruebas de scaffolding y aceptación incluidas por `bun run test`. Verificar con `PATH="$HOME/.bun/bin:$PATH" bun run test`, `bun run test:e2e`, `bun run db:check`, `bun run scope:check`, `bun run security:scan`, `bun run lint`, `bun run typecheck` y `bun run build`; runtime: ejecutar la matriz contra los servicios integrados y dobles deterministas, sin WhatsApp/DeepSeek reales; rollback: retirar solo matriz, validador y documentación de aceptación, no la evidencia ni datos operativos. <!-- sdd-owner: implementation -->

  ## Unidades posteriores al verify fresco (C1–C7)

  ## Review Workload Forecast

    | Field | Value |
    | ------- | ------- |
    | Estimated changed lines | 1.790–2.310 total; 30–400 por unidad 28–34 |
    | 400-line budget risk | High |
    | Chained PRs recommended | Yes |
    | Suggested split | PR 1 (28 → 29) → PR 2 (30 → 31) → PR 3 (32 → 33) → PR 4 (34, disposición de política) |
    | Delivery strategy | ask-on-risk |
    | Chain strategy | pending |

    Decision needed before apply: Yes
    Chained PRs recommended: Yes
    Chain strategy: pending
    400-line budget risk: High

    Las unidades 28–33 son incrementos autónomos y seriales; cada una mantiene pruebas y documentación de evidencia en el mismo cambio y no supera 400 líneas autorizadas. La unidad 34 no es una corrección técnica: permanece bloqueada hasta una disposición explícita del responsable de política. No crear commits, PR, revisiones ni archivo durante este plan.

  #### 28. Ingress Baileys `messages.upsert` y salida dirigida por `remote_jid` — 330–390 líneas

    **Bloqueadores:** C1 y C2. **Dependencias:** 22–23 completadas. **Inicio → final:** socket Baileys sin ingreso compuesto y `sendMessage("")` → evento socket admisible persiste/encola mediante el manager de producción y cada salida usa el `remote_jid` de su conversación. **No objetivos:** no aceptar grupos, `fromMe` o multimedia; no derivar tenant desde remitente ni añadir canales. **Rollback:** detener manager/dispatcher y revertir solo `baileys-gateway`, composición, migración/adaptador de `remote_jid`, fixtures y pruebas de esta unidad; conservar inbox/outbox/mensajes.

  - [x] SAFETY NET: registrar el verde previo en `docs/tdd-remediation-evidence.md` para `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts`, `bun run test:integration` y `bunx playwright test tests/e2e/system-happy-path.spec.ts --project=system`; RED: hacer fallar `tests/contracts/baileys-gateway.contract.test.ts`, `tests/integration/{baileys-manager-persistence.integration.test.ts,message-processing-worker.integration.test.ts}` y `tests/e2e/system-happy-path.spec.ts` al emitir `messages.upsert` en el socket determinista sin persistencia/job, y al rechazar el fake un JID vacío o distinto al `conversation.remote_jid`; GREEN: en `packages/whatsapp-baileys/src/baileys-gateway.ts` suscribir `messages.upsert`, traducir solo mensajes soportados a `InboundWhatsAppEvent` e inyectarlos por `apps/whatsapp-manager/src/{index.ts,lifecycle.ts,inbound-handler.ts}`, y transportar el `remote_jid` devuelto por `claim_owned_outbound` a `apps/whatsapp-manager/src/outbound-dispatcher.ts`/`sendMessage`; TRIANGULATE: demostrar en `tests/e2e/support/{system.ts,providers.ts}` que sesión desconocida, grupo, propio y media no cruzan el borde socket, y que dos conexiones concurrentes solo envían a su propio JID sin aceptar `""`; REFACTOR: aislar normalización Baileys y el contrato de destinatario, sin duplicar el JID en comandos si puede retornarlo el claim. Gates: los tres comandos SAFETY NET focalizados, después `bun run test`, `bun run lint` y `bun run typecheck`; runtime: E2E `page.goto` emite por socket y observa una salida dirigida; presupuesto ≤400 líneas. <!-- sdd-owner: implementation -->

  #### 29. QR de vínculo efímero persistido, autorizado y visible — 300–370 líneas

    **Bloqueador:** C3. **Dependencia:** 28. **Inicio → final:** `GET /me/whatsapp/link` devuelve siempre `NOT_FOUND` → el negocio dueño obtiene y ve solo su QR vigente antes de apertura. **No objetivos:** no exponer material de auth, QR a admin/otro tenant ni almacenar QR sin expiración. **Rollback:** retirar únicamente tabla/migración aditiva, repositorio, ruta/UI y fixtures QR; invalidar códigos y conservar conexión/credenciales.

  - [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:integration`, `bun run test:contracts` y `bunx playwright test tests/e2e/{system-happy-path.spec.ts,system-failure-isolation.spec.ts} --project=system`; RED: hacer fallar `tests/integration/baileys-manager-persistence.integration.test.ts`, `tests/contracts/web-api-client.contract.test.ts` y ambos E2E cuando POST de vínculo seguido de evento QR no permita GET autenticado de un código tenant-owned vigente, o cuando la UI convierta `NOT_FOUND` en éxito; GREEN: añadir `packages/db/migrations/0017_whatsapp_link_codes.sql` y repositorio, persistir/reemplazar atómicamente QR cifrado con expiración de reloj servidor en `apps/whatsapp-manager/src/lifecycle.ts`, invalidarlo en open/logout/error/expiry, exponerlo solo al dueño desde `apps/api/src/app.ts` con `Cache-Control: no-store`, y renderizarlo en `apps/web/src/{api-client.ts,live-panel.tsx}`; TRIANGULATE: cubrir expiración, reemplazo sin borrar QR más nuevo, invalidación post-open, rol/tenant incorrecto y cabecera `no-store`, dejando que E2E vea QR antes de `open`; REFACTOR: centralizar serialización efímera y limpieza condicional por versión. Gates: suites focalizadas, `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: sistema obtiene QR visible sin cuenta WhatsApp real; presupuesto ≤400 líneas. <!-- sdd-owner: implementation -->

  #### 30. Dispatcher durable de outbox `ai.generate` a pg-boss y recuperación — 250–330 líneas

    **Bloqueador:** primera mitad de C4. **Dependencia:** 28. **Inicio → final:** fila `ai.generate` sin publicar tras caída → dispatcher del manager reclama, publica con identidad estable y recupera filas pendientes al arrancar. **No objetivos:** no marcar publicado antes del acuse del broker, no mantener lock/transacción SQL durante I/O pg-boss ni prometer exactly-once. **Rollback:** pausar dispatcher y revertir `0018_outbox_dispatch.sql`, repositorio, bootstrap y pruebas de la unidad; conservar outbox/inbox para recuperación.

  - [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:integration` y `bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system`; RED: en `tests/integration/message-processing-worker.integration.test.ts` persistir ingreso aceptado con pg-boss no disponible, reiniciar `startWhatsAppManager` y comprobar que una fila no marcada no llega a job, evitando `queue.send` directo; GREEN: sustituir publicación directa de `PostgresInboundHandler` por dispatcher acotado en `apps/whatsapp-manager/src/{index.ts,inbound-handler.ts}`, con `packages/db/migrations/0018_outbox_dispatch.sql`/`packages/db/src/repositories.ts` para claim recuperable, envío pg-boss con clave singleton estable y marcado solo tras éxito; TRIANGULATE: simular crash/error previo a publish, dos dispatchers y filas/jobs duplicados, verificando una sola salida efectiva mediante consumidor idempotente; REFACTOR: extraer política de visibilidad/reintento y fixture de recovery a `packages/test-support/src/worker-fixtures.ts`. Gates: integración focalizada y E2E de recovery, luego `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: reinicio manager drena fila preexistente contra PostgreSQL/pg-boss; presupuesto ≤400 líneas. <!-- sdd-owner: implementation -->

  #### 31. Generación y actualización productiva de resúmenes conversacionales — 330–400 líneas

    **Bloqueador:** segunda mitad de C4. **Dependencia:** 30. **Inicio → final:** resúmenes insertados manualmente y conversaciones largas bloqueadas → trabajo durable tenant-scoped escribe versiones/watermarks monotónicos y el contexto consume la última válida. **No objetivos:** no borrar historial crudo, no cruzar tenant/chat ni enviar respuesta si falla resumen. **Rollback:** pausar jobs de resumen y revertir solo `0019_conversation_summary_jobs.sql` si existe, escritor, adaptador y pruebas; preservar mensajes y versiones ya producidas.

  - [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:contracts`, `bun run test:integration` y `bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system`; RED: hacer fallar `tests/{contracts/worker-provider.contract.test.ts,integration/message-processing-worker.integration.test.ts}` para una conversación que excede presupuesto sin fila manual, sin actualización `covered_through`, o que queda bloqueada; GREEN: programar desde persistencia inbound un job durable de resumen en `apps/message-worker/src/{index.ts,ai-job.ts}`, definir solicitud estructurada acotada en `packages/ai-deepseek/src/deepseek-adapter.ts` si procede, y escribir versión/watermark atómicos tenant-scoped mediante `packages/db/src/repositories.ts`, `packages/domain/src/messaging/conversation-context-builder.ts` y migración `0019_conversation_summary_jobs.sql` solo si necesita estado; TRIANGULATE: reiniciar entre programación/proceso, concurrencia de mensajes con watermark monotónico, segundo tenant/chat aislado y fallo proveedor silencioso sin salida; REFACTOR: separar planificación, validación de summary y carga de contexto versionada. Gates: contrato de worker/proveedor, integración y E2E recovery, luego `bun run test`, `bun run db:check`, `bun run lint`, `bun run typecheck`; runtime: worker real con dobles genera resumen y permite continuar sin proveedores reales; presupuesto ≤400 líneas. <!-- sdd-owner: implementation -->

  #### 32. Auditoría de acceso/ciclo de vida/fallo de envío y actividad administrativa — 300–380 líneas

    **Bloqueador:** C5. **Dependencias:** 28–31 según la ruta ejercida; requiere 29 para ciclo QR y 28 para fallo saliente. **Inicio → final:** accesos/transiciones/fallos sin auditoría y tabla sin actividad → eventos seguros append-only y `lastTechnicalActivityAt` visible al admin. **No objetivos:** no guardar contenido conversacional, credenciales, QR, JID completo ni errores crudos de proveedor; no ampliar lectura admin a conversaciones. **Rollback:** retirar instrumentación, migración aditiva si es necesaria, proyección UI y pruebas de esta unidad; no borrar auditoría/eventos existentes.

  - [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:integration`, `bun run test:contracts` y `bunx playwright test tests/e2e/system-failure-isolation.spec.ts --project=system`; RED: hacer fallar `tests/integration/{http-auth-admin-me.integration.test.ts,baileys-manager-persistence.integration.test.ts,message-processing-worker.integration.test.ts}` y `tests/contracts/web-api-client.contract.test.ts` cuando login/logout, QR/open/close/logout/error o `failed`/`delivery_unknown` no produzcan auditoría/evento técnico seguro, o cuando la tabla admin omita actividad; GREEN: añadir política explícita para auditoría platform sin `business_id` en `packages/db/{migrations/0020_audit_runtime_events.sql,repositories.ts}`, instrumentar `apps/api/src/app.ts`, `apps/whatsapp-manager/src/{lifecycle.ts,outbound-dispatcher.ts}` y mostrar `lastTechnicalActivityAt` en `apps/web/src/{api-client.ts,live-panel.tsx}`; TRIANGULATE: ejercer acceso tenant/admin, fallo lifecycle, ambos resultados de envío y visibilidad admin sin contenido, comprobando proyección de actividad y metadatos redactados; REFACTOR: centralizar catálogo de eventos y redacción sin debilitar append-only/RLS. Gates: integración HTTP/manager/worker, contrato web y E2E de fallo, luego `bun run test`, `bun run db:check`, `bun run security:scan`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: sistema muestra actividad sin log/conversación; presupuesto ≤400 líneas. <!-- sdd-owner: implementation -->

  #### 33. E2E semántico y aceptación anti-bypass — 250–360 líneas

    **Bloqueador:** C6; valida C1–C5. **Dependencias:** 28–32. **Inicio → final:** mapeo sintáctico permite atajos → matriz exige assertions nombradas de frontera de proveedor y escenarios de sistema semánticos. **No objetivos:** no afirmar que inspección estática prueba semántica ni convertir harnesses históricos de renderer en evidencia system. **Rollback:** retirar solo assertions, metadata, fixtures, matriz y documentación de aceptación de esta unidad.

  - [x] SAFETY NET: registrar el verde previo de `PATH="$HOME/.bun/bin:$PATH" bun run test:acceptance` y `bunx playwright test tests/e2e/{system-happy-path.spec.ts,system-failure-isolation.spec.ts} --project=system`; RED: modificar `tests/acceptance/remediation-traceability.acceptance.test.ts` para que falle si un test mapeado invoca handler directo en vez de socket ingress, fake provider acepta JID vacío, o `NOT_FOUND` QR se declara éxito; GREEN: reforzar `tests/e2e/support/{system.ts,providers.ts}`, ambos system specs, `tests/contracts/web-api-client.contract.test.ts`, `packages/test-support/src/v1-traceability.ts`, `docs/acceptance.md` y `docs/tdd-remediation-evidence.md` con assertion conductual nombrada, capa, frontera proveedor y comando focalizado por escenario; TRIANGULATE: relabel de handler directo como socket, permitir `""`, y mapear fallo QR como éxito, comprobando que cada mutación roja bloquea el validador y que los harnesses `page.setContent` siguen marcados no-system; REFACTOR: deduplicar IDs/metadatos tipados sin imponer una prueba por ID cuando un escenario semántico cubre varios requisitos. Gates: `bun run test:acceptance`, E2E focalizado, `bun run test`, `bun run test:e2e`, `bun run db:check`, `bun run scope:check`, `bun run security:scan`, `bun run lint`, `bun run typecheck`, `bun run build`; runtime: servicios integrados y dobles ejercen socket, QR y JID; presupuesto ≤400 líneas. <!-- sdd-owner: implementation -->

  #### 34. Disposición veraz de procedencia strict-TDD — 30–80 líneas

    **Bloqueador:** C7. **Dependencia:** 33. **Inicio → final:** evidencia histórica RED/SAFETY NET incompleta → registro explícito de imposibilidad histórica y decisión de política pendiente, sin convertir GREEN actual en procedencia TDD. **No objetivos:** no fabricar timestamps, salida fallida, filas retrospectivas, ni presentar un fallo build/type como RED conductual. **Rollback:** retirar solo la nota/disposición de gobierno nueva; no alterar evidencia histórica, código, specs, proposal, design ni `verify-report.md`.

  - [x] SAFETY NET/RED/GREEN/TRIANGULATE/REFACTOR históricos: no aplicables y no recreables para las unidades 1–18 ni para el alcance ya parcialmente implementado de 22, 24 y 25; registrar en `docs/tdd-remediation-evidence.md` y en este plan únicamente la evidencia futura completa de 28–33, separada de la histórica; solicitar al responsable explícito de la política una waiver o re-baseline documentada que cambie elegibilidad de archivo, o mantener C7 y verify en FAIL; no marcar esta unidad ni declarar PASS sin esa disposición. Gate: ningún test puede verificar ejecución histórica ausente; tras una disposición explícita, rerun independiente de verify debe informar excepción autorizada o C7 FAIL, nunca PASS por suites verdes actuales; runtime: N/A, es gobernanza/procedencia y no existe frontera ejecutable; presupuesto ≤400 líneas. <!-- sdd-owner: parent -->

      **Disposición autorizada (2026-08-28): re-baseline explícito.** El responsable humano del cambio reconoce que la procedencia RED/SAFETY NET previa no existe y no puede reconstruirse. La evidencia contemporánea de las unidades 28–33 y sus gates verdes pasa a ser la línea base verificable, sin reclasificarla como TDD histórico. Desde esta disposición, todo cambio posterior conserva strict TDD con evidencia prospectiva. La elegibilidad de archivo depende todavía de un verify independiente fresco que cite esta excepción; la disposición no sustituye specs, tests ni verificación.

## Remediación acotada posterior al verify fresco (2026-08-30)

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

- [x] Corregir sin debilitar los gates de identidad durable de revínculo y assertion semántica `durable-outbox-recovery`; añadir mediante RED→GREEN→TRIANGULATE→REFACTOR cobertura focal prospectiva del throttle serializado de reconexión (intervalo mínimo de 15 s, cero solapamiento y siguiente intento solo tras completar); registrar la segunda re-baseline explícita del 2026-08-30 y ejecutar unit, integration, acceptance, agregado, lint, typecheck, build y `git diff --check`. Límite: solo las superficies autorizadas por el usuario, sin proveedores reales ni cambios de estado runtime. <!-- sdd-owner: implementation -->

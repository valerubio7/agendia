# Exploración v2: despliegue doméstico con cuatro entornos

## Propósito y estado comprobado

Esta exploración sustituye la anterior y prepara una propuesta, no una implementación. Se leyó `openspec/config.yaml`, `openspec/project-context.md` y las superficies de ejecución citadas. No se ejecutaron pruebas ni se modificó código de producto. CodeGraph/CLI no está expuesto por esta sesión; tras comprobar esa limitación se usó lectura dirigida como respaldo.

El producto es un monorepo Bun 1.4/TypeScript (`package.json`) con cuatro procesos y PostgreSQL como sistema de registro y cola:

| proceso | evidencia y función | arranque actual |
| --- | --- | --- |
| web | Next 16, `apps/web` | `bun run --cwd apps/web dev`; solo declara `dev` y `build` (`apps/web/package.json`) |
| API | Fastify, `apps/api/src/index.ts` | `bun run scripts/start-api.ts`; el paquete no declara scripts |
| manager | Baileys, sesiones y outbox, `apps/whatsapp-manager/src/index.ts` | `bun run --cwd apps/whatsapp-manager start` = Node con `tsx` |
| worker | pg-boss y DeepSeek, `apps/message-worker/src/index.ts` | `bun run --cwd apps/message-worker start` = Node con `tsx` |

El único `build` raíz hace comprobación TypeScript y `next build` de web; no genera el ejecutable de API/manager/worker (`package.json`). No hay `Dockerfile`, manifiesto de imagen, Compose de aplicación ni workflows CI en `.github/workflows`; solo existe `docker-compose.yml` para PostgreSQL. Por tanto todavía no existe un artefacto inmutable promovible.

## Modelo obligatorio de cuatro entornos

| entorno | finalidad y aislamiento | qué puede usar |
| --- | --- | --- |
| Desarrollo (workstation) | flujo diario productivo, local y descartable; nunca toca datos, secretos ni WhatsApp de producción | conservar `bun run dev`, `$HOME/.config/agendia/dev.env`, Compose PostgreSQL local y `next dev` |
| Test | automatización determinista y efímera, portable a CI; sin secretos/proveedores reales | Testcontainers PostgreSQL 16 Alpine y dobles Baileys/DeepSeek; puertos dinámicos loopback |
| Staging (home server) | validación temporal de una release candidata; pila aislada y apagada fuera de ventana; no pública por defecto | imagen candidata idéntica a producción, base/roles/volúmenes/secretos/puertos y, si se necesita, cuentas WhatsApp de ensayo propios |
| Producción (home server) | única pila persistente siempre encendida para usuarios reales | imagen ya validada, datos y secretos exclusivos, almacenamiento y backup externo obligatorios |

Staging y producción no comparten base, volumen, roles login, secretos de sesión/KEK, administrador ni cuentas de WhatsApp. Test tampoco reutiliza ninguno. Desarrollo permanece en la workstation: no se convierte en un quinto servicio del servidor ni se permite `dev-stack` contra staging/producción.

### Restricciones que deben permanecer exclusivas de desarrollo

`scripts/dev-stack.ts` exige nueve variables, `APP_ORIGIN=http://127.0.0.1:3000`, `AGENDIA_API_ORIGIN=http://127.0.0.1:3001`, `API_PORT=3001`, API y todas las URL PostgreSQL en loopback. Si PostgreSQL local no responde, ejecuta `docker compose up -d postgres`, migra y corre bootstrap de admin; inicia `next dev`, mata todo el grupo si un hijo sale y al terminar envía SIGTERM/SIGKILL tras solo 1 s. Es deliberadamente un supervisor local, no un gestor de despliegue, actualización o recuperación. El `docker-compose.yml` actual expone PostgreSQL solo en `127.0.0.1:5432`, pero contiene usuario/contraseña de desarrollo y volumen `agendia-postgres`: debe seguir siendo dev-only y jamás montar datos productivos.

## Test: contratos reutilizables y portabilidad

`tests/support/postgres.ts:startTestPostgres` inicia `postgres:16-alpine` por Testcontainers, crea URL dinámica y la detiene. Integración aplica todas las migraciones con `applyPostgresMigrations`; `tests/integration/worker-grants-pgboss.integration.test.ts` crea un login temporal miembro de `agendia_worker_runtime` y prueba pg-boss con `createSchema:false`.

La E2E de sistema (`tests/e2e/support/system.ts:startSystem`) arranca PostgreSQL efímero, API/manager/worker en proceso, puertos loopback libres y `next dev`; inyecta `DeterministicBaileysSystemDouble` y `DeterministicDeepSeekSystemDouble` (`tests/e2e/support/providers.ts`). Conserva contratos valiosos para un futuro pipeline: readiness funcional de los cuatro procesos, migraciones limpias, flujo WhatsApp→outbox→pg-boss→IA→salida, reinicio manager/worker, deduplicación y aislamiento. `scripts/restore-drill.ts` también crea fuente y destino Testcontainers, migra, hace `pg_dump --data-only`, restaura y comprueba RLS, jobs pendientes y ciphertexts.

La propuesta debe conservar estas pruebas como puerta previa a construir la imagen y añadir verificaciones de imagen arrancada (no `next dev`), configuración por entorno, health/readiness y promoción. Docker/Testcontainers son requisito de la máquina/runner de test, no una dependencia que deba instalarse para el flujo de desarrollo si no se ejecutan esas suites.

## Configuración: inventario y clasificación

Inventario de variables leídas directamente por código; una URL de base incluye secreto aunque se denomine configuración. Todas deben ser distintas por entorno y estar fuera de Git/imágenes/logs.

| variable | consumidores | clasificación: proceso / entorno / secreto / ciclo |
| --- | --- | --- |
| `DATABASE_URL` | API, migración, bootstrap; fallback manager/worker | DB migrador o runtime; D/T/S/P; secreto; persistente por pila |
| `API_DATABASE_URL` | API | login de rol API; D/T/S/P opcional; secreto; persistente |
| `ADMIN_DATABASE_URL` | API | login de rol admin; D/T/S/P opcional; secreto; persistente |
| `MANAGER_DATABASE_URL` | API y manager | login de rol manager; D/T/S/P opcional; secreto; persistente |
| `WORKER_DATABASE_URL` | API, manager pg-boss, worker | login de rol worker; D/T/S/P opcional; secreto; persistente |
| `APP_ORIGIN` | API | origen público de UI para Origin/CSRF; D/T/S/P; no secreto; por despliegue |
| `AGENDIA_API_ORIGIN` | build/config Next rewrite | URL interna API; D/T/S/P; no secreto; por build o runtime según Next a confirmar |
| `API_HOST`, `API_PORT` | API/script | bind interno y puerto; D/T/S/P; no secreto; por despliegue |
| `AGENDIA_ADMIN_EMAIL` | bootstrap | identidad inicial; D/S/P; sensible pero no secreto criptográfico; solo bootstrap/idempotente |
| `AGENDIA_ADMIN_PASSWORD` | bootstrap | contraseña; D/S/P; secreto; bootstrap, no debe quedar como secreto runtime permanente sin decisión explícita |
| `DEEPSEEK_API_KEY` | worker | proveedor IA; D/T(double)/S/P; secreto; persistente/rotatable |
| `DEEPSEEK_MODEL` | worker | selección de modelo; D/T/S/P opcional; no secreto; por release/configuración |
| `BAILEYS_KMS_VERSION`, `BAILEYS_KMS_KEY` | manager | versión y KEK AES-256; D/T/S/P; clave secreta; persistente, rotación con retención histórica |
| `WHATSAPP_LINK_CODE_KEY` | API y manager | cifrado QR; D/T/S/P; clave secreta; persistente/rotatable coordinadamente |
| `WHATSAPP_MANAGER_ID` | manager | dueño de sesiones; T/S/P opcional; no secreto; estable por réplica, cambia al recrearla |
| `WHATSAPP_COMMAND_POLL_MS` | manager | polling/reconexión; T/S/P opcional; no secreto; por despliegue |
| `AGENDIA_RUN_MESSAGE_WORKER`, `AGENDIA_RUN_WHATSAPP_MANAGER` | entrypoints | guardas de ejecución de Node/tsx; D/T/S/P; no secreto; solo ciclo de proceso |

Faltan un esquema único de validación de producción, archivos de ejemplo seguros, fuente/inyección de secretos, distinción de roles login y rotación. `EnvironmentKms.fromEnv` solo carga la KEK actual, aunque los registros conservan `kek_version` (`packages/whatsapp-baileys/src/auth-store.ts`): una rotación que retire la clave vieja antes de reenvolver/verificar sesiones las hará ilegibles.

## HTTP, origen y futuro ingreso

El navegador llama siempre a `/api` (`apps/web/src/api-client.ts`) y `apps/web/next.config.ts` lo reescribe a `AGENDIA_API_ORIGIN`. La API compara exactamente el header `Origin` con `APP_ORIGIN` para login y mutaciones (`apps/api/src/app.ts`); no hay CORS. El patrón de despliegue más seguro es un único origen HTTPS externo: ingreso/túnel → web y proxy interno de `/api` → API loopback/red privada. Así el navegador mantiene same-origin y la API ve el origen externo canónico.

La cookie `__Host-agendia_session` se crea en `@agendia/auth` y logout la limpia con `secure`, `httpOnly`, `sameSite:lax`, `path=/` (`apps/api/src/app.ts`); el prefijo `__Host-` impide Domain y exige HTTPS en navegadores. Un proxy/túnel debe preservar o definir correctamente `Origin` y no publicar API:3001, PostgreSQL:5432, manager o worker. `scripts/start-api.ts` fuerza loopback, mientras `startApi` por sí solo predetermina `0.0.0.0`: el empaquetado debe hacer explícito el bind de producción. Staging debe no tener ruta pública; su acceso de validación ha de ser privado/autenticado y temporal.

## PostgreSQL, cola, estado y continuidad

La migración `0000_base.sql` crea roles NOLOGIN sin privilegios; `0012_runtime_repositories_grants.sql` crea `pgboss` y da `USAGE, CREATE` solo a `agendia_worker_runtime`. `createRuntimePools` compone cuatro pools por rol desde API (`apps/api/src/index.ts`), de modo que producción requiere credenciales login separadas y migración con DDL role; no basta la URL de Compose de desarrollo. `scripts/db-migrate.ts` ordena y aplica SQL, pero no registra versión ni lock global, preflight/backup, compatibilidad de release ni rollback. `db:check` prueba migraciones limpias y fingerprint, no una migración de producción.

pg-boss comparte PostgreSQL/esquema `pgboss`; manager crea `ai-generate`, worker crea `ai-generate` y `conversation-summary`. El worker registra un handler por cola sin opción explícita de concurrencia (`apps/message-worker/src/index.ts`), por lo que capacidad, `work()` default y límites de conexiones deben medirse/decidirse antes de usuarios reales. El outbox AI usa `FOR UPDATE SKIP LOCKED`, reclamación con token y reintento hasta 60 s (`0018_outbox_dispatch.sql`), útil ante reinicio pero no sustituye monitorización de atraso/fallos.

El manager usa un advisory lock por conexión, `owner_id` y heartbeat de 15 s (`PostgresWhatsAppManager` en `apps/whatsapp-manager/src/lifecycle.ts`); al parar cierra leases, borra propietario/heartbeat y libera lock. Al arrancar restaura conexiones activas y limita reconexión a mínimo 15 s (`apps/whatsapp-manager/src/index.ts`). Esto justifica una sola réplica manager por entorno en el host actual. El proceso API cierra Fastify y pools en SIGINT/SIGTERM; worker detiene boss y pools; manager limpia timer, boss, leases y pools. No hay timeout de apagado común, supervisor, política de restart, orden declarada ni readiness persistente.

Los estados Baileys se guardan cifrados: DEK por conexión envuelta con KEK, AES-256-GCM y AAD; QR también AES-GCM con clave distinta (`packages/whatsapp-baileys/src/auth-store.ts`, `packages/db/src/repositories.ts`). Backups deben incluir PostgreSQL **y** todas las KEK históricas/clave QR necesarias, almacenadas por separado y cifradas. El drill actual valida dump/restauración de datos y ciphertext, pero usa contenedores efímeros y datos sintéticos: no hace backup diario, externo, cifrado ni restauración de la pila real.

## Host confirmado y límites de coexistencia

Hechos aportados: PC dedicado 24/7 con Ubuntu Server 26.04.1 LTS x86_64, Celeron N4020 (2 CPU), 7.1 GiB RAM y 4 GiB swap; SSD 447 GiB, PV LVM 444 GiB pero LV raíz 100 GiB; Wi-Fi `wlo2` con 192.168.18.11/24; SSH activo; Docker ausente. Los WAN distintos indican CGNAT/doble NAT: no se debe diseñar sobre forwarding entrante. No habrá UPS inicialmente y se aceptan varias horas de caída. Todo disco podría dedicarse al servicio, pero ampliar root/LVM, cifrado, SMART y capacidad efectiva son hechos que el runbook debe verificar antes de datos reales.

Producción normal debe reservar la mayor parte de CPU/RAM/IOPS. Staging solo puede ejecutarse por ventana, tras medir memoria de la pila productiva y con cuotas/límites explícitos; nunca durante picos, migraciones sensibles, restore, mantenimiento ni backlog. Con 2 CPU/8 GiB de clase baja, no se recomienda coexistencia continua ni ejecutar simultáneamente suites Testcontainers, build pesado, backup/restauración y ambas pilas. Swap evita terminación inmediata, no es capacidad de PostgreSQL ni de IA. Wi-Fi y energía doméstica son riesgos aceptados, no propiedades que el repositorio pueda resolver.

## Superficies faltantes y alcance propuesto

**Cambios implementables por este SDD:** empaquetado reproducible de los cuatro procesos; imagen única por commit con dependencias bloqueadas; Compose/definición de producción y staging parametrizada; entradas separadas sin `tsx`/`next dev`; validación tipada y fail-fast de configuración; health/liveness/readiness sin secretos; logs estructurados y rotación/documentación de correlación; límites de recursos/restarts/dependencias; automatización de backup cifrado, verificación y drill operable; pipeline que pruebe, construya, etiquete/digeste y promueva exactamente la misma imagen; runbooks y pruebas de despliegue/recuperación.

**Provisionamiento único, documentado en runbook (no producto):** crear usuario y directorios propietarios, instalar Docker/Compose y dependencias de backup, configurar firewall/SSH/actualizaciones, ampliar/decidir LV y cifrado de disco, almacenamiento de secretos, servicio supervisor, límites de host/logs, reloj/DNS, y medir recursos. Comandos concretos deben depender de la decisión de motor de contenedores, backup y túnel; no se deben ejecutar desde esta exploración.

**Prerrequisitos/gates externos:** destino de backup externo cifrado y credenciales antes de usuarios reales; prueba de restauración en destino; dominio y proveedor/mecanismo de túnel saliente; cuenta/control DNS; política de acceso administrativo; aceptación explícita de Baileys/WhatsApp y DeepSeek; conectividad Wi-Fi estable y evaluación de riesgo eléctrico sin UPS. La publicación debe asumir túnel saliente, no inbound forwarding.

**No objetivos/riesgo aceptado:** no alta disponibilidad, no eliminar SPOF de PC/ISP/Wi-Fi/energía, no exponer PostgreSQL, no garantizar disponibilidad de WhatsApp/DeepSeek, no cambiar flujos de tenants ni crear producto, y no mantener staging siempre encendido. Se acepta downtime de varias horas hasta futura UPS, condicionado a backup externo previo a usuarios reales.

## Invariantes de promoción y recomendación de alcance

La propuesta debe exigir que test construya una imagen por digest y ejecute las suites contra ella; staging despliegue **ese mismo digest** con configuración/secretos de staging; producción promocione el mismo digest ya validado, cambiando solo configuración y secretos. Etiquetas mutables, rebuild por entorno, migraciones automáticas al arranque sin control y copiar árboles de trabajo rompen esta invariante. La migración debe ser un paso único con backup/precheck y compatibilidad explícita antes de levantar la nueva versión; rollback de aplicación no implica rollback SQL.

**Recomendación proposal-ready:** acotar el cambio a una ruta de release de una sola máquina con cuatro entornos definidos, imagen única, test CI-portable, staging efímero privado, producción persistente, configuración/roles/volúmenes separados, health/logging/restart y backup-drill como gates. Posponer HA, observabilidad externa completa y selección del proveedor de túnel, pero no posponer el backup externo ni la decisión de publicación antes de usuarios.

## Decisiones genuinamente pendientes antes de diseño

1. Elegir proveedor y modelo de túnel saliente, dominio, DNS y acceso privado temporal de staging.
2. Elegir destino externo, cifrado, retención, RPO/RTO y responsable del backup/restauración, incluyendo custodia de KEK históricas.
3. Decidir motor de imagen/Compose, gestor de servicios y si la imagen ejecutará Bun, Node compilado o ambos, tras validar dependencias nativas.
4. Confirmar esquema de logins PostgreSQL por rol, política de migración/rollback y si `AGENDIA_ADMIN_PASSWORD` permanece disponible después del primer bootstrap.
5. Medir consumo y acordar cuotas/ventanas de staging, concurrencia pg-boss, capacidad esperada de negocios/sesiones/mensajes y gatillos para no coexistencia.
6. Confirmar partición/LVM, cifrado de disco, SMART, política de actualizaciones y aceptación documentada de operar sin UPS inicialmente.

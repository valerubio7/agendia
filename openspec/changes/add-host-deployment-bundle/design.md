# Diseño: operación directa SOLO-PILOT desde fuentes fijadas

## Estado y decisión final

Este diseño sustituye las rutas de bundle obligatorio, verificador separado, recibo firmado e instalación/transferencia por checksum. Sigue la propuesta y las tres specs actuales de `add-host-deployment-bundle`; el nombre del cambio permanece por continuidad.

- Slice 1 completada según el usuario: conservar packaging/CI/stub/contratos como artefacto opcional futuro, no autoritativo ni necesario para desplegar. No se revalida aquí su implementación.
- Slice 2 retirada: no continuar ni reemplazar por otro verificador/instalador.
- Slices activas 3–5: tooling de repositorio, configuración/one-shots y bootstrap/runbook. Máximo 400 líneas cambiadas por slice; tracker draft/no-merge y cadena existentes conservados, sin nuevas slices ni excepción inferida.
- Solo se modifica este documento. No código, pruebas ejecutadas, instalación, host, Docker, deploy, commit, push, ramas o subagentes.

Skill resolution: `paths-injected`, `gentle-ai/SKILL.md`; instrucciones executor del harness. Propuesta/specs leídas directamente de OpenSpec y código relevante releído. No hay herramientas de ejecución/CodeGraph disponibles: lectura directa acotada como fallback, sin afirmar consultas Git ni mediciones de diff. El alcance explícito es agendia, no packages/coding-agent.

## 1. Camino mínimo y frontera de confianza

PC confiable + operador → verificación manual CI/imagen con gh fijado → SSH autenticado → checkout host limpio del SHA exacto + Bun fijado → CLI cerrado del repositorio → imágenes inmutables Docker/Compose.

El checkout es tooling del operador; web/API/workers y one-shots siguen ejecutándose en la imagen publicada por digest. Prohibidos builds de imágenes en host, aplicaciones desde fuentes, tsx, next dev, puertos host y socket Docker en aplicaciones. El host no necesita gh ni token GitHub persistente.

Confianza SOLO-PILOT humana: comprobar fuentes, runtimes y evidencia real; no alegar attestation independiente del checkout/tooling. El CLI puede comprobar consistencia/ausencia de evidencia, pero no demostrar que un humano realmente ejecutó gh. `verified:true` solo no autoriza nada y no sustituye el procedimiento. No crear otro subsistema criptográfico para ocultar ese límite.

## 2. Preparación posterior de fuentes y runtimes

### Versiones y ubicación

Bun **1.4.0**, igual a packageManager/CI actuales, instalado posteriormente en ruta root-owned fija `/opt/agendia/tools/bun-1.4.0/bin/bun`. gh **2.76.2** en el PC central: versión fijada para calificación del procedimiento, no compatibilidad ya comprobada en esta fase. Si flags/salida de esa versión no cumplen, detener antes de operar y actualizar explícitamente pin y ejemplos; no aceptar cualquier versión disponible. Compose >=2.30.0 por env_file raw, Docker CE/Compose existentes sujetos a comprobación posterior.

Checkout host fijo por SHA: `/opt/agendia/tooling/<40-hex>/`, propiedad root, no escribible por operador/grupo/otros durante operación. No enlace activo de paquete ni instalación por hash de tar. Runtimes/dependencias se preparan una vez, no dentro de apply.

### Cómo obtener el checkout sin paquete host

PC y host usan Git normal contra el repositorio esperado y seleccionan el SHA aprobado con checkout detached. HTTPS anónimo si el repositorio es accesible; si requiere autenticación, usar transporte SSH con clave de repositorio read-only aprovisionada fuera del checkout. Esa credencial y host key requieren preparación operativa explícita, no se presumen presentes; sin token GitHub persistente ni agente reenviado. El CLI nunca clona, hace fetch, cambia revisión ni resuelve una rama.

Preparación en directorio nuevo sin pisar uno existente: obtener objetos, verificar `git rev-parse HEAD` igual al SHA aprobado y `git status --porcelain=v1 --untracked-files=all` vacío. Comprobar remoto esperado y ausencia de sustituciones Git (replace/grafts/alternates no aprobados). PC y host deben mostrar el mismo SHA completo. Ningún git clean/reset automático ni confianza en nombre de rama.

Con Bun fijado, `bun install --frozen-lockfile --ignore-scripts` para dependencias del tooling; no compilar aplicaciones. El CLI previsto usa módulos TS/JS y no necesita ejecutar bootstrap/argon2 en host. Si resolver imports exige scripts nativos u otros pasos, falla la preparación: no quitar ignore-scripts silenciosamente. Instalar dependencias sin privilegios en preparación controlada y pasar árbol terminado a propiedad root antes de sudo. No ejecutar lifecycle scripts como root. Validar que lockfile/package.json no cambiaron, conservar versión Bun y hash de lockfile en evidencia de preparación root-only fuera del checkout.

Un Git limpio no autentifica node_modules ignorado: éste procede de instalación congelada recién preparada, queda root-owned/no escribible y no se reutiliza desde un checkout de desarrollo. Rechazar `.env`, bunfig/preloads u otros archivos ignorados locales que alteren ejecución; variables de entorno de Bun/Node y carga dotenv se deshabilitan en invocación. No introducir un scanner/verificador de dependencias separado.

### Preflight anterior a ejecutar tooling

Runbook exige comprobar con herramientas del sistema el SHA/limpieza/propiedad y `bun --version` antes de invocar cualquier TS; un programa modificado no puede establecer su propia confianza inicial. Luego el CLI repite las comprobaciones de deriva antes de cargar el adaptador o invocar Docker. Todas las fuentes, dependencias y ancestros usados bajo sudo deben ser root-owned no escribibles, con exclusión operativa de cambios concurrentes. El riesgo de root/operador comprometido queda fuera de esa garantía.

## 3. Verificación manual en PC y evidencia

En checkout PC limpio del SHA seleccionado, operador utiliza gh fijado para:

1. Consultar runs CI/release/autorización por IDs exactos: repositorio, workflow path, evento, intento, completed/success y vínculo de CI al commit aprobado. Descargar artefactos del run exacto, no latest ni coincidencia de nombre en otro run.
2. Verificar imagen OCI por digest mediante `gh attestation verify oci://ghcr.io/valerubio7/agendia@sha256:<digest> --repo valerubio7/agendia --signer-workflow valerubio7/agendia/.github/workflows/release.yml`, con predicate-type explícito para provenance SLSA y SBOM SPDX y salida JSON soportada. Cotejar sujeto, digest, identidad firmante, workflow/invocation y material fuente.
3. Distinguir commit del workflow firmante de SHA del checkout disparado por workflow_run. No asumir que release-run head_sha es el commit de imagen. CI SHA, manifest, provenance/material fuente y release evidence deben justificar el mismo commit/digest. Cualquier relación ausente detiene la operación.
4. Relacionar release manifest/evidence, SBOM descargado y su attestation, checks CI y autorización existente; producción exige digest validado en staging y autorización propia. No inventar una attestation para artifacts que no la tienen: su origen se verifica por descarga API del run autenticado.

El runbook fija comandos concretos y campos a inspeccionar para esa versión; no crear `verifyHostRelease` ni un runner gh nuevo. Tests documentales verifican presencia del procedimiento, no prueban que la verificación humana ocurrió.

Conservar por entorno archivos root-only de manifest, release evidence, autorización, salida de verificación redactada y nota del operador: repo, CI/release/auth runs e intentos, commit, digest, resultado/fecha, versión gh. Transferir únicamente configuración/evidencia requerida mediante SCP/SSH con `StrictHostKeyChecking=yes`, known_hosts previamente verificado y sin agent forwarding. Cambio de host key = STOP; ssh-keyscan no es validación autónoma. Secretos se preparan por procedimiento separado, no se meten en esa nota ni checkout.

El contrato interno existente de `planDeployment` requiere proof/SBOM/provenance normalizados. La nota manual y archivos originales sustentan esos campos y sus relaciones, no un nuevo formato de autoridad firmado. CLI comprueba presencia, root ownership y consistencia de inputs con selección explícita; si faltan adjuntos/contexto, no acepta un proof que solo diga verified. Los booleanos históricos son representación de una comprobación manual, no prueba criptográfica host.

## 4. CLI directo y adaptador tipado

### Entrada y símbolos

Reutilizar **`scripts/deployctl.ts`** como entrada: añadir `main` guardado con `import.meta.main` y `parseHostCommand`. Imports de biblioteca siguen sin efectos. Cargar `scripts/host-deployment-runtime.ts` solo después de parse/preflight. No modificar `scripts/deployctl-cli.ts`: permanece stub del bundle opcional Slice 1, evitando convertir ese artefacto en autoridad accidental.

Interfaz prevista: `bun --no-env-file scripts/deployctl.ts <plan|apply|bootstrap|status|smoke|rollback> <staging|production> --commit <40-hex> --digest sha256:<64-hex>`. Verificar soporte de `--no-env-file` con Bun fijado antes de habilitarla; si falta, detener preparación, no permitir carga dotenv implícita. No rutas libres ni flags passthrough. El operador entra al directorio fijo derivado de commit mediante SSH y ejecuta Bun absoluto con sudo y entorno limpio. No comando de shell recibido por CLI.

Nuevo módulo único **`scripts/host-deployment-runtime.ts`**: `assertSourcePreflight`, `createHostRuntime`, `runOperation`, `runOrderedDeployment`. Root temporal, runner, filesystem y reloj inyectables en tests, nunca `--root` operativo. Reutilizar `planDeployment`, seals, `applyDeployment`, `rollbackDeployment`, `createFilesystemDeploymentAdapter` y `renderCompose`; el renderer conserva su lectura relativa al checkout, sin template injection propio del bundle.

### Runner

Unión cerrada de operaciones; implementación spawn con argv, shell false, `/usr/bin/docker` fijo, timeout y salida acotada. Git de preflight solo rev-parse/status y comprobaciones fijas; no fetch/checkout/build/push. Entorno mínimo; no heredar DOCKER_HOST/CONTEXT, COMPOSE_FILE/PROFILES, NODE_OPTIONS, Bun preload ni opciones shell. DOCKER_CONFIG fijo `/etc/agendia/registry`, credencial GHCR pull-only externa. Docker/Compose plugin no escribibles por operador; nadie al grupo docker.

Operaciones Docker permitidas: pull por digest; inspect y validar RepoDigests/Os/Architecture linux/amd64; Compose con proyecto fijo agendia-prod|agendia-stg y archivo renderizado interno; up postgres con no-build/pull-never/wait; run --rm --no-deps -T one-shot declarado; up apps fijas con no-build/pull-never/wait; ps/inspect y exec de probes constantes. No puertos publicados, red host, socket en contenedores, shell libre, down/prune/volume deletion. Los healthchecks shell existentes son constantes revisadas, no input libre.

## 5. Paths, atomicidad y rollback

Paths fijos:

- `/etc/agendia/<env>/config/<process>.env` y `/etc/agendia/<env>/secrets/<archivo>`.
- `/srv/agendia/<env>/postgres` para datos existentes.
- `/srv/agendia/<env>/release/{state.json,compose.yml,inputs/,evidence/}`; state/inputs/evidence root-only, archivos 0600.
- `/run/agendia/<env>/bootstrap/admin-password` para secreto temporal, fuera del checkout.

Preservar state schema 1 `{current,previous}` y snapshot/Compose hashes. Lock de operación por entorno mediante flock en directorio root-owned (más gate de exclusión staging/mantenimiento existente). No nonce/replay journal. Evidencia de fase started/pass/fail permite identificar operaciones incompletas sin automatizar reintentos. Temp exclusivo + fsync + rename + sync padre para state/Compose; state confirmado se publica después de convergencia/checks.

Corregir `applyDeployment`: su código actual escribe state antes de converge y reconverge anterior incondicionalmente en catch. No publicar éxito antes de checks; después de migración incompatible o bootstrap fallido, conservar snapshot confirmado y evidencia incompleta, detener sin autoiniciar apps. Restituir archivos no revierte SQL ni contenedores. Reinicio con evidencia started sin final exige reconciliación explícita; Compose y state no constituyen transacción multiarchivo. Fallo de durabilidad después de rename se comunica como indeterminado, no como rollback confirmado.

`rollbackDeployment` sigue exigiendo expand-compatible, previousDigest, snapshot/entorno/hashes congruentes. Añadir evidencia/aprobación de incidente, no reinterpretar autorización apply. Adaptador modo rollback ejecuta exclusivamente pull/inspect/converge/probes de Compose histórico; nunca roles/migrate/queue/admin. Config externa debe ser compatible con snapshot previo; si no, detener. Sin SQL rollback ni restore implícito.

Para rollback usar checkout limpio del commit de la release actual cuyo plan autoriza revisar current/previous; el digest rollback seleccionado y ambos snapshots se registran explícitamente. No exigir equivocadamente que ese tooling cambie al commit destino antes de validar estado actual. Una revisión distinta de tooling requiere selección y compatibilidad state explícitas, nunca cambio ciego de fuentes.

## 6. Configuración y orden operativo

`renderCompose` + `deploy/compose.yml` conservan proyectos, redes internas, imágenes fijadas y recursos existentes. Añadir env_file por proceso `required:true, format:raw`; environment renderizado fija AGENDIA_PROCESS, AGENDIA_ENVIRONMENT y releaseDigest. Archivos solo con configuración no secreta y rutas `_FILE`; no DATABASE_URL normal, source ni dotenv interpolation. No persistir salida completa de compose config.

Mounts de secretos individuales, no directorio global compartido; normales root:10001 0440 con padres transitables apropiados, config legible por UID10001. Cada proceso recibe solo sus archivos. Web conserva WEB_DATABASE_URL_FILE requerido por su contrato y no gana red data. APP_ORIGIN HTTPS distinto de AGENDIA_API_ORIGIN interno.

Validación host estructural de claves/paths/ausencias/cruces antes de iniciar PostgreSQL; `loadRuntimeConfig` y `preflightReleaseEnvironment` vuelven a validar identidad/marker antes de actividad. Validar también rutas de proveedor/WhatsApp necesarias al proceso, no solo DB. El host no imprime valores. One-shots opt-in, restart no, read-only rootfs, caps drop, no-new-privileges, red data y mounts mínimos, logging persistente deshabilitado.

Secuencia `runOrderedDeployment`:

1. Gates/autorización/config válidos; pull/inspect de referencias inmutables; levantar solo PostgreSQL con POSTGRES_DB/USER/PASSWORD_FILE propios; esperar healthy.
2. **roles:** `scripts/provision-roles.ts` → `roleNamesForEnvironment`/`provisionRoles`; CLUSTER_ADMIN_DATABASE_URL_FILE y passwords de roles del entorno. Cuenta administrativa inicial explícita, no atribuir superpoderes al login reducido. Crear schema pgboss si falta antes de alter ownership existente, sin tablas queue.
3. **migrate:** `scripts/migrate.ts` → `runMigrate`/`runGovernedMigrations`, MIGRATE_DATABASE_URL_FILE y manifiesto/evidencia read-only. Preservar backup reciente, lock advisory, checksums, minimumLedger, baseline y maintenance. Nunca `scripts/db-migrate.ts`.
4. **queue:** `scripts/queue-init.ts` → `initializeQueues`, queue-owner, preflight marker completo, sin cluster-admin.
5. **admin:** bootstrap explícito cuando proceda; no solicitud o secreto requerido = apps bloqueadas, no asumir admin existente.
6. **apps:** converger web/API/manager/worker y cloudflared ya configurado; health/readiness/heartbeats y smoke privado.

Cualquier predecessor fallido corta la secuencia. En updates no afirmar que apps anteriores están detenidas si no lo están; contract-maintenance exige evidencia de parada operativa previa y autorización. No añadir nueva acción destructiva para simular ese gate.

### Genesis sin bypass de aislamiento

Problemas existentes a resolver: `runMigrate` exige marker antes de crear schema; migración 0021 crea tabla sin fila; roles supone pgboss existente. Separar validación estática identity/isolation de consulta marker en runtime-config. `provision-roles` se añade a `runtimeProcesses`/dispatcher con validación estática especial de CLUSTER_ADMIN_DATABASE_URL_FILE, no variable ficticia PROVISION_ROLES_DATABASE_URL_FILE ni marker prematuro.

Genesis solo previousDigest cero, sin current state y catálogo sin schema aplicación/ledger. Llevar validación genesis y singleton al mismo lock de `runGovernedMigrations` con hooks internos acotados antes/después; no callback elegible por CLI ni INSERT suelto posterior. Después de migraciones insertar entorno/UUIDs parametrizados sin sobrescribir identidad distinta, luego preflight completo.

Reintento con autorización del mismo digest y ledger íntegro; ledger parcial sigue checksums/progreso gobernados antes de marker. DB preexistente sin marker no recibe excepción automática: recuperación/baseline explícito. No editar SQL histórico, no eximir backup genesis ni fabricar evidencia.

## 7. Admin, evidencia y smoke

`bootstrapAdminFromEnvironment` conserva development/test, pero staging/production usa `loadRuntimeConfig("bootstrap-admin")`, BOOTSTRAP_ADMIN_DATABASE_URL_FILE, preflight marker y contraseña solo de archivo. Reutilizar `validateAdminInput`, `provisionAdmin`, `PostgresAdminStore` y su lock transaccional; rol migrator para este one-shot, sin ampliar privilegios API. Rechazar AGENDIA_ADMIN_PASSWORD/DATABASE_URL inline en release.

Archivo fijo `/run/agendia/<env>/bootstrap/admin-password`: demostrar tmpfs por statfs/mountinfo, no solo prefijo; parent root0700, regular root0600/no-follow/nlink1. Bootstrap contenedor UID0 solo para leer bind root-only, sin capabilities, data-only/read-only. Host mantiene lock e inode comprobado para unlink, nunca hace legible el archivo al UID normal.

`created` o `existing` misma identidad después del commit permite unlink; existing no sustituye password, admin distinto falla. Crash tras commit admite reintento idempotente. Error de transacción conserva tmpfs para reintentar; tras reboot operador recrea secreto. Fallo unlink bloquea apps hasta limpieza segura. Ningún secreto en argv/env/checkouts/logs/state ni copia persistente; evidencia bootstrap solo resultado/fecha.

Evidencia general DTO cerrado: schemaVersion, entorno, toolingCommit, bunVersion, releaseDigest, fase/resultado/fecha/código y referencias no secretas a autorización/evidencia. `redactOperationsValue` y `serializeOperationalLog` segunda defensa; nunca serializar Error/raw stdout/env/URLs/email/tenant data. Capturar salida one-shot acotada y parsear exclusivamente resultado esperado.

Health usa checks existentes. Smoke por exec argv fijo a endpoints loopback web/API; sin host ports. Workers deben demostrar heartbeat fresco <= `HEARTBEAT_STALE_MS` (60s), no running como sustituto. Falta de comprobación = pending/fail. Rollback registra image-compose-only, sqlRollback false y externalRestore false.

## 8. Archivos exactos y slices activas

| Slice | Archivos/símbolos a modificar o crear | Forecast manual |
| --- | --- | --- |
| 3 runtime | `scripts/deployctl.ts`: parseHostCommand/main, applyDeployment/rollbackDeployment/createFilesystemDeploymentAdapter; nuevo `scripts/host-deployment-runtime.ts`: assertSourcePreflight/createHostRuntime/runOperation; `tests/contracts/deployctl.contract.test.ts`, nuevo `tests/contracts/host-runner.contract.test.ts`; nota breve en `docs/runbooks/deploy.md` para invocación/preflight | 350–410: código 225–260, tests 105–125, docs 20–25 |
| 4 config/genesis | `deploy/compose.yml`, `deploy/config/release.example.env`, `Dockerfile`, `deploy/entrypoint`; `scripts/render-compose.ts`, `scripts/release-entrypoint-config.ts`, `scripts/provision-roles.ts`, `scripts/queue-init.ts`, `scripts/migrate.ts`, `scripts/support/database-role-provisioning.ts`, `scripts/support/postgres-migrations.ts`, `packages/runtime-config/src/index.ts`; host runtime runOrderedDeployment; tests config/genesis y regresiones existentes | 380–500: código/config 255–335, tests 115–150, notas 10–15 |
| 5 admin/lifecycle | `scripts/bootstrap-admin.ts`, host runtime, Dockerfile/entrypoint/Compose para bootstrap; `scripts/bootstrap-admin.test.ts`, nuevos `tests/contracts/host-bootstrap.contract.test.ts` y `tests/contracts/host-deployment.integration.contract.test.ts`; runbooks deploy/rollback/host-provisioning/backup-restore y `tests/contracts/runbooks.contract.test.ts` | 350–440: código 90–115, tests 150–185, docs 110–140 |

Tests adicionales exactos de Slice 4: `tests/contracts/host-config-genesis.contract.test.ts` nuevo, `tests/contracts/compose-isolation.contract.test.ts`, `tests/unit/runtime-config.unit.test.ts`, `tests/integration/governed-migrations.integration.test.ts`. Cambiar solo regresiones necesarias, no rehacer fixtures/suites completas. Sin cambios previstos a migraciones SQL históricas, release-manifest o promotion-authorization.

Total activo estimado 1.080–1.350 adiciones+eliminaciones, más artefactos de planificación imputables. Estos rangos no son mediciones ni presupuestos autorizados: límites superiores exceden 400, especialmente Slice 4. **No hay cabida demostrada en tres slices de 400; apply queda bloqueado bajo ask-on-risk hasta desglose/medición o decisión humana.** Tasks puede concretar reuse y reducir cambios mecánicos, pero no minificar, ocultar tests/docs, trasladar todo testing a Slice 5, inventar nueva slice o reutilizar excepción histórica. Objetivo por slice sigue <=400, no el extremo superior de esta tabla.

### Disposición de archivos descartados y artefactos

Fuera de toda arquitectura/dependencia activa: `scripts/verify-host-handoff.ts`, `scripts/install-host-bundle.py`, `tests/contracts/host-handoff-install.contract.test.ts` del intento fallido; tampoco crear `scripts/verify-host-release.ts`, `scripts/install-host-bundle.sh` ni `tests/contracts/host-install.contract.test.ts` propuestos anteriormente. No importarlos desde CLI, no ejecutarlos en runbook, no contar sus tests como evidencia del flujo directo.

Esta revisión NO borra esos archivos ni reescribe ramas. Parent/tasks debe marcar Slice 2 retirada (no completada), conservar su FAIL histórico y actualizar dependencias para no exigir instalador ni bundle. Si archivos fallidos siguen en la rama/candidato, su eliminación o exclusión necesita saneamiento explícito posterior: la evidencia previa registra >=943 líneas y no cabe ocultarla en una slice de 400. Medir ese diff y pedir decisión; no asumir que el cambio de diseño ya saneó código. Conservar Slice 1 y sus tests byte a byte donde sea posible.

## 9. Pruebas, rollout y gates

TDD por slice con RED/GREEN/TRIANGULATE/REFACTOR, pruebas propias y fallos observables:

- Slice 3: SHA distinto/árbol sucio/Bun incorrecto/inputs ausentes bloquean antes de Docker; node_modules/paths no confiables; grammar/argv/env poisoning; digest/amd64; locks y fallo state/Compose; rollback compatible/incompatible, sin SQL ni one-shots. Git/runner falsos y raíces temporales, no checkouts/host reales.
- Slice 4: env ausente/cruzado y mounts mínimos, orden hasta queue y bloqueo de admin pendiente; fallo en cada predecessor; pgboss ausente, genesis/ledger parcial/marker distinto, no backup bypass. DB real únicamente en CI autorizada posterior, no en esta fase.
- Slice 5: secreto tmpfs/mode/owner/link/inode, admin mismo/distinto, fallo commit/unlink/retry y sentinel redactado. Integral directo preflight→staging→producción mismo digest→fallo→rollback, sin bundle ni instalador. Contratos runbook exigen pasos manuales/versiones/SSH y gates, sin afirmar verificación humana ejecutada.

Validación posterior prevista: Bun tests enfocados, lint, typecheck, contratos; build/suites integración/aislamiento/e2e en CI permitida. No comandos ejecutados ahora ni evidencia host real. Calificación del pin gh, flags Bun y arranque Docker readonly siguen pendientes de comprobación.

Rollout futuro, solo con autorización: preparar runtimes/checkout y dependencias → verificar manualmente CI/imagen en PC → SSH autenticado y evidencia/config aisladas → preflight host → bootstrap staging → checks → autorización producción mismo digest → apply/bootstrap correspondiente. Registrar tooling commit/Bun por operación. No editar tooling mientras se opera; nueva versión usa otro checkout limpio compatible.

State/release/auth schemas existentes se mantienen; sin nuevo protocolo de handoff, tar/hash install, symlink de paquete, nonce journal ni rollback de binario instalado. Backup timer dirigido a ejecutable ausente permanece deshabilitado; no proveedor/enlace ficticio. Usuarios reales bloqueados por túnel/dominio/DNS, backup externo con restore probado y secretos/identidades separados. Wi-Fi/sin UPS aceptado no elimina esos gates. Ningún test simulado ni bundle opcional demuestra preparación de producción.

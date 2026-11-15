[agendIA](../README.md) / [Documentación](README.md) / Operaciones

# Operaciones

**Desplegá una revisión conocida, comprobá sus fronteras y recuperá sin sobrescribir evidencia.** agendIA usa cuatro procesos y PostgreSQL externo; un servicio temporal aplica las migraciones. Dokploy construye desde el repositorio: un release no despliega por sí solo.

[Desplegar](#puesta-en-marcha) · [Actualizar](#release) · [Diagnosticar](#runbook) · [Recuperar](#backups) · [Bajas](#baja-de-negocios)

Esta guía describe lo implementado en **este árbol**, no certifica un servidor. Los ejemplos suponen ejecución desde la raíz, acceso operativo autorizado y secretos ya inyectados por un canal privado. No pegues credenciales en comandos, tickets o capturas. Para trabajar sin producción, usá [Desarrollo](DEVELOPMENT.md).

## Topología

[`compose.production.yml`](../compose.production.yml) define las conexiones y dependencias; los [cuatro procesos](ARCHITECTURE.md#componentes) explican las responsabilidades.

| Servicio | Construcción | Red y acceso a datos |
| --- | --- | --- |
| `agendia-db-migrate` | [`Dockerfile.api`](../Dockerfile.api), target `db-setup` | `dokploy`; recibe `MIGRATOR_DATABASE_URL` como `DATABASE_URL`. Termina al aplicar/verificar el historial. |
| `agendia-api-runtime` | `Dockerfile.api`, target final `api` | `app` + `dokploy`; alias `agendia-api`. Recibe `API_DATABASE_URL` como `DATABASE_URL` y además `ADMIN_DATABASE_URL`. |
| `agendia-web` | [`Dockerfile.web`](../Dockerfile.web) | `app` + `dokploy`; proxy construido con `AGENDIA_API_ORIGIN=http://agendia-api:3001`. |
| `agendia-message-worker` | [`Dockerfile.workers`](../Dockerfile.workers), target `message-worker` | `dokploy`; `WORKER_DATABASE_URL`. |
| `agendia-whatsapp-manager` | `Dockerfile.workers`, target `whatsapp-manager` | `dokploy`; `MANAGER_DATABASE_URL` para conexiones y `WORKER_DATABASE_URL` para pg-boss. |

`app` es interna; `dokploy` referencia la red externa **`dokploy-network`**, que debe existir. PostgreSQL se provisiona aparte y su hostname privado debe resolverse desde los contenedores. Compose no lo crea ni publica puertos HTTP al host: configurá en Dokploy el dominio HTTPS hacia la web en **3000**. La API escucha en **3001** dentro de la red; no necesita exposición pública directa.

API y workers esperan a `agendia-db-migrate` con `service_completed_successfully`. **La web no espera** a la API: verla arrancar no acredita un despliegue sano. El servicio de migraciones no se reinicia automáticamente; los cuatro runtimes usan `unless-stopped`.

## Puesta en marcha

### 1 · Preparar infraestructura y configuración

- Disponé de Docker/Compose en el destino y PostgreSQL compatible con el esquema (local y tests usan **16**). El login migrador debe poder crear roles, extensión `btree_gist`, esquema y funciones, y otorgarse la membresía privada requerida por [0007](../packages/db/migrations/0007_private_business_purge.sql). Probá estos permisos con el rol migrador real en una base descartable antes de desplegar.
- Prepará `dokploy-network`, alcance de PostgreSQL y dominio/TLS. `APP_ORIGIN` debe ser el origen público exacto, por ejemplo `https://agenda.example.test`, sin barra final; es una frontera de login/CSRF, no la URL interna de la API.
- Cargá **todas** las variables obligatorias de [Compose](../compose.production.yml) en Dokploy, incluso al ejecutar solo el migrador: Compose valida la interpolación del archivo. Usá [`.env.example`](../.env.example) como referencia de nombres, no como configuración productiva lista para usar. Consultá [Secretos](#secretos) antes de generar claves.
- En una base existente, exigí una copia con restauración comprobada y un plan de aislamiento antes de migrar. Una base nueva debe estar vacía; el migrador rechaza un esquema inicializado sin historial válido.

### 2 · Inicializar una base nueva

Solo para la primera instalación, ejecutá el servicio de migración con la configuración del destino ya preparada:

```bash
docker compose -f compose.production.yml run --rm agendia-db-migrate
```

Debe terminar con código **0** y `Pending database migrations applied.`. Esto crea el esquema y los roles de capacidad, **no** los logins de conexión. Si falla, no arranques los runtimes ni intentes saltarte el historial.

Para provisionar los logins necesitás Bun 1.4.0 y las dependencias instaladas en un entorno de administración con acceso a esa base. Inyectá allí `DATABASE_URL` del migrador y `API_DB_PASSWORD`, `ADMIN_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `MANAGER_DB_PASSWORD`; luego:

```bash
bun --no-env-file scripts/db/provision-production-db.ts
```

El [script](../scripts/db/provision-production-db.ts) crea/configura `agendia_api`, `agendia_admin`, `agendia_worker` y `agendia_manager`; este último hereda capacidades de manager y worker. Debe imprimir `Production database setup completed`. También reasigna contraseñas y membresías si los logins existen: no lo repitas como paso rutinario de actualización. No entrega el rol privado de purga a la aplicación.

### 3 · Desplegar y habilitar acceso

Desplegá la revisión elegida en Dokploy con el Compose de producción. Las URLs runtime deben usar los logins anteriores, **nunca** el maestro ni el migrador. El migrador recibe su URL solo durante el setup. Next necesita el destino de API al **build**; cambiar únicamente el entorno de la web ya construida no reconstruye el rewrite.

Creá el administrador con el [bootstrap](../scripts/db/bootstrap-admin.ts) desde el entorno de administración: inyectá `DATABASE_URL` con permisos de lectura/inserción en `auth_identities` (no el login API), `AGENDIA_ADMIN_EMAIL` y `AGENDIA_ADMIN_PASSWORD`:

```bash
bun --no-env-file scripts/db/bootstrap-admin.ts
```

La contraseña exige al menos 16 caracteres y no comenzar con `password`, `contraseña` o `123456`, sin distinguir mayúsculas. El resultado esperado es `admin.bootstrap` con `created` o `existing`; repetir el mismo correo no restablece la contraseña y otro administrador existente provoca fallo.

### 4 · Comprobar el resultado observable

Si operás por CLI en el mismo contexto de Compose, estas consultas no modifican datos:

```bash
docker compose -f compose.production.yml ps -a
docker compose -f compose.production.yml logs --tail=80 agendia-db-migrate agendia-api-runtime agendia-message-worker agendia-whatsapp-manager
```

- **Migrador:** salida 0. **Runtimes:** activos, sin bucles de reinicio ni fallos de bootstrap. Revisá también los logs de la web si su build o arranque fallaron.
- **HTTP:** con un cliente disponible dentro de la red `app`, `http://agendia-api:3001/me/business-profile` debe responder **401 / UNAUTHENTICATED** sin sesión. Por el dominio público, `/api/me/business-profile` debe responder lo mismo. Esto prueba llegada y proxy, no salud de base, IA ni canal; no presupongas que el contenedor trae `curl`.
- **Acceso:** comprobá `/admin/login`, una solicitud por `/register`, aprobación y posterior ingreso por `/login` con un negocio de prueba autorizado. No hay alta manual por administración ni verificación de correo.
- **Mensajería:** completá catálogo y horarios, activá el agente y vinculá WhatsApp desde el panel. Esperá **CONNECTED** y ensayá con un número controlado. Observá por separado ingreso, generación, turno guardado y entrega; [no son el mismo éxito](booking-journey.md).

## Secretos

La lista de variables vive en [Compose](../compose.production.yml); los validadores están en [API](../apps/api/src/index.ts), [worker](../apps/message-worker/src/index.ts) y [manager](../apps/whatsapp-manager/src/index.ts). No mantengas un segundo inventario de valores en la documentación.

- `WHATSAPP_LINK_CODE_KEY` debe coincidir en API y manager y decodificar a **32 bytes**. Cifra los códigos temporales de vinculación; la API la valida aunque todavía no haya conexiones.
- `BAILEYS_KMS_VERSION` identifica la clave `BAILEYS_KMS_KEY`, también de **32 bytes en base64**. Esta envuelve las claves de las credenciales Baileys; **no es** la clave de los códigos de vinculación. El KMS por entorno solo carga la versión configurada.
- El worker exige `DEEPSEEK_API_KEY`. Las URLs por capacidad limitan permisos; los procesos no deben recibir credenciales maestras. `--no-env-file` en los ejemplos de administración evita cargar archivos locales implícitos: las variables deben estar exportadas de forma controlada.
- Conservá las claves/versiones necesarias junto con la política de copias, pero en un almacén de secretos separado. Una copia de PostgreSQL sin esas claves no recupera las credenciales cifradas. Cambiarlas sin un procedimiento de re-cifrado probado puede volver ilegibles datos existentes; **no hay rotación operativa automatizada**.

## Release

[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) se activa al publicar un tag `v*`, exige que su versión coincida con [`package.json`](../package.json) y crea un GitHub Release con notas generadas. **No corre las suites, no publica imágenes y no despliega.** La [CI de PR a `main`](DEVELOPMENT.md#ci) es independiente; el operador debe comprobar sus resultados para la revisión elegida.

### Actualizar sin perder el control del esquema

1. Revisá cambios, configuración y [migraciones pendientes](DATABASE.md#migraciones); validá la actualización en un entorno aislado. Conservá la revisión anterior y una copia con restauración comprobada.
2. Evaluá compatibilidad entre versiones. Si cambia de forma incompatible, aislá tráfico y detené todos los escritores afectados, incluidos workers/managers de revisiones antiguas, durante una ventana de mantenimiento.
3. Desplegá la revisión elegida en Dokploy y comprobá que el servicio de migración se ejecute con esa revisión y finalice correctamente antes de habilitar runtimes. No reutilices como prueba un setup exitoso de una revisión anterior.
4. Repetí [las comprobaciones](#4--comprobar-el-resultado-observable) y observá colas/entregas antes de reabrir tráfico.

Compose ordena el arranque nuevo; **no detiene procesos antiguos ya ejecutándose**. Volver a la aplicación anterior no revierte el esquema. No hay migraciones `down` ni rollback automático: si el esquema no es compatible, detené la actualización y evaluá recuperación aislada, no una reversión a ciegas.

## Runbook

**Primero delimitá el fallo:** revisión, servicio, hora, alcance (un negocio o todos) y último cambio. Conservá diagnósticos redactados; no pegues mensajes, claves ni códigos. Las tablas se consultan solo con acceso autorizado y alcance acotado, no con el login maestro en el panel.

| Síntoma | Evidencia que lo separa | Siguiente paso seguro |
| --- | --- | --- |
| Contenedor reiniciándose o panel sin API | Estado y logs del proceso, migrador y los dos checks HTTP anteriores. | Corregí configuración/red/build según el componente; no reinicies todo sin identificar la causa. No hay healthcheck de aplicación declarado. |
| Migración rechazada | Logs de setup; archivos y `agendia_production_migrations`. | Verificá revisión e historial antes de reintentar. `Applied migration changed`, `Applied migration is missing from migration files` y `Migration history is required for an initialized database` son rechazos deliberados. No edites el ledger/checksum ni repitas SQL a mano. |
| Login bloqueado o rechazado | Origen exacto, aprobación, estado del negocio y respuesta HTTP. `login_throttle_global` / `login_throttle_accounts` si hay 429. | Esperá la ventana (1 minuto global, 15 por cuenta); la API anuncia `Retry-After: 900`. Un fallo de base también cierra la admisión. No borres contadores ni desactives CSRF. |
| WhatsApp sin conexión | Panel, `whatsapp_connections.state`, logs y `technical_events`. | `LINK_REQUIRED`: vinculá desde el panel. `RECONNECTING`: observá reintentos. `ERROR`: diagnosticá conexión/claves antes de revincular. Reiniciar restaura solo sesiones elegibles; no reemplaza una vinculación requerida. |
| Entrada sin respuesta de IA | `agent_configs.active`, `operational_controls.automation_disabled`, `messages.processing_state`, `technical_events`. | Revisá activación del agente y logs del worker/proveedor. El control global existe en base, pero no hay ruta HTTP para cambiarlo; no improvises un interruptor SQL. |
| Trabajo pendiente | Outbox de tópico `ai.generate`, `published_at`, `next_attempt_at`, vencimiento del reclamo y jobs `pgboss`; manager y worker. | Respetá la espera de respuesta configurada (por defecto 600 s iniciales y 90 s en conversación activa). El manager publica el outbox; el worker consume. No todo tópico de outbox tiene ese consumidor. No borres filas ni fuerces estados/reclamos. |
| Envío incierto | `outbound_commands.state = 'delivery_unknown'`, evidencia del proveedor y turno guardado. | No reenvíes a ciegas: pudo entregarse. Comprobá WhatsApp antes de decidir; un fallo de envío no revierte un turno confirmado. No hay reenvío manual general documentado. |
| Negocio suspendido o eliminado | Estado visible en administración; marca `businesses.deleted_at` cuando corresponda. | Suspendido: reactivar desde administración si procede. Eliminado: no hay reactivación ni deshacer; seguí [las salvaguardas de baja](#baja-de-negocios). |

Los mensajes de bootstrap ocultan detalles sensibles, y la API no tiene access logging HTTP habilitado. Ausencia de logs no prueba ausencia de actividad; auditoría, diagnósticos y estado durable cumplen papeles distintos. Consultá el [diccionario](database/tables.md) para interpretar cada tabla.

## Backups

**No hay scripts ni automatización de backup/restore en este repositorio.** La copia y su retención dependen del proveedor de PostgreSQL o de la infraestructura operada; esta guía no promete un procedimiento ejecutable de restauración.

Antes de una migración incompatible, baja o cualquier operación irreversible, exigí:

1. **Copia identificada y restauración comprobada**, con punto de recuperación, alcance y pérdida de datos aceptable explícitos. Que un dump exista o termine sin error no basta.
2. **Destino nuevo y aislado**, sin tráfico ni procesos que puedan contactar WhatsApp/DeepSeek. Restaurar credenciales y jobs puede reactivar conexiones o trabajo antiguo si arrancás un manager/worker.
3. **Configuración recuperable:** versión de aplicación e historial de migraciones correspondientes, roles/logins y permisos requeridos, claves de cifrado/versiones y tratamiento del estado de colas. Un dump de datos no sustituye esa configuración.
4. **Validación antes del cambio:** integridad, aislamiento RLS, autenticación, agenda y estado pendiente, sin proveedores reales. Validá primero el historial restaurado; aplicá pendientes solo con compatibilidad revisada. No migres por reflejo una copia que necesitás para volver atrás.

No restaures sobre producción como primer intento. Mantené la instancia original sin sobrescribir, detené escritores durante el corte acordado y habilitá tráfico solo tras validar la candidata. Reconciliá lo ocurrido después de la copia: una restauración puede perder turnos recientes o reintroducir datos eliminados y no deshace mensajes enviados fuera del sistema.

Borrar volúmenes, purgar colas o reemplazar una base son acciones destructivas, no pasos de diagnóstico. Requieren autorización, aislamiento y copia validada; no se incluyen comandos de borrado o restore a ciegas.

## Baja de negocios

**Suspender permite volver; eliminar no.** El camino implementado es el panel de administración y su [ruta protegida](../apps/api/src/routes/administration.ts), no invocar funciones SQL privadas.

| Acción | Efecto y límite |
| --- | --- |
| Suspender / reactivar | Cambia `businesses.status`; la suspensión impide sesión operativa y ruteo del agente, pero conserva datos. No garantiza drenar envíos ya iniciados. |
| Eliminar | Con sesión administrativa vigente, origen y CSRF, `DELETE /admin/businesses/:id` ejecuta la baja transaccional: purga datos activos y sesiones, libera el correo y conserva auditoría e identidad del negocio con `deleted_at` irreversible. Desaparece de la lista administrativa; no hay deshacer. |

Antes de confirmar **Eliminar**, verificá identidad y alcance del negocio, autorización y [copia con recuperación validada](#backups). Aislá el tráfico y detené workers/managers de **todas** las versiones que puedan operar ese negocio; conservá solo el acceso administrativo controlado necesario para la baja. La copia no es un botón de recuperación selectiva: restaurarla requiere un plan aislado y respetar las obligaciones de retención/borrado.

[La migración 0007](../packages/db/migrations/0007_private_business_purge.sql) instala barreras contra escrituras posteriores, pero no elimina jobs ya publicados en `pgboss`, copias previas ni mensajes entregados. Una identidad referenciada por otro negocio puede quedar anonimizada e inactiva. No se garantiza el cierre/drenaje de sockets antiguos ni que toda llamada al proveedor haya comenzado antes de la baja: [la frontera asíncrona está explicada en Arquitectura](ARCHITECTURE.md#baja-de-negocios).

No otorgues el rol privado `agendia_business_purge` a logins runtime, no invoques `purge_business_data_private` manualmente ni intentes quitar la marca de baja.

## Límites conocidos

- Sin backup/restore, rollback de esquema ni rotación de claves automatizados.
- Sin endpoint de salud dedicado ni healthcheck de los servicios de aplicación en Compose de producción. El healthcheck de PostgreSQL local no cubre este despliegue.
- Provisión de PostgreSQL, red, TLS, logins y política de copias a cargo de operación; migración de esquema implementada en el setup de despliegue.
- Sin garantía de entrega exactamente una vez ni borrado de efectos externos; [persistencia y entrega son fronteras distintas](booking-journey.md#06--enviar-la-confirmación).

---

**Volvé → [Desarrollo](DEVELOPMENT.md)** para reproducir con datos ficticios; [Arquitectura](ARCHITECTURE.md) para ubicar el componente responsable. [Volver al mapa](README.md).

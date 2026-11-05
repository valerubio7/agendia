# Operaciones

agendIA corre como cuatro servicios sobre Dokploy y una base PostgreSQL externa. Un servicio adicional ejecuta las migraciones al desplegar. Este documento describe el despliegue, los secretos y la recuperación; no reemplaza una verificación sobre el servidor.

## Topología

| Servicio | Imagen / target | Red | Variables |
| --- | --- | --- | --- |
| `agendia-db-migrate` | `Dockerfile.api` → `db-setup` | `dokploy` | `MIGRATOR_DATABASE_URL` (mapeada a `DATABASE_URL`) |
| `agendia-api-runtime` | `Dockerfile.api` → `api` | `app` + `dokploy` (alias `agendia-api`) | `DATABASE_URL` (rol api), `ADMIN_DATABASE_URL`, `APP_ORIGIN`, `WHATSAPP_LINK_CODE_KEY` |
| `agendia-web` | `Dockerfile.web` | `app` + `dokploy` | Build arg `AGENDIA_API_ORIGIN=http://agendia-api:3001` |
| `agendia-message-worker` | `Dockerfile.workers` → `message-worker` | `dokploy` | `WORKER_DATABASE_URL`, `DEEPSEEK_API_KEY` |
| `agendia-whatsapp-manager` | `Dockerfile.workers` → `whatsapp-manager` | `dokploy` | `MANAGER_DATABASE_URL`, `WORKER_DATABASE_URL`, `BAILEYS_KMS_VERSION`, `BAILEYS_KMS_KEY`, `WHATSAPP_LINK_CODE_KEY` |

`app` es una red interna; `dokploy` es la red externa `dokploy-network`. PostgreSQL se provisiona aparte y debe ser alcanzable desde esa red. Las URLs de las aplicaciones usan los logins de capacidad; nunca el login maestro ni el migrador.

## Puesta en marcha

1. **Preparar PostgreSQL** con un login migrador que pueda crear roles, extensiones y esquema.
2. **Solo para una base nueva**, configurar en el entorno las variables requeridas por `compose.production.yml`, incluida `MIGRATOR_DATABASE_URL`, y ejecutar una vez el servicio de migraciones desde la raíz del repositorio. Esto crea los roles de capacidad necesarios antes de provisionar los logins:

   ```bash
   docker compose -f compose.production.yml run --rm agendia-db-migrate
   ```

   No hace falta repetir este paso en cada despliegue: Compose ejecuta las migraciones automáticamente al desplegar.
3. **Crear los logins de capacidad** con `scripts/db/provision-production-db.ts`:

   ```bash
   DATABASE_URL=postgres://migrador:... \
   API_DB_PASSWORD=... ADMIN_DB_PASSWORD=... \
   WORKER_DB_PASSWORD=... MANAGER_DB_PASSWORD=... \
   bun scripts/db/provision-production-db.ts
   ```

   Crea `agendia_api`, `agendia_admin`, `agendia_worker` y `agendia_manager`; el manager hereda también el rol de worker para pg-boss.

4. **Configurar las variables** en Dokploy, incluida `MIGRATOR_DATABASE_URL` con el login migrador, y desplegar `compose.production.yml` desde la raíz del repositorio. Compose ejecuta `agendia-db-migrate`; la API y los workers esperan a que termine correctamente. Si falla, revisá sus logs antes de volver a desplegar.
5. **Comprobar el despliegue**: verificá que el servicio de migraciones haya terminado correctamente y que la API y los workers hayan arrancado.
6. **Crear el administrador** con `scripts/db/bootstrap-admin.ts`, usando una URL que pueda insertar en `auth_identities` (admin o migrador, no el login api):

   ```bash
   DATABASE_URL=postgres://agendia_admin:... AGENDIA_ADMIN_EMAIL=... AGENDIA_ADMIN_PASSWORD=... \
   bun scripts/db/bootstrap-admin.ts
   ```

7. **Vincular WhatsApp** desde el panel del negocio. El manager restaura las conexiones existentes al arrancar.

## Secretos

- `BAILEYS_KMS_KEY` y `WHATSAPP_LINK_CODE_KEY` deben ser base64 de exactamente 32 bytes. Se validan al arrancar; una clave inválida impide el arranque.
- `API_DATABASE_URL`, `ADMIN_DATABASE_URL`, `WORKER_DATABASE_URL`, `MANAGER_DATABASE_URL` y `MIGRATOR_DATABASE_URL` son variables de Dokploy; el compose las mapea a los nombres que leen los procesos. La URL migradora se entrega solo al servicio de migraciones; protegé el acceso a las variables y al archivo de entorno de Dokploy.
- Cambiar `BAILEYS_KMS_KEY` sin re-cifrar `whatsapp_auth_records` y `whatsapp_link_codes` deja las credenciales ilegibles. No hay rotación automatizada.
- No copies URLs, claves ni códigos de vinculación a logs, tickets o capturas.

## Release

El workflow `.github/workflows/publish.yml` se dispara con un tag `v*`. Verifica que el tag coincida con la versión de `package.json` y crea un GitHub Release con notas generadas.

```bash
# La versión de package.json debe ser X.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```

Dokploy construye las imágenes desde el repositorio; el workflow no publica imágenes en un registry. El despliegue productivo es una decisión humana posterior al release.

Las migraciones deben ser compatibles con la versión anterior mientras esta siga activa: la dependencia de Compose no detiene procesos que ya están ejecutándose. Para cambios incompatibles, planificá una ventana de mantenimiento y un backup verificado. Volver a una versión anterior de la aplicación no revierte el esquema.

## Backups

No hay automatización de backup/restore en el repositorio. La copia depende del proveedor de PostgreSQL o de Dokploy. Para una copia manual:

```bash
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  > "agendia-$(date +%F).dump"
```

Restaurá en una base nueva, aplicá las migraciones y probá el restore antes de considerarlo válido. No restaures sobre la base productiva sin una ventana y un backup previo.

## Runbook

| Síntoma | Qué revisar | Acción |
| --- | --- | --- |
| WhatsApp no responde | `whatsapp_connections.state`; logs del manager. | Si está `LINK_REQUIRED` o `ERROR`, revinculá desde el panel. Si está `RECONNECTING`, esperá el reintento; la conexión se restaura al arrancar el manager. |
| Mensajes encolados | `outbox_events` con `published_at IS NULL`; `next_attempt_at`; jobs de `pgboss`. | Revisá logs del worker y del manager. No borres filas de outbox a mano: el reclamo y el reintento son parte del contrato. |
| El agente no contesta | `agent_configs.active`; `operational_controls.automation_disabled`; `messages.processing_state`. | Activá el agente o el interruptor global y revisá `technical_events`. |
| Envío incierto | `outbound_commands.state = 'delivery_unknown'`; `provider_message_id`. | No reenvíes a ciegas: el mensaje pudo haberse entregado. Verificá el estado en WhatsApp antes de decidir. |
| Login bloqueado | `login_throttle_global`, `login_throttle_accounts`. | Esperá la ventana (1 minuto global, 15 minutos por cuenta); el throttle se limpia solo. |
| Negocio suspendido | `businesses.status`. | La sesión y el ruteo del agente dejan de operar; reactivá el negocio desde administración. |
| Migración rechazada | `agendia_production_migrations`, checksum del archivo. | No edites una migración aplicada. Restaurá el historial correcto o la base desde un backup. |
| Contenedor caído | Logs del servicio; desde la red `app` (por ejemplo, dentro de `agendia-web`): `curl -i http://agendia-api:3001/me/business-profile` (401 sin sesión). | No hay endpoint de salud ni healthcheck declarado; usá logs y el puerto. |

## Límites conocidos

- Sin backup/restore automatizado (issue #121).
- Sin endpoint de salud ni healthcheck en los contenedores.
- Sin rotación automática de claves de cifrado.
- La provisión de PostgreSQL y de los logins de capacidad sigue siendo manual. Las migraciones se ejecutan al desplegar.

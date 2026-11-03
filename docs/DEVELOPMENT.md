# Desarrollo

## Requisitos

- Bun 1.4.0 (`packageManager` del `package.json`).
- Docker, para PostgreSQL local y para los tests de integración/E2E.
- Chromium de Playwright, solo para E2E: `bunx playwright install chromium`.

## Primera puesta en marcha

```bash
bun install
docker compose up -d postgres
cp .env.example .env
bun run db:migrate:dev
bun scripts/db/bootstrap-admin.ts
```

`db:migrate:dev` aplica las migraciones pendientes y verifica los checksums. `bootstrap-admin.ts` crea el único `platform_admin`; la contraseña debe tener al menos 16 caracteres y no empezar con `password`, `contraseña` o `123456`. Si ya existe otro administrador, falla.

## Levantar los servicios

En terminales separadas, desde la raíz:

```bash
# API en http://127.0.0.1:3001
bun apps/api/src/index.ts

# Web en http://127.0.0.1:3000
AGENDIA_API_ORIGIN=http://127.0.0.1:3001 bun run --cwd apps/web dev
```

El panel del negocio queda en `/login` y el de administración en `/admin/login`. Para crear un negocio, registrate en `/register` y aprobá la solicitud desde administración antes de iniciar sesión. No hay verificación de correo ni creación manual por administración; rechazar libera el correo para registrarse de nuevo. La suspensión sigue disponible y la eliminación completa está postergada.

`AGENDIA_API_ORIGIN` va explícito porque Next lee el entorno desde `apps/web` y `--cwd` no carga el `.env` de la raíz. Sin esa variable, el rewrite `/api/*` queda deshabilitado y el panel no llega a la API.

Para los workers, exportá el `.env` de la raíz en la terminal y levantá cada proceso:

```bash
set -a; . ./.env; set +a
bun run --cwd apps/message-worker start
bun run --cwd apps/whatsapp-manager start
```

Los scripts `start` activan `AGENDIA_RUN_MESSAGE_WORKER=1` y `AGENDIA_RUN_WHATSAPP_MANAGER=1`. En local alcanza con `DATABASE_URL`; en producción cada proceso usa su URL de capacidad.

## Variables de entorno

La lista completa y los valores de ejemplo están en [`.env.example`](../.env.example). Las que importan:

| Variable | Quién la lee | Para qué |
| --- | --- | --- |
| `DATABASE_URL` | Migrador, bootstrap y API local. | Conexión base en desarrollo; en producción la API la recibe como URL del rol `api`. |
| `APP_ORIGIN` | API. | Origen permitido para login y CSRF. Debe coincidir con el navegador. |
| `AGENDIA_API_ORIGIN` | Web. | Destino del rewrite `/api/*`. |
| `AGENDIA_ADMIN_EMAIL`, `AGENDIA_ADMIN_PASSWORD` | Bootstrap. | Credenciales iniciales del administrador. |
| `DEEPSEEK_API_KEY` | `message-worker`. | Proveedor del agente. |
| `BAILEYS_KMS_VERSION`, `BAILEYS_KMS_KEY` | `whatsapp-manager`. | Cifrado de credenciales; la clave debe ser base64 de 32 bytes. |
| `WHATSAPP_LINK_CODE_KEY` | API y `whatsapp-manager`. | Cifrado del código de vinculación; también 32 bytes en base64. |
| `API_DATABASE_URL`, `ADMIN_DATABASE_URL`, `WORKER_DATABASE_URL`, `MANAGER_DATABASE_URL` | Contenedores en producción. | URLs de los roles de capacidad. |

Opcionales: `API_HOST`, `API_PORT`, `WHATSAPP_MANAGER_ID`, `WHATSAPP_COMMAND_POLL_MS`, `DEEPSEEK_MODEL`.

## Tests

| Comando | Qué cubre | Requisitos |
| --- | --- | --- |
| `bun run typecheck` | TypeScript de todo el monorepo. | — |
| `bun run test:unit` | Tests colocados en `tests/unit`, `packages`, `apps` y `scripts`. | — |
| `bun run test:integration` | Repositorios y aislamiento RLS contra PostgreSQL real. | Docker. |
| `bun run test:contracts` | Contratos HTTP, de workers y de Baileys. | — |
| `bun run test:e2e` | Sistema completo en Chromium: API, workers, manager, base y Next. | Docker y Chromium. |
| `bun run test` | Las cuatro suites en orden. | Todo lo anterior. |

Los tests de integración y E2E levantan PostgreSQL con Testcontainers. E2E compila Next en un directorio temporal, arranca los servicios en puertos libres y usa un solo worker; un test aislado se corre con `bun run test:e2e tests/e2e/system-happy-path.spec.ts`.

## Migraciones

- `0004_registration.sql` agrega las solicitudes pendientes y el límite de registro; aplicala antes de probar el flujo. Agregá futuras migraciones en `packages/db/migrations/` con el siguiente número.
- No edites una migración ya aplicada: el migrador compara checksums y rechaza el historial cambiado.
- Para reiniciar la base local: `docker compose down -v && docker compose up -d postgres && bun run db:migrate:dev`. `-v` borra el volumen local; no lo uses contra una base con datos que quieras conservar.
- El esquema `pgboss` lo administra la biblioteca de colas; no lo modifiques a mano.

## Depuración

- La API y los workers escriben logs JSON en stderr. Un error de base de datos no imprime credenciales ni SQL.
- No hay endpoint de salud. Para comprobar que la API responde: `curl -i http://127.0.0.1:3001/me/business-profile` (devuelve 401 sin sesión).
- El estado del agente y de la conexión se lee en `whatsapp_connections.state`; los eventos de diagnóstico quedan en `technical_events` y la auditoría en `audit_events`.
- `operational_controls.automation_disabled` corta la automatización sin detener los procesos.
- Si el panel no llama a la API, revisá `AGENDIA_API_ORIGIN` y el rewrite de `apps/web/next.config.ts`.

## CI

`.github/workflows/ci.yml` corre en cada PR a `main`: typecheck, unitarios y contratos; después integración con Docker; al final tres shards de Playwright con Chromium. La publicación por tag está en [OPERATIONS.md](OPERATIONS.md).

# agendIA

## Desarrollo local

Requisitos: Bun 1.4.0, dependencias instaladas (`bun install`) y PostgreSQL local; Docker Compose es necesario si `dev` debe iniciarlo. Creá `$HOME/.config/agendia/dev.env` fuera del repositorio, con asignaciones `CLAVE=valor`; `dev` y `bootstrap:admin` lo cargan explícitamente. No versiones secretos.

El validador de `scripts/dev-stack.ts` requiere `DATABASE_URL` (URL PostgreSQL local), `APP_ORIGIN=http://127.0.0.1:3000`, `AGENDIA_API_ORIGIN=http://127.0.0.1:3001`, `AGENDIA_ADMIN_EMAIL` (correo válido), `AGENDIA_ADMIN_PASSWORD` (mínimo 16 caracteres, sin prefijos débiles), `DEEPSEEK_API_KEY`, `BAILEYS_KMS_VERSION`, `BAILEYS_KMS_KEY` y `WHATSAPP_LINK_CODE_KEY` (cada clave: 32 bytes codificados en base64). No uses valores de producción. Si configurás `API_HOST` o `API_PORT`, deben ser un host local y `3001`; las URLs opcionales `API_DATABASE_URL`, `ADMIN_DATABASE_URL`, `MANAGER_DATABASE_URL` y `WORKER_DATABASE_URL` también deben apuntar a PostgreSQL local. Si Compose inicia PostgreSQL, debe usar el puerto `5432`.

Desde la raíz del repositorio:

| Comando | Uso |
| --- | --- |
| `bun run dev` | Inicia la base si hace falta, prepara una base sin inicializar y levanta los servicios locales. |
| `bun run bootstrap:admin` | Inicializa el administrador usando la configuración externa de desarrollo. |
| `bun run db:validate` | Comprueba que existe el SQL base revisado; no genera migraciones ni comprueba drift del esquema. |
| `bun run typecheck` | Comprueba tipos sin emitir archivos. |
| `bun run test:unit` | Ejecuta tests unitarios y de scripts. |
| `bun run test:integration` | Ejecuta integración; requiere Docker disponible para Testcontainers. |
| `bun run test:tenant-isolation` | Ejecuta solo el test RLS ya incluido en integración; no hace falta repetirlo después de esa suite. |
| `bun run test:harness` | Ejecuta el proyecto Playwright histórico (`historical-harness`). |
| `bun run test:e2e` | Ejecuta el proyecto Playwright de sistema (`system`); requiere Docker para Testcontainers. |

Para ambos proyectos Playwright, instalá Chromium y sus dependencias con `bunx --no-install playwright install --with-deps chromium`. CI separa validación rápida, integración y cada proyecto de navegador en runners Ubuntu con límites de tiempo. Los fixtures de sistema levantan sus servicios y proveedores deterministas: no requieren `dev.env` ni secretos privados; integración ya cubre aislamiento RLS.

## Migraciones: desarrollo ≠ producción

`bun run db:migrate:dev` requiere `DATABASE_URL` del rol DDL (cargalo explícitamente, por ejemplo con `bun --env-file="$HOME/.config/agendia/dev.env" run db:migrate:dev`). Reproduce **todos** los archivos SQL revisados en orden sobre una base limpia de desarrollo; no registra migraciones aplicadas y no es seguro repetirlo sobre una base inicializada. `dev` evita repetirlo cuando detecta el esquema instalado.

**No uses `db:migrate:dev` en producción.** El flujo de producción aplica solo SQL pendiente con sumas de verificación y transacciones. Seguí la [guía de despliegue](docs/DEPLOYMENT.md), que también explica permisos, actualizaciones y respaldos. No puede adoptar una base inicializada por el ejecutor de desarrollo.

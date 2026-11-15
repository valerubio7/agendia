[agendIA](../README.md) / [Documentación](README.md) / Desarrollo

# Desarrollo

**Levantá primero el panel con su API y una base local.** WhatsApp y DeepSeek son un segundo recorrido, opcional: no necesitás cuentas de proveedores para trabajar en la interfaz, los contratos o las reglas de agenda.

[Preparar](#requisitos) · [Arrancar](#primera-puesta-en-marcha) · [Probar](#tests) · [Depurar](#depuración) · [Desplegar](OPERATIONS.md)

![Preparar el entorno y migrar PostgreSQL permite arrancar API y web para trabajar en el panel. Agregar manager y worker habilita el recorrido con WhatsApp y DeepSeek; los E2E usan proveedores simulados.](assets/development-workflow.svg)

## Requisitos

- **Bun 1.4.0**, fijado en [`package.json`](../package.json), y una terminal desde la raíz del repositorio.
- **Docker con Compose v2 y daemon disponible.** El [Compose local](../docker-compose.yml) crea PostgreSQL 16 y un volumen persistente; publica `5432` solo en loopback. Ese puerto debe estar libre.
- **Puertos 3000 y 3001 libres** para web y API. Los ejemplos usan el navegador en `http://localhost:3000`; no alternes entre `localhost` y `127.0.0.1` al iniciar sesión.
- **Solo E2E:** Chromium de Playwright y sus dependencias de sistema. Tras instalar las dependencias del proyecto, `bunx --no-install playwright install chromium` instala el navegador; los pasos Linux están en [CI](../.github/workflows/ci.yml). `curl` es opcional para las comprobaciones HTTP de esta guía.

Usá únicamente datos ficticios y una base descartable de desarrollo. No apuntes estos comandos ni las pruebas a producción.

## Primera puesta en marcha

### 1 · Instalar y configurar

```bash
bun install --frozen-lockfile
cp .env.example .env
```

Editá tu `.env` local antes de continuar. [`.env.example`](../.env.example) es la plantilla; estos son los requisitos del recorrido mínimo, no un catálogo completo:

| Configuración | Valor o condición local |
| --- | --- |
| `DATABASE_URL` | `postgres://agendia_migrator:agendia@127.0.0.1:5432/agendia`, correspondiente al Compose local. No reutilices esa cuenta en producción. |
| `APP_ORIGIN` | `http://localhost:3000`, exactamente el origen del navegador, sin barra final. |
| `WHATSAPP_LINK_CODE_KEY` | Clave aleatoria de 32 bytes codificada en base64. La API la exige incluso sin arrancar WhatsApp. |
| `AGENDIA_ADMIN_EMAIL` y `AGENDIA_ADMIN_PASSWORD` | Credenciales locales del bootstrap. Contraseña de al menos 16 caracteres, sin comenzar con `password`, `contraseña` o `123456` (sin distinguir mayúsculas). |

Para generar una clave local, ejecutá una vez y guardá el resultado solo en tu entorno privado:

```bash
bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

### 2 · Preparar la base y el administrador

```bash
docker compose up -d postgres
docker compose ps postgres
```

Esperá a que PostgreSQL figure **healthy** antes de seguir:

```bash
bun run db:migrate:dev
bun scripts/db/bootstrap-admin.ts
```

El [migrador](../scripts/db/db-migrate.ts) debe imprimir `Pending database migrations applied.`. El [bootstrap](../scripts/db/bootstrap-admin.ts) emite JSON con `event: "admin.bootstrap"` y `outcome: "created"` o `"existing"`. Repetirlo con el mismo correo administrador no cambia su contraseña; otro administrador existente o un conflicto de rol producen un fallo. No crea negocios.

## Levantar los servicios

### Panel y API

En dos terminales, ambas desde la raíz:

```bash
# Terminal 1: API en 127.0.0.1:3001; Bun carga el .env de la raíz.
bun apps/api/src/index.ts
```

```bash
# Terminal 2: web en el puerto 3000; abrí http://localhost:3000.
AGENDIA_API_ORIGIN=http://127.0.0.1:3001 bun run --cwd apps/web dev
```

`--cwd apps/web` cambia el directorio de ejecución: no dependas de que cargue el `.env` raíz. El [rewrite de Next](../apps/web/next.config.ts) necesita `AGENDIA_API_ORIGIN` explícito; el navegador usa `/api/*`, no el puerto de la API directamente. Si Next elige otro puerto porque 3000 está ocupado, liberalo o ajustá también `APP_ORIGIN` y reiniciá los procesos.

**Comprobá antes de desarrollar:**

```bash
curl -i http://127.0.0.1:3001/me/business-profile
curl -i http://localhost:3000/api/me/business-profile
```

Ambas peticiones sin sesión deben devolver **401** y `UNAUTHENTICATED`. La segunda comprueba además el proxy web; ninguna demuestra por sí sola que la base o los workers estén sanos. No hay endpoint de salud dedicado.

- Entrá en `/admin/login` con la identidad del bootstrap.
- En `/register`, enviá una solicitud de negocio y confirmá la contraseña. Volvés al ingreso; administración debe **aprobar** la solicitud antes de que puedas entrar por `/login`.
- Aprobar crea negocio e identidad; rechazar libera el correo. No hay verificación de correo ni alta manual de negocios por administración. Para preparar una reserva, seguí [la configuración del producto](understanding.md#quién-hace-qué).

Administración puede suspender, reactivar y **eliminar** negocios; la eliminación no está postergada ni equivale a suspensión. Leé [sus consecuencias](OPERATIONS.md#baja-de-negocios) antes de probarla, incluso en local.

### Agregar WhatsApp y el agente

Solo para un ensayo deliberado con proveedores reales: usá un número de prueba, sin clientes, y una clave de DeepSeek habilitada. Esto puede abrir conexiones externas y consumir saldo. Para pruebas automatizadas sin esos proveedores, usá [E2E](#tests).

Además de la base, configurá en el entorno local:

- **Worker:** `DEEPSEEK_API_KEY`; `DEEPSEEK_MODEL` es opcional.
- **Manager:** `BAILEYS_KMS_VERSION` y una `BAILEYS_KMS_KEY` aleatoria de 32 bytes en base64, distinta de la clave de vinculación. Compartí el mismo `WHATSAPP_LINK_CODE_KEY` entre API y manager.

En **cada terminal**, desde la raíz, exportá primero tu archivo local de confianza. El shell lo ejecuta como código; no uses archivos recibidos de terceros:

```bash
set -a; . ./.env; set +a
```

Después arrancá un proceso por terminal:

```bash
# Terminal 3
bun run --cwd apps/message-worker start
```

```bash
# Terminal 4
bun run --cwd apps/whatsapp-manager start
```

Los scripts activan `AGENDIA_RUN_MESSAGE_WORKER=1` y `AGENDIA_RUN_WHATSAPP_MANAGER=1`; ejecutar los archivos sin esas señales no arranca sus consumidores. En local ambos pueden usar `DATABASE_URL`; en producción usan [URLs por capacidad](OPERATIONS.md#topología). El manager también necesita acceso de worker para pg-boss.

Vinculá desde el panel del negocio y comprobá el estado **CONNECTED**. El manager recibe/envía y publica trabajo; el worker genera respuestas y resúmenes. Activá el agente y completá servicios, recursos y horarios antes del ensayo de agenda. [El recorrido de una reserva](booking-journey.md) distingue guardado y entrega: arrancar procesos no demuestra que un mensaje haya llegado.

## Variables de entorno

Mantené los valores en tu entorno privado, no en ejemplos compartidos. La [plantilla](../.env.example), los puntos de entrada de [API](../apps/api/src/index.ts), [worker](../apps/message-worker/src/index.ts) y [manager](../apps/whatsapp-manager/src/index.ts), y los [scripts de base](../scripts/db) explican quién consume cada valor.

Bun carga el archivo local al ejecutarse desde la raíz; una variable ya exportada puede prevalecer sobre él. Los workers con `--cwd` necesitan la exportación anterior. Producción usa la inyección de [Compose](../compose.production.yml), no este archivo; Next necesita su destino de API también al construir la web.

## Tests

Ejecutá desde la raíz después de instalar dependencias. No necesitás arrancar manualmente los servicios para estas suites:

| Comando | Qué comprueba | Requisito adicional |
| --- | --- | --- |
| `bun run typecheck` | Tipos del monorepo, sin emitir archivos. | Ninguno. |
| `bun run test:unit` | Unitarios en `tests/unit`, `packages`, `apps` y `scripts`. | Ninguno. |
| `bun run test:contracts` | Contratos HTTP, workers y adaptadores. | Ninguno. |
| `bun run test:integration` | Repositorios, migraciones, concurrencia y aislamiento RLS. | Docker disponible. |
| `bun run test:e2e` | Sistema y panel en Chromium con proveedores simulados. | Docker, Chromium y dependencias del navegador. |
| `bun run test` | Unitarios → integración → contratos → E2E. | Todos los anteriores; no incluye typecheck. |
| `bun run build` | Typecheck y build de Next. | Configurar `AGENDIA_API_ORIGIN` si el build debe incluir el proxy. |

Para acotar el cambio: `bun run test:e2e tests/e2e/system-happy-path.spec.ts`. Integración y E2E crean PostgreSQL con [Testcontainers](../tests/support/postgres.ts); Docker puede necesitar descargar la imagen. Los E2E [compilan Next en temporales](../tests/e2e/support/web-runtime.ts), usan puertos libres y [dobles de DeepSeek/Baileys](../tests/e2e/support/system.ts). El runner E2E desactiva la carga automática de `.env`; eso no es una licencia para exportar credenciales reales en la terminal de pruebas.

[`playwright.config.ts`](../playwright.config.ts) fija un worker por ejecución y conserva trazas/capturas ante fallos. Revisá esos diagnósticos antes de compartirlos. Elegí la prueba por la frontera que cambiaste: [HTTP y procesos](ARCHITECTURE.md), [agenda y consentimiento](booking-journey.md#para-seguirlo-en-el-código) o [RLS](DATABASE.md#aislamiento-y-roles).

## Migraciones

Agregá el siguiente archivo numerado en [`packages/db/migrations`](../packages/db/migrations); aplicá **todo el historial**, no solo la migración de registro. `bun run db:migrate:dev` usa `DATABASE_URL`, valida archivos aplicados y ejecuta pendientes en una transacción con lock.

No edites ni quites una migración aplicada, no repares checksums a mano y no intentes adoptar una base inicializada sin historial. Ante un rechazo, revisá [las garantías del migrador](DATABASE.md#migraciones) y el [runbook](OPERATIONS.md#runbook). pg-boss administra sus tablas dentro de `pgboss`; no las modifiques manualmente. Borrar el volumen no es una reparación: destruye el estado local, con los mismos [resguardos de aislamiento y copia](OPERATIONS.md#backups).

## Depuración

| Observación | Próxima comprobación |
| --- | --- |
| API termina con `api.bootstrap` / `failure` | Entorno de esa terminal: URL de base, `APP_ORIGIN`, clave de vinculación y puerto. El diagnóstico no expone el detalle de conexión. |
| Panel no llega a la API | Compará los dos checks HTTP anteriores; revisá destino del rewrite y reiniciá Next al cambiarlo. |
| 403 en registro, login o escritura | Origen exacto y CSRF según [autenticación HTTP](../apps/api/src/auth/http-auth.ts). No desactives protecciones. |
| Login no persiste o vuelve a pedir acceso | Usá el mismo origen; comprobá cookie segura en el navegador (HTTPS fuera de local), vencimiento y aprobación/estado del negocio. No copies cookies ni tokens a tickets. |
| WhatsApp conectado pero sin respuesta | Separá ingreso, espera programada, generación y envío con el [runbook](OPERATIONS.md#runbook); no asumas fallo por una demora prevista. |

Hay diagnósticos JSON de arranque y de workers, pero la API tiene el logger HTTP desactivado: no esperes un access log por petición. `technical_events` registra diagnóstico y `audit_events` auditoría; pueden contener datos personales. Consultalos solo en un entorno autorizado y redactá la evidencia compartida.

## CI

[El workflow real](../.github/workflows/ci.yml) corre en PR a `main`: primero typecheck, unitarios y contratos. Tras esa validación, **integración y tres shards de Playwright corren en paralelo**; el job final de Playwright exige el éxito de todos los shards. Se suben diagnósticos de navegador con retención de siete días. CI no despliega; la [publicación por tag](OPERATIONS.md#release) es otro workflow.

---

**Continuá → [Operaciones](OPERATIONS.md)** para desplegar y diagnosticar sin confundir el entorno local con producción. [Volver al mapa](README.md).

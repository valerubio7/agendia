[Portada](../README.md) / [Índice de documentación](README.md) / Desarrollo local

# Desarrollar agendIA en local

- **Solo panel:** PostgreSQL, API y web. No necesitás cuentas de WhatsApp ni DeepSeek.
- **Agente completo:** al panel le sumás el **worker de mensajes** y el **manager de WhatsApp**. Usá este camino si querés enviar un mensaje real y recibir la respuesta.

## 1. Preparar el entorno por primera vez

Usá **Bun 1.4.0** y Docker con Compose v2. Ejecutá los comandos desde la **raíz del repositorio**. Para una instalación nueva, reservá los puertos locales `5432` (PostgreSQL), `3001` (API) y `3000` (web).

```bash
bun install --frozen-lockfile
cp -n .env.example .env
```

`cp -n` copia la [plantilla](../.env.example) sin sobrescribir tu `.env`. Revisá estos valores antes de inicializar la base:

- `DATABASE_URL`: `postgres://agendia_migrator:<POSTGRES_PASSWORD>@127.0.0.1:5432/agendia`. Reemplazá `<POSTGRES_PASSWORD>` por la contraseña del servicio `postgres` en el [Compose local](../docker-compose.yml).
- `APP_ORIGIN`: `http://localhost:3000`, sin barra final. Usá ese mismo origen en el navegador.
- `WHATSAPP_LINK_CODE_KEY`: 32 bytes aleatorios en base64. La API valida esta clave incluso si solo usás el panel. Generala una vez y guardala en tu `.env` privado:

```bash
bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

Para el alta inicial completá también `AGENDIA_ADMIN_EMAIL` y `AGENDIA_ADMIN_PASSWORD`. Usá una contraseña local de al menos 16 caracteres que no empiece por `password`, `contraseña` o `123456`, sin importar las mayúsculas.

**Antes de escribir en la base:** verificá que sea una base **local de desarrollo**, con datos ficticios. Bun carga el `.env` desde la raíz, pero las variables ya exportadas pueden prevalecer. Dejá las URLs específicas por proceso (`API_DATABASE_URL`, `ADMIN_DATABASE_URL`, `MANAGER_DATABASE_URL`, `WORKER_DATABASE_URL`) sin definir o apuntando a esa misma base local.

```bash
docker compose up -d postgres
docker compose ps postgres
```

Cuando `postgres` figure **healthy**, inicializá **solo tu base local nueva**:

```bash
bun run db:migrate:dev && bun scripts/db/bootstrap-admin.ts
```

El migrador deja el esquema listo; el bootstrap debe emitir `admin.bootstrap` con `outcome: "created"` al crear el administrador. No crea negocios. Si ya tenés la base preparada, conservá el volumen y salteá ese alta: reiniciar no requiere recrear datos ni cambiar la contraseña.

## 2. Arrancar el panel, también al día siguiente

Si PostgreSQL está detenido, ejecutá `docker compose up -d postgres` y esperá a que vuelva a estar **healthy**. Abrí dos terminales **desde la raíz** y dejalas corriendo:

```bash
# Terminal 1: API
API_HOST=127.0.0.1 API_PORT=3001 bun apps/api/src/index.ts
```

```bash
# Terminal 2: web
AGENDIA_API_ORIGIN=http://127.0.0.1:3001 \
  bun run --cwd apps/web dev --hostname 127.0.0.1 --port 3000
```

La API lee el `.env` de la raíz. La web cambia de directorio con `--cwd`, así que le pasamos el destino de su [proxy `/api`](../apps/web/next.config.ts) en el comando.

1. Entrá en [Administración](http://localhost:3000/admin/login) con el administrador inicial. Si aparece **Negocios**, ya comprobaste el acceso desde la web con la API y la base local.
2. En una ventana privada, [solicitá acceso](http://localhost:3000/register) con un negocio ficticio, otro correo y una contraseña de al menos 16 caracteres. La solicitud queda pendiente.
3. Aprobala en **Negocios**. Después entrá al [panel del negocio](http://localhost:3000/login) con su propia cuenta. Al día siguiente usá esa misma cuenta: no hace falta registrar el negocio otra vez.

**Si solo vas a trabajar en el panel, ya podés parar acá.**

## 3. Sumar worker y manager para probar el agente

Usá dos números de prueba: uno para vincular y otro para escribirle. Este recorrido conecta con WhatsApp y DeepSeek reales y puede consumir saldo.

En el mismo `.env` de la raíz agregá:

- **Worker:** `DEEPSEEK_API_KEY`, una clave habilitada. No hace falta fijar `DEEPSEEK_MODEL` para usar el modelo por defecto.
- **Manager:** `BAILEYS_KMS_VERSION`, un identificador no vacío como `local-v1`, y `BAILEYS_KMS_KEY`, otra clave de **32 bytes en base64**. Generala con el mismo comando de arriba, pero no reutilices la clave de vinculación. Conservá juntos la clave y su versión si querés recuperar la sesión al reiniciar.

Dejá la misma `WHATSAPP_LINK_CODE_KEY` para API y manager: uno prepara el QR cifrado y el otro lo muestra. Ambos procesos nuevos necesitan la base ya migrada, incluido el esquema `pgboss`; en local alcanza con `DATABASE_URL`. No hace falta otro servicio de colas.

Con el panel todavía abierto, arrancá estos procesos en dos terminales nuevas, **también desde la raíz**:

```bash
# Terminal 3: worker, genera la respuesta con DeepSeek
AGENDIA_RUN_MESSAGE_WORKER=1 bun apps/message-worker/src/index.ts
```

```bash
# Terminal 4: manager, vincula WhatsApp, recibe y envía mensajes
AGENDIA_RUN_WHATSAPP_MANAGER=1 bun apps/whatsapp-manager/src/index.ts
```

Son los mismos indicadores que ponen los scripts `start` del [worker](../apps/message-worker/package.json) y del [manager](../apps/whatsapp-manager/package.json). Ejecutarlos desde la raíz permite que Bun lea el mismo `.env` sin ejecutarlo como script de shell. Si cambiaste una clave, reiniciá los procesos que la usan.

### Vincular y comprobar una respuesta

1. En el panel del negocio, creá un **servicio ficticio** con nombre, duración y precio para que el agente tenga algo que consultar. Si querés probar una reserva y no solo una respuesta, [configurá también el horario y un recurso que preste ese servicio](overview.md#qué-configura-el-negocio).
2. En **Agente**, marcá **Respuestas automáticas activas** y elegí **Guardar y activar**. Sin ese paso no se puede pedir la vinculación.
3. En **WhatsApp**, elegí **Vincular WhatsApp**. Escaneá el QR desde *Dispositivos vinculados* en el teléfono de prueba y esperá a ver **Conectado**. Si retomás una sesión y ya figura **Conectado**, no hace falta otro QR.
4. Desde **el otro número**, mandá por chat individual un texto como «¿Qué servicios ofrecen?». Comprobá que la respuesta llegue **a ese chat**. El primer mensaje de una conversación nueva se programa con **10 minutos de espera por defecto**, más el tiempo de generación y envío; que el QR se haya vinculado no significa que la respuesta ya salió.

## Si algo falla

- **La web abre pero no podés entrar:** confirmá que la API sigue corriendo y que abriste `http://localhost:3000`, no `127.0.0.1:3000`. Si es una cuenta de negocio, verificá que esté aprobada.
- **No aparece el QR:** revisá que el agente esté activo, que el manager siga corriendo y que comparta la clave de vinculación con la API. No compartas el QR ni las claves para diagnosticar.
- **Worker o manager se cierra al arrancar:** revisá su terminal, las claves, el directorio de arranque y que ambos usen la base local migrada. El manager también usa la conexión de worker para la cola si `WORKER_DATABASE_URL` está definida.
- **Figura Conectado pero no llega respuesta:** distinguí la espera prevista de un fallo. Confirmá que fue un texto individual desde otro número, que el agente sigue activo y que el worker no reporta fallos de DeepSeek. El manager entrega la respuesta después de que el worker la genera.

## Pruebas

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

Integración y E2E crean PostgreSQL con [Testcontainers](../tests/support/postgres.ts); Docker puede necesitar descargar la imagen. Los E2E [compilan Next en temporales](../tests/e2e/support/web-runtime.ts), usan puertos libres y [dobles de DeepSeek/Baileys](../tests/e2e/support/system.ts). No exportes credenciales reales en la terminal de pruebas.

## Migraciones

Agregá el siguiente archivo numerado en [`packages/db/migrations`](../packages/db/migrations); aplicá **todo el historial**. El [migrador](../scripts/db/db-migrate.ts) que usa `bun run db:migrate:dev` toma `DATABASE_URL`, valida los archivos aplicados y ejecuta pendientes en una transacción con lock. No edites ni quites migraciones ya aplicadas, no corrijas checksums a mano y no intentes adoptar una base inicializada sin historial. Las tablas de `pgboss` las administra la biblioteca; borrar el volumen destruye el estado local, no lo repara.

## CI

[El workflow](../.github/workflows/ci.yml) corre en PR a `main`: primero typecheck, unitarios y contratos. Después, integración y tres shards de Playwright corren en paralelo; el job final de Playwright exige el éxito de todos los shards. CI no despliega; la [publicación por tag](operations.md#release) es otro workflow.

---

[Volver al índice](README.md) · [Despliegue en Dokploy](operations.md#despliegue)

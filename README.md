# AgendIA

Plataforma SaaS multiempresa para asistentes de IA conectados a WhatsApp.

El runtime separa el panel Next.js, la API Fastify, el gestor persistente de WhatsApp y el worker de mensajes conectado a PostgreSQL y la cola durable. El panel consume la API autenticada mediante cookies y protección CSRF, sin enviar identidad de tenant desde el navegador. La aceptación de sistema navega por HTTP real y reemplaza únicamente los proveedores externos por dobles deterministas; también cubre aislamiento entre tenants, fallos de proveedores, salidas ambiguas y recuperación tras reinicios. La trazabilidad ejecutable vincula cada requisito, escenario y criterio de aceptación con evidencia automatizada concreta. El validador anti-bypass exige assertions semánticas ejecutadas en E2E de sistema para socket ingress, JID exacto, QR, outbox, resúmenes y auditoría. El flujo productivo recibe eventos `messages.upsert` desde Baileys y entrega cada respuesta al JID validado de la conversación mediante la conexión propietaria. El vínculo muestra únicamente al tenant propietario un QR efímero, persistido de forma cifrada e invalidado al vencer o abrirse la conexión. Los trabajos de IA salen de una outbox durable hacia pg-boss con identidad estable, recuperación al iniciar y semántica at-least-once contenida por consumidores idempotentes. Los resúmenes conversacionales se actualizan de forma durable por tenant y chat, conservan watermarks monotónicos y nunca reemplazan el historial crudo como fuente autoritativa. La auditoría append-only valida rol y tenant en PostgreSQL, registra eventos seguros de acceso, ciclo WhatsApp y fallos de envío, y proyecta la última actividad técnica sin exponer conversaciones ni secretos. La auditoría crítica valida rol y tenant en PostgreSQL, contiene errores de proveedor y proyecta actividad técnica segura para el panel administrativo.

Consulte [`docs/development.md`](docs/development.md) para preparar el monorepo Bun. Node.js 22 LTS es el runtime de producción; Bun administra paquetes, workspaces, `bun.lock` y scripts.

## Desarrollo local con proveedores reales

Los secretos locales se guardan fuera del repositorio. Cree el archivo de configuración, restrinja sus permisos y edítelo con los valores necesarios:

```sh
mkdir -p "$HOME/.config/agendia"
chmod 700 "$HOME/.config/agendia"
touch "$HOME/.config/agendia/dev.env"
chmod 600 "$HOME/.config/agendia/dev.env"
${EDITOR:-vi} "$HOME/.config/agendia/dev.env"
```

Nunca guarde secretos en un `.env` dentro del repositorio. Tanto el supervisor como el bootstrap manual (`bun run bootstrap:admin`) cargan explícitamente `~/.config/agendia/dev.env`; los procesos hijos heredan ese entorno.

Con Docker activo y el archivo externo completo, ejecute:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run dev
```

El supervisor acepta únicamente PostgreSQL local, inicia el servicio Compose si el puerto configurado no responde, aplica migraciones, provisiona idempotentemente el administrador y expone el panel en <http://127.0.0.1:3000>. Inicie sesión con `AGENDIA_ADMIN_EMAIL` y `AGENDIA_ADMIN_PASSWORD`. Para vincular WhatsApp, cree un negocio, entre como su usuario, abra **WhatsApp** y escanee el QR efímero; no copie el QR a logs ni archivos.

Este stack usa DeepSeek real: procesar mensajes y generar resúmenes consume crédito de la cuenta asociada a `DEEPSEEK_API_KEY`. Revise límites y costos en el panel de DeepSeek antes de enviar tráfico.

`Ctrl-C` detiene API, panel, gestor y worker. PostgreSQL queda persistido para el próximo inicio; `docker compose down` lo detiene y elimina el contenedor. Para borrar además los datos locales, use conscientemente `docker compose down -v`.

La operación, recuperación y aceptación integral están documentadas en [`docs/operations.md`](docs/operations.md) y [`docs/acceptance.md`](docs/acceptance.md). La evidencia TDD de remediación se registra en [`docs/tdd-remediation-evidence.md`](docs/tdd-remediation-evidence.md); la procedencia histórica no demostrable se mantiene separada de la línea base prospectiva autorizada el 2026-08-28.

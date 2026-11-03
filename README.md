# agendIA

Panel web para administrar un agente de IA que atiende y agenda turnos por WhatsApp. Cada negocio configura su perfil, servicios, recursos, calendario, clientes y el comportamiento de su agente; el agente conversa con los clientes, consulta disponibilidad y crea o modifica turnos.

## Qué incluye

- **Panel del negocio**: perfil, servicios, recursos, calendario y cierres, clientes, turnos y configuración del agente.
- **Panel de administración**: solicitudes, estado de negocios, tiempos de respuesta y estado de WhatsApp.
- **Agente de WhatsApp**: recibe mensajes, consulta la agenda y opera turnos con confirmaciones idempotentes.
- **Multi-tenant**: aislamiento por `business_id` con Row-Level Security en PostgreSQL.

## Stack

Bun 1.4 · TypeScript · Fastify · Next.js 16 · PostgreSQL 16 · Drizzle + SQL · pg-boss · Baileys · DeepSeek

## Mapa del repositorio

| Ruta | Qué es |
| --- | --- |
| `apps/api` | API HTTP (Fastify), autenticación y unit of work por negocio. |
| `apps/web` | Panel Next.js: negocio, administración y login. |
| `apps/message-worker` | Consumidor de la cola de IA: turnos de conversación y resúmenes. |
| `apps/whatsapp-manager` | Sesiones Baileys, ingesta de mensajes y envío de respuestas. |
| `packages/db` | Migraciones SQL, roles, unit of work y repositorios. |
| `packages/domain` | Reglas puras: agenda, disponibilidad, catálogo y agente. |
| `packages/contracts` | Esquemas Zod compartidos entre API y web. |
| `packages/auth` | Hash de contraseñas, sesiones y CSRF. |
| `packages/ai-deepseek` | Adaptador de DeepSeek. |
| `packages/whatsapp-baileys` | Gateway de Baileys y almacenamiento cifrado de credenciales. |

## Arranque local

Requisitos: Bun 1.4.0, Docker y Docker Compose.

```bash
bun install
docker compose up -d postgres
cp .env.example .env
bun run db:migrate:dev
bun scripts/db/bootstrap-admin.ts
```

En dos terminales:

```bash
# API en http://127.0.0.1:3001
bun apps/api/src/index.ts

# Web en http://127.0.0.1:3000
AGENDIA_API_ORIGIN=http://127.0.0.1:3001 bun run --cwd apps/web dev
```

El panel queda en `http://127.0.0.1:3000` y el acceso de administración en `/admin/login`. Un negocio solicita acceso en `/register` y espera la aprobación antes de iniciar sesión; no se verifica el correo. Administración puede aprobar o rechazar solicitudes y suspender negocios, pero ya no crearlos manualmente. Rechazar libera el correo para otra solicitud; la eliminación completa queda postergada. Los workers de WhatsApp y de IA se levantan aparte; el detalle de variables y comandos está en [Desarrollo](docs/DEVELOPMENT.md).

## Tests

```bash
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contracts
bun run test:e2e
```

Cada suite cubre una capa distinta y se explica en [Desarrollo](docs/DEVELOPMENT.md).

## Documentación

- [Mapa y reglas de la documentación](docs/README.md)
- [Arquitectura](docs/ARCHITECTURE.md)
- [Base de datos](docs/DATABASE.md)
- [Desarrollo](docs/DEVELOPMENT.md)
- [Operaciones](docs/OPERATIONS.md)

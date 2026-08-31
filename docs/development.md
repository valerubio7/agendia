# Desarrollo

agendIA usa Bun como gestor de paquetes, workspaces y scripts; Node.js 22 LTS es el runtime de producción. Copie `.env.example`, levante PostgreSQL con `docker compose up -d postgres` y ejecute `bun install --frozen-lockfile` seguido de `bun run test`.

Los servicios son `web`, `api`, `whatsapp-manager` y `message-worker`. Las pruebas bloqueantes usan dobles deterministas: nunca necesitan credenciales reales de WhatsApp o DeepSeek.

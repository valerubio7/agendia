# Base de datos

agendIA usa PostgreSQL 16. Las migraciones SQL son la autoridad del modelo: `packages/db/migrations/` define tablas, roles, políticas RLS, funciones y disparadores. [`schema.ts`](../packages/db/src/schema.ts) declara solo 3 tablas y no es el inventario completo.

Esta guía describe el repositorio; no inspecciona una base en ejecución ni confirma qué migraciones se aplicaron en un servidor.

## Cómo leer

- Vista general y aislamiento: este documento.
- Cada tabla, su propósito y sus relaciones: [database/tables.md](database/tables.md).
- DDL exacto, restricciones y políticas: [`0000_base.sql`](../packages/db/migrations/0000_base.sql).

## Modelo en pocas palabras

Un **negocio** es la unidad de aislamiento. Su `business_id` acompaña a casi todos los registros y las relaciones usan claves foráneas compuestas `(business_id, id)`, así que un registro no puede apuntar a otro negocio.

| Área | Qué guarda | Tablas |
| --- | --- | --- |
| Identidad y acceso | Negocios, usuarios web y sesiones. | `businesses`, `tenant_records`, `auth_identities`, `web_sessions` |
| Configuración | Perfil público y comportamiento del agente. | `business_profiles`, `agent_configs` |
| Eventos y control | Auditoría, diagnóstico, outbox/inbox y límites de login. | `audit_events`, `technical_events`, `outbox_events`, `inbox_events`, `operational_controls`, `login_throttle_global`, `login_throttle_accounts` |
| WhatsApp | Conexión, credenciales cifradas y vinculación. | `whatsapp_connections`, `whatsapp_auth_records`, `whatsapp_link_codes`, `whatsapp_sender_bindings`, `whatsapp_received_senders` |
| Conversaciones | Historial, resúmenes, envíos y estado del agente. | `conversations`, `messages`, `conversation_summaries`, `outbound_commands`, `whatsapp_agenda_dialogues`, `whatsapp_agenda_receipts` |
| Catálogo | Servicios, recursos y clientes. | `services`, `resources`, `resource_services`, `clients` |
| Agenda | Calendario, cierres, turnos e idempotencia. | `business_calendars`, `business_calendar_closures`, `appointments`, `appointment_operation_receipts` |

## Relaciones

Identidad y agenda:

```mermaid
erDiagram
  businesses ||--o| business_profiles : perfil
  businesses ||--o| agent_configs : agente
  businesses ||--o| auth_identities : usuario
  auth_identities ||--o{ web_sessions : sesiones
  businesses ||--o| business_calendars : calendario
  businesses ||--o{ business_calendar_closures : cierres
  businesses ||--o{ services : servicios
  businesses ||--o{ resources : recursos
  resources ||--o{ resource_services : habilita
  services ||--o{ resource_services : asignado
  businesses ||--o{ clients : clientes
  businesses ||--o{ appointments : turnos
  clients ||--o{ appointments : reserva
  services ||--o{ appointments : servicio
  resources ||--o{ appointments : atiende
```

Mensajería:

```mermaid
erDiagram
  businesses ||--o| whatsapp_connections : vincula
  whatsapp_connections ||--o{ whatsapp_auth_records : credenciales
  whatsapp_connections ||--o| whatsapp_link_codes : código
  whatsapp_connections ||--o{ conversations : conversaciones
  conversations ||--o{ messages : mensajes
  conversations ||--o{ conversation_summaries : resúmenes
  conversations ||--o{ outbound_commands : envíos
  whatsapp_connections ||--o{ outbound_commands : conexión
  whatsapp_connections ||--o{ whatsapp_sender_bindings : números
  whatsapp_sender_bindings ||--o{ whatsapp_agenda_dialogues : diálogo
  messages ||--o| whatsapp_received_senders : remitente
  messages ||--o| whatsapp_agenda_receipts : comprobante
```

`outbound_commands.source_message_id` es una referencia lógica con índice único, no una FK. `audit_events.business_id` puede ser NULL para eventos de plataforma.

## Aislamiento y roles

- 26 de las 32 tablas tienen `ENABLE` + `FORCE ROW LEVEL SECURITY`. Las 6 globales son `businesses`, `auth_identities`, `web_sessions`, `operational_controls` y los dos throttles de login.
- Hay cuatro roles de capacidad, todos `NOLOGIN` y `NOBYPASSRLS`: `agendia_runtime` (panel del negocio), `agendia_admin_runtime` (administración), `agendia_whatsapp_runtime` (Baileys) y `agendia_worker_runtime` (agente y resúmenes).
- Los logins de conexión (`agendia_api`, `agendia_admin`, `agendia_worker`, `agendia_manager`) solo tienen membresía. Cada transacción ejecuta `SET LOCAL ROLE` y publica `app.tenant_id`, `app.actor_role`, `app.actor_id` y `app.request_id`; las políticas comparan esos valores.
- Las funciones `SECURITY DEFINER` (`route_whatsapp_session`, `claim_ai_outbox`, `claim_owned_outbound`, `append_runtime_audit`, etc.) son el acceso acotado para reclamar trabajo, enrutar sesiones y auditar. Su ejecución está revocada de `PUBLIC`.
- El bootstrap garantiza un único `platform_admin` con un lock y una verificación en la aplicación; la tabla no impone esa unicidad. Sí impone un solo `business_user` por negocio mediante un índice parcial.
- RLS no protege frente a superusuarios y no es cifrado: los datos siguen legibles para quien tenga la clave o privilegios elevados.

## Migraciones

| Archivo | Qué hace |
| --- | --- |
| `0000_base.sql` | Instalación base: 32 tablas, cuatro roles, RLS, funciones, vista `admin_business_status`, extensión `btree_gist` y esquema `pgboss`. |
| `0001_remove_admin_ai_guidance.sql` | Elimina `operational_controls.additional_instructions`. Es irreversible. |
| `0002_agent_silent_completion.sql` | Permite `whatsapp_agenda_receipts.outbound_id` NULL y agrega el `CHECK` de operación `silent`. |

El migrador registra cada archivo en `agendia_production_migrations` con su checksum y rechaza historial editado o desconocido. En desarrollo se ejecuta con `bun run db:migrate:dev`; en producción lo hace el target `db-setup` de `Dockerfile.api`. La cola `pgboss` la administra la biblioteca, no estas migraciones.

## Datos sensibles

| Dato | Tratamiento |
| --- | --- |
| Contraseña (`password_phc`) | Hash Argon2id; no es reversible. |
| Token de sesión y CSRF | SHA-256 almacenado; no se guarda el token original. |
| Credenciales de WhatsApp | AES-256-GCM; la DEK se guarda envuelta por la KEK. |
| Código de vinculación | AES-256-GCM con vencimiento; se elimina al usarlo, al reemplazarlo, en la limpieza de vencidos o al borrar la conexión. |
| Mensajes y resúmenes | Sin cifrado de aplicación; `raw_text` y `structured_summary` quedan legibles en la base. |
| Auditoría y eventos técnicos | Pueden contener datos personales; `safe_details` no filtra secretos automáticamente. |

No copies credenciales, códigos, tokens ni textos de clientes a diagnósticos o capturas. El cifrado de disco, las copias y la retención son decisiones de despliegue, no de este esquema.

## Para profundizar

- Diccionario de tablas: [database/tables.md](database/tables.md).
- Migraciones: [`packages/db/migrations/`](../packages/db/migrations/).
- Roles y pools: [`packages/db/src/runtime-pools.ts`](../packages/db/src/runtime-pools.ts).
- Cifrado de credenciales: [`packages/whatsapp-baileys/src/auth-store.ts`](../packages/whatsapp-baileys/src/auth-store.ts).

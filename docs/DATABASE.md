# Base de datos

agendIA usa PostgreSQL 16. [`schema.ts`](../packages/db/src/schema.ts) representa en Drizzle 0.45.2 las **35 tablas públicas de aplicación y la vista `admin_business_status`**, con sus restricciones, índices y políticas RLS, efectivas tras 0000–0008. Las migraciones SQL de `packages/db/migrations/` siguen siendo la autoridad de instalación; el migrador oficial de Drizzle las ejecuta mediante un `pg.Client` dedicado. Los repositorios y las transacciones de aplicación todavía usan su implementación anterior.

Esta guía describe el repositorio; no inspecciona una base en ejecución ni confirma qué migraciones se aplicaron en un servidor.

## Cómo leer

- Vista general y aislamiento: este documento.
- Cada tabla, su propósito y sus relaciones: [database/tables.md](database/tables.md).
- DDL exacto, restricciones y políticas: [`packages/db/migrations/`](../packages/db/migrations/), incluida [`0004_registration.sql`](../packages/db/migrations/0004_registration.sql) para registro.

## Modelo en pocas palabras

Un **negocio** es la unidad de aislamiento. Su `business_id` acompaña a casi todos los registros y las relaciones usan claves foráneas compuestas `(business_id, id)`, así que un registro no puede apuntar a otro negocio.

| Área | Qué guarda | Tablas |
| --- | --- | --- |
| Identidad y acceso | Negocios, solicitudes pendientes, usuarios web y sesiones. | `businesses`, `tenant_records`, `pending_registrations`, `auth_identities`, `web_sessions` |
| Configuración | Perfil público y comportamiento del agente. | `business_profiles`, `agent_configs` |
| Eventos y control | Auditoría, diagnóstico, outbox/inbox y límites de login. | `audit_events`, `technical_events`, `outbox_events`, `inbox_events`, `operational_controls`, `login_throttle_global`, `login_throttle_accounts` |
| WhatsApp | Conexión, credenciales cifradas y vinculación. | `whatsapp_connections`, `whatsapp_auth_records`, `whatsapp_link_codes`, `whatsapp_sender_bindings`, `whatsapp_received_senders` |
| Conversaciones | Historial, resúmenes, envíos y estado del agente. | `conversations`, `messages`, `conversation_summaries`, `outbound_commands`, `whatsapp_agenda_dialogues`, `whatsapp_agenda_receipts` |
| Catálogo | Categorías, servicios, recursos y clientes. | `service_categories`, `services`, `resources`, `resource_services`, `clients` |
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

`outbound_commands.source_message_id` es una referencia lógica con índice único, no una FK. `audit_events.business_id` puede ser NULL para eventos de plataforma. `registration_throttle` limita el registro público por separado del login.

## Representación Drizzle y límites

El módulo mantiene los exports públicos existentes y usa `bigint` de JavaScript para columnas PostgreSQL `bigint`, cadenas para `numeric` sin precisión fija y `Buffer` para `bytea`. Las fechas de calendario usan cadenas; los timestamps usan `Date`. No agrega enums ni FKs a referencias lógicas.

| En Drizzle | Conservado en SQL |
| --- | --- |
| Columnas, defaults y expresiones de columnas generadas | Collation ICU `service_name_case` y `COLLATE "C"` de `services.normalized_name` y `resources.normalized_name`; no hay API pública de collation de columna en 0.45.2. |
| PK, UNIQUE, CHECK y FKs con nombres, orden y acciones | Exclusión GiST `appointments_confirmed_capacity`: evita superposición de turnos confirmados; **no es un índice ordinario**. |
| 15 índices independientes, incluidos parciales, expresiones, DESC y GIN | Extensión `btree_gist`, esquema `pgboss` y filas singleton iniciales. |
| `ENABLE RLS` y políticas completas: roles, comandos, USING y WITH CHECK | `FORCE RLS`; roles, membresías y ACLs completas, incluidos permisos por columna y revocaciones. |
| Definición final de `admin_business_status`, que oculta negocios eliminados | Funciones, incluidas las `SECURITY DEFINER`, sus propietarios/search_path, y triggers de auditoría, actividad y baja. |

La suite [`drizzle-schema-catalog.integration.test.ts`](../tests/integration/drizzle-schema-catalog.integration.test.ts) aplica las nueve migraciones **solo en PostgreSQL 16 desechable** y materializa los metadatos públicos en un esquema de prueba. PostgreSQL canonicaliza las expresiones de ambos catálogos. La comparación parametrizada cubre inventario, columnas/defaults/generación/collation, restricciones nombradas y ordenadas, acciones FK, índices independientes (orden, opclasses y predicados), políticas y flags RLS. Cuatro mutaciones revertidas comprueban que detecta drift de default, acción FK, índice y política.

Las excepciones de collation se aplican explícitamente al esquema de prueba: no se afirma que Drizzle las emita. Se comprueban aparte FORCE RLS, la exclusión, collations, roles, membresía de purga, ACLs sensibles, triggers, SQLSTATE `42501`, extensión/esquema y seeds. Estos checks **no constituyen equivalencia exhaustiva de todos los cuerpos de funciones, grants ni su comportamiento concurrente**; el SQL histórico y las pruebas funcionales de seguridad siguen siendo necesarios. El helper es solo de pruebas, no un generador ni un runner de migraciones. No incluye objetos internos de extensiones, la cola `pgboss` ni la tabla de historial del migrador en el inventario de aplicación.

## Aislamiento y roles

- 27 tablas tienen `ENABLE` + `FORCE ROW LEVEL SECURITY` (incluida `service_categories`). Las globales incluyen `businesses`, `auth_identities`, `web_sessions`, `operational_controls`, los throttles de login y las dos tablas de registro. El rol de administración solo puede leer los datos no sensibles de las solicitudes pendientes; las decisiones pasan por una función acotada.
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
| `0003_session_idle_ttl.sql` | Agrega la política de inactividad de sesión. |
| `0004_registration.sql` | Agrega solicitudes pendientes, throttle de registro y funciones de envío y decisión. La aprobación crea negocio e identidad; el rechazo libera el correo. |
| `0005_service_duration_five_minutes.sql` | Cambia a múltiplos positivos de cinco minutos la duración de servicios y turnos. |
| `0006_service_categories.sql` | Agrega categorías con RLS y una FK compuesta de servicio a categoría del mismo negocio. |
| `0007_private_business_purge.sql` | Agrega `deleted_at`, purga privada, políticas y triggers de baja; filtra la vista administrativa. |
| `0008_ownership_sqlstate.sql` | Conserva el SQLSTATE `42501` al rechazar cambios de propietario, sin quitar la barrera de baja. |

El migrador oficial de Drizzle ejecuta el SQL y mantiene `drizzle.__drizzle_migrations`. El journal estático `meta/_journal.json` referencia directamente 0000–0008, sin modificar esos archivos; su campo adicional `sha256` fija el hash del archivo completo. Antes de escribir se validan todos los archivos, el orden, los índices, tags y timestamps únicos y crecientes del journal, y ambos historiales completos como prefijos cronológicos exactos. Los IDs SERIAL pueden tener saltos tras un rollback: no definen el orden de migración.

Una base nueva ejecuta las nueve migraciones. Una base con un prefijo legacy válido se adopta insertando solamente las filas correspondientes en el historial Drizzle; el migrador stock ejecuta el sufijo pendiente. `public.agendia_production_migrations` queda **congelada como evidencia**, sin escritura dual ni borrado. Un historial Drizzle no vacío más corto que el legacy es un conflicto, no una adopción parcial. Una base pública inicializada sin historial, incluso con tablas de historial vacías, se rechaza.

Un lock de sesión con `hashtext('agendia:production-setup')` serializa migradores y provisión de logins. La validación/adopción y el lote pendiente comparten una transacción explícita: el BEGIN del migrador stock se anida en ella y su COMMIT la termina. No hay escrituras requeridas después del COMMIT. Una falla SQL revierte DDL y filas de historial del lote; las secuencias PostgreSQL existentes pueden consumir valores aunque se revierta la transacción.

En desarrollo se ejecuta con `bun run db:migrate:dev`; en producción Compose ejecuta el target `db-setup` de `Dockerfile.api` antes de iniciar la API y los workers. Se conservan los mensajes normales y códigos de salida. Consultá [Operaciones](OPERATIONS.md) para diagnósticos y reconciliación. La cola `pgboss` la administra la biblioteca, no estas migraciones.

**Límites:** validar fuentes/historial no demuestra equivalencia del esquema vivo. Las pruebas aisladas comparan catálogos, seguridad y datos al actualizar cada prefijo histórico; no se repara drift manual o no soportado. Ante drift, detené el despliegue e investigá. La generación con Drizzle Kit, su configuración/snapshot y la migración de repositorios/transacciones de aplicación siguen pendientes; este corte solo cambia ejecución y adopción del historial.

### Baja de negocios

`0007_private_business_purge.sql` incorpora una marca irreversible `businesses.deleted_at` y la función `delete_business`, accesible únicamente al rol de administración con una sesión de administrador vigente. La transacción bloquea el negocio, purga sus datos activos, conserva la auditoría y agrega un evento con administrador, negocio y fecha. Disparadores serializan inserciones y actualizaciones de datos del negocio contra esa baja y rechazan escrituras posteriores, incluso de procesos anteriores. La fila identificatoria queda suspendida y oculta de la lista administrativa; el correo vuelve a estar disponible.

La función usa un rol sin login ni BYPASSRLS con permisos específicos y políticas de purga; el login migrador debe poder crear roles y otorgarse membresía en ese rol. Los roles de aplicación no reciben esa membresía. La primitiva `purge_business_data_private` no es una API y no debe invocarse directamente.

Si un comprobante de otro negocio referencia una identidad eliminada, se conserva inactiva y anonimizada, sin sesiones ni contraseña utilizable. La auditoría histórica es inmutable y puede contener datos personales. Los jobs ya publicados en `pgboss` no se borran; los procesadores encuentran los datos de origen ausentes. El manager actual comprueba la baja antes de invocar el gateway, pero el gateway puede esperar antes de llamar al proveedor. Por eso todavía no se demuestra que toda llamada al proveedor haya comenzado antes de la baja. Un manager antiguo podría iniciar después un envío reclamado previamente. La baja no cierra ni drena sockets antiguos.

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

# Diccionario de tablas

Referencia de las 32 tablas de `0000_base.sql`, agrupadas por área. El detalle de columnas, `CHECK`, índices y políticas vive en la migración; acá está el propósito de cada tabla y cómo se conecta.

Convenciones: las PK `id` son `uuid`; los `created_at`/`updated_at`/`occurred_at` son `timestamptz`. Salvo que se indique lo contrario, las columnas son obligatorias.

## Identidad y acceso

### `businesses`
Raíz del tenant. `status` es `active` o `suspended`; suspender no borra datos. `last_technical_activity_at` lo actualiza un disparador al insertar `technical_events`.

### `tenant_records`
Tabla mínima para demostrar el aislamiento por RLS. No es una tabla de agenda ni de negocio real.

### `auth_identities`
Usuarios web. `role` es `platform_admin` (sin negocio) o `business_user` (con `business_id` obligatorio). Un índice parcial permite un solo `business_user` por negocio. `password_phc` es Argon2id.

### `web_sessions`
Sesiones web. Guarda `token_sha256` y `csrf_sha256`, nunca el token original. `absolute_expires_at` e `idle_expires_at` se evalúan en la aplicación; `revoked_at` permite revocar.

## Configuración

### `business_profiles`
Uno por negocio. `display_name`, `description` y `address`. Es la información pública que usa el agente.

### `agent_configs`
Uno por negocio. `active`, `style`, `business_instructions` y `revision`. La revisión permite invalidar contexto cuando cambia la configuración.

## Eventos y control

### `audit_events`
Auditoría append-only con cadena de hashes (`stream_sequence`, `previous_hash`, `event_hash`). `business_id` puede ser NULL para eventos de plataforma. Un disparador rechaza `UPDATE` y `DELETE`; `append_runtime_audit` valida evento, origen y contexto.

### `technical_events`
Diagnóstico por negocio (`component`, `code`, `severity`, `safe_details`). Cada inserción proyecta la fecha en `businesses.last_technical_activity_at`.

### `outbox_events`
Outbox transaccional. `(business_id, stable_key)` es único. Los tópicos incluyen `ai.generate` y `whatsapp.link_requested`. Las columnas `claim_token`, `claimed_at`, `publish_attempts` y `next_attempt_at` sostienen el reclamo y el reintento.

### `inbox_events`
Deduplicación de entradas por `(business_id, source, stable_key)`. No guarda el cuerpo del mensaje.

### `operational_controls`
Fila única (`singleton`). `automation_disabled` es el interruptor global; `incident_reference` documenta la interrupción; los tres delays regulan el ritmo de respuesta. `additional_instructions` fue eliminado por `0001`.

### `login_throttle_global`
Fila única. Presupuesto global de 120 intentos por minuto. `admit_login` lo actualiza de forma atómica.

### `login_throttle_accounts`
Presupuesto por cuenta (hash del correo normalizado): 20 intentos cada 15 minutos. Se limpia por vencimiento.

## WhatsApp

### `whatsapp_connections`
Una por negocio. `state` es `LINK_REQUIRED`, `LINKING`, `CONNECTED`, `RECONNECTING`, `DISCONNECTED` o `ERROR`. Guarda la DEK envuelta, `owner_id`, `heartbeat_at`, `ownership_token` y el estado de vinculación.

### `whatsapp_auth_records`
Credenciales de Baileys cifradas por registro. PK `(business_id, connection_id, record_name)`; solo el rol del manager tiene acceso.

### `whatsapp_link_codes`
Código temporario de vinculación, uno por conexión. `token` es único; `ciphertext`, `nonce` y `auth_tag` son el secreto sellado; `expires_at` define la vigencia.

### `conversations`
Una por `(business_id, connection_id, remote_jid)`. `next_sequence` ordena los mensajes; `reply_due_at`, `latest_inbound_id`, `last_exchange_at` y `last_reply_at` gobiernan el ritmo y la supersesión de respuestas.

### `messages`
Historial de entrada y salida. `direction` es `inbound` u `outbound`; `sequence` ordena por conversación; `provider_message_id` deduplica contra WhatsApp. `processing_state` registra el avance del agente (incluye `silent_completed`). Tiene índice de búsqueda de texto.

### `conversation_summaries`
Versiones del contexto resumido por conversación. `covered_through` indica hasta qué secuencia cubre; `structured_summary` es JSON. No reemplaza el historial.

### `outbound_commands`
Órdenes de envío. `state` es `pending`, `processing`, `generated`, `sending`, `sent`, `failed` o `delivery_unknown`. `source_message_id` vincula la respuesta con el mensaje que la originó; `claimed_by`, `ownership_token` y `provider_message_id` sostienen el envío y su confirmación. `delivery_unknown` no autoriza reenviar por sí solo.

### `whatsapp_sender_bindings`
Relaciona un teléfono con sus JID (`pn_jid`, `lid_jid`) dentro de una conexión. Es la identidad estable del interlocutor.

### `whatsapp_received_senders`
Une cada mensaje recibido con el teléfono vinculado que lo envió. PK `message_id`.

### `whatsapp_agenda_dialogues`
Estado conversacional del agente por `(business_id, connection_id, phone)` en JSON. Permite continuar un flujo de turno entre mensajes.

### `whatsapp_agenda_receipts`
Comprobante de una operación de agenda disparada desde WhatsApp. `outbound_id` puede ser NULL solo cuando `operation = 'silent'` (migración `0002`).

## Catálogo

### `services`
Servicio ofrecido. `duration_minutes` debe ser múltiplo de 15; `price_ars` no puede ser negativo. `deleted_at` es borrado lógico; el nombre normalizado es único por negocio entre los no borrados.

### `clients`
Cliente del negocio. `phone` en formato E.164 (`+` y hasta 15 dígitos); único por negocio. El agente puede crear clientes.

### `resources`
Profesional, sala o equipo. Tiene `weekly_schedule` en JSON validado, `status`, borrado lógico y nombre normalizado único por negocio.

### `resource_services`
Relación muchos-a-muchos entre recursos y servicios. PK `(business_id, resource_id, service_id)`.

## Agenda

### `business_calendars`
Horario semanal del negocio en `weekly_schedule` (JSON validado por `valid_business_weekly_schedule`). Uno por negocio.

### `business_calendar_closures`
Cierres por fecha (`kind = 'date'`) o por intervalo (`kind = 'interval'`). Los intervalos guardan `start_raw`/`end_raw` y milisegundos para evitar ambigüedad de zona horaria.

### `appointments`
Turno. Congela `service_label`, `resource_label`, `price_ars` y `duration_minutes` para que un cambio de catálogo no altere el historial. `state` es `confirmed`, `done`, `cancelled` o `no_show`; `origin` es `manual` o `ai`. Una exclusión GiST impide dos turnos `confirmed` superpuestos para el mismo recurso. `customer_resource_preference_id` registra una preferencia opcional.

### `appointment_operation_receipts`
Idempotencia de operaciones de turno. PK `(business_id, actor_id, operation_key)`; `kind` es `create`, `change`, `notes` o `state`; `state` es `completed`, `failed` o `cancelled`. El resultado se guarda en `result`.

## Fuera del diccionario

- `admin_business_status` es una vista, no una tabla.
- `agendia_production_migrations` es el registro del migrador.
- Las tablas del esquema `pgboss` las crea la biblioteca de colas.

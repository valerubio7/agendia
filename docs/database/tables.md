[agendIA](../../README.md) / [Documentación](../README.md) / [Base de datos](../database.md) / Diccionario

# Diccionario de tablas

**Buscá por responsabilidad, no por orden de creación.** Esta referencia cubre las tablas de producto e infraestructura declaradas en todas las [migraciones SQL](../../packages/db/migrations), incluidas registro y categorías. Explica propósito, relaciones y límites; el DDL conserva el detalle exacto de columnas, índices, permisos y restricciones.

[Acceso](#identidad-y-acceso) · [Configuración](#configuración) · [Eventos](#eventos-y-control) · [WhatsApp](#whatsapp) · [Catálogo](#catálogo) · [Agenda](#agenda)

**Convenciones:** `business_id` delimita el negocio donde corresponde; no implica que toda tabla tenga la misma política RLS. Los identificadores de entidades son UUID, pero hay PK compuestas y filas singleton. Las fechas de eventos usan `timestamptz`; la agenda también conserva entrada textual y milisegundos exactos. Ver [relaciones y excepciones](../database.md#relaciones-y-excepciones).

## Identidad y acceso

DDL: [0000 · Identidad](../../packages/db/migrations/0000_base.sql#L22-L57), [0003 · Inactividad](../../packages/db/migrations/0003_session_idle_ttl.sql), [0004 · Registro](../../packages/db/migrations/0004_registration.sql) y [0007 · Baja](../../packages/db/migrations/0007_private_business_purge.sql).

### `businesses`

Raíz del negocio. `status` distingue `active` y `suspended`; suspender no borra datos. `deleted_at` marca una baja irreversible: se conserva la fila suspendida como identidad para auditoría y barrera contra nuevas escrituras, no como negocio operable. Los eventos técnicos proyectan `last_technical_activity_at`.

### `tenant_records`

Tabla mínima para comprobar aislamiento RLS. No representa servicios, clientes ni turnos del producto.

### `pending_registrations`

Solicitud de acceso con nombre, correo normalizado y hash Argon2id. Aprobar crea negocio e identidad; aprobar o rechazar elimina la solicitud. Administración puede consultar sus datos no sensibles, no el hash. No es un historial de decisiones: estas quedan en auditoría.

### `auth_identities`

Acceso web: `business_user` exige negocio; `platform_admin` no lo tiene. Un índice parcial permite un usuario de negocio por tenant. La baja normalmente elimina su identidad; si un comprobante ajeno la referencia, queda inactiva, con correo anonimizado y sin contraseña utilizable.

### `web_sessions`

Referencia a identidad y hashes de sesión/CSRF. Vencimiento absoluto, inactividad y revocación se comprueban en la aplicación. `idle_ttl_ms` conserva la política elegida al emitir la sesión; NULL permite compatibilidad con sesiones anteriores a 0003. No guarda la credencial original.

## Configuración

DDL: [0000 · Perfil y agente](../../packages/db/migrations/0000_base.sql#L58-L73).

### `business_profiles`

Un perfil por negocio: nombre visible, descripción y dirección. Es información que el agente puede consultar; no contiene la oferta ni el calendario.

### `agent_configs`

Una configuración por negocio: activación, estilo, instrucciones y revisión. Nace inactiva. `revision` versiona cambios; las instrucciones no reemplazan las restricciones del dominio o de SQL.

## Eventos y control

DDL: [0000 · Eventos](../../packages/db/migrations/0000_base.sql#L74-L143), [admisión de login](../../packages/db/migrations/0000_base.sql#L462-L474), [0001](../../packages/db/migrations/0001_remove_admin_ai_guidance.sql) y [0004](../../packages/db/migrations/0004_registration.sql).

### `audit_events`

Historial append-only por negocio o plataforma (`business_id` NULL), con secuencia y referencias de hash. Un trigger rechaza actualizaciones y borrados. Se conserva tras la baja; su metadata puede contener datos personales. `append_runtime_audit` ofrece un conjunto acotado de eventos para roles runtime, no escritura arbitraria de auditoría global.

### `technical_events`

Diagnóstico por negocio con componente, código, severidad y `safe_details`. Insertar actualiza la última actividad técnica de la raíz. El JSON no filtra secretos automáticamente; no debe recibir cuerpos de cliente o errores crudos.

### `outbox_events`

Intención de trabajo guardada transaccionalmente: tópico, payload y clave estable única por negocio. Reclamo, intentos y próxima ejecución permiten publicar después del commit. `published_at` indica cierre de publicación; también se usa para descartar generación superada, no acredita entrega a WhatsApp.

### `inbox_events`

Deduplicación por negocio, origen y clave estable de entrada. No es el cuerpo del mensaje: ese historial vive en `messages`.

### `operational_controls`

Fila singleton: interruptor global de automatización, referencia de incidente y tiempos de respuesta inicial, activa y reinicio por inactividad. La columna `additional_instructions` ya no existe desde 0001; las instrucciones del negocio están en `agent_configs`.

### `login_throttle_global`

Presupuesto global compartido de 120 intentos por minuto, admitidos atómicamente antes del hash de contraseña. No es una tabla tenant ni una lista de sesiones.

### `login_throttle_accounts`

Presupuesto por hash del correo normalizado: 20 intentos cada 15 minutos. La admisión limpia entradas vencidas en lotes; no almacena el correo original ni garantiza limpieza inmediata al vencer.

### `registration_throttle`

Presupuesto singleton de 30 solicitudes por minuto, independiente de login. Limita admisión pública antes de crear solicitudes pendientes.

## WhatsApp

DDL: [0000 · Canal e historial](../../packages/db/migrations/0000_base.sql#L144-L260), [remitentes y agenda conversacional](../../packages/db/migrations/0000_base.sql#L419-L460) y [0002 · Silencio](../../packages/db/migrations/0002_agent_silent_completion.sql).

### `whatsapp_connections`

Una conexión por negocio. Estados: `LINK_REQUIRED`, `LINKING`, `CONNECTED`, `RECONNECTING`, `DISCONNECTED`, `ERROR`. Identifica la sesión pública, la clave de datos envuelta y su propietario mediante heartbeat y token de ownership. Estar conectado no significa que el agente esté activo.

### `whatsapp_auth_records`

Material Baileys cifrado y versionado por negocio, conexión y nombre de registro (PK compuesta). El rol manager accede al material; el worker no necesita las credenciales para conversar.

### `whatsapp_link_codes`

Secreto temporal cifrado, uno por conexión, con token único y vencimiento. La FK a conexión tiene `ON DELETE CASCADE`; no generalices esa cascada al resto del esquema.

### `conversations`

Una conversación por negocio, conexión y `remote_jid`. Ordena mensajes con `next_sequence`; `latest_inbound_id`, `reply_due_at` y fechas de intercambio coordinan ritmo y vigencia de respuestas. No es el registro de un cliente.

### `messages`

Historial de entradas y salidas, ordenado por secuencia en la conversación y deduplicado por identificador del proveedor en la conexión. `processing_state` sigue el procesamiento; incluye `superseded`, `ai_failed` y `silent_completed`. `raw_text` es legible en la base y tiene índice de búsqueda.

### `conversation_summaries`

Versiones de contexto resumido, con `covered_through` y JSON estructurado. Ayudan al agente a acotar contexto; no sustituyen el historial ni son evidencia nueva de aceptación o titularidad.

### `outbound_commands`

Órdenes de envío con texto y estados `pending`, `processing`, `generated`, `sending`, `sent`, `failed`, `delivery_unknown`. El flujo nativo guarda `generated`, reclama a `sending` y cierra según el resultado. Ownership y provider ID vinculan reclamo y cierre; `source_message_id` tiene unicidad pero no FK. `sent` refleja ACK del gateway, no lectura; `delivery_unknown` no autoriza reenviar.

### `whatsapp_sender_bindings`

Identidad estable por teléfono dentro del negocio y conexión, vinculada a JID de número (`pn_jid`) y opcionalmente LID (`lid_jid`). Proviene de evidencia validada del canal, no de texto libre ni de un teléfono elegido por la IA.

### `whatsapp_received_senders`

Une un mensaje entrante con el teléfono vinculado y su conexión. PK `message_id`; permite volver a verificar al remitente real al operar la agenda.

### `whatsapp_agenda_dialogues`

Estado JSON por negocio, conexión y teléfono: propuesta, datos pendientes y, cuando corresponde, aceptación retenida. Persiste entre mensajes; no bloquea un horario ni equivale a `appointments`.

### `whatsapp_agenda_receipts`

Comprobante por mensaje procesado para la agenda. Relaciona operación y orden de salida; desde 0002, `outbound_id` es NULL **solo** para `silent`. Una respuesta de información también puede dejar comprobante: su presencia no demuestra que se creó un turno.

## Catálogo

DDL: [0000 · Catálogo y calendario](../../packages/db/migrations/0000_base.sql#L262-L367), [0005 · Duración](../../packages/db/migrations/0005_service_duration_five_minutes.sql) y [0006 · Categorías](../../packages/db/migrations/0006_service_categories.sql).

### `services`

Oferta con descripción, duración positiva múltiplo de 5 y precio ARS no negativo y finito. Nombre normalizado único por negocio entre filas sin borrado lógico. Puede estar suspendido, tener `deleted_at` y pertenecer a una categoría opcional. No contiene las condiciones históricas de turnos ya acordados.

### `service_categories`

Agrupación de servicios del mismo negocio, añadida en 0006 y protegida por RLS forzada. La FK compuesta de `services` impide categorías ajenas. El [repositorio](../../packages/db/src/repositories/catalog.ts#L123-L129) desvincula servicios antes de borrar una categoría; no borra los servicios.

### `clients`

Nombre, apellido y teléfono E.164, único por negocio. El worker puede crear un cliente al reservar. No es una identidad de login; al leer turnos se usa su teléfono actual para verificar titularidad del remitente.

### `resources`

Capacidad asignable: persona, sala o equipo, con horario semanal JSON validado, estado y borrado lógico. Nombre normalizado único entre no borrados del negocio. La [baja lógica de catálogo](../../packages/db/src/repositories/catalog.ts#L162-L180) comprueba turnos con inicio futuro, en cualquier estado, antes de retirar servicios o recursos; no es la purga administrativa del negocio.

### `resource_services`

Habilitación muchos-a-muchos; PK `(business_id, resource_id, service_id)` y FK compuestas a recurso y servicio. La asociación no concede disponibilidad fuera de horarios ni sobre turnos ocupados.

## Agenda

DDL: [0000 · Calendario](../../packages/db/migrations/0000_base.sql#L318-L342), [turnos y comprobantes](../../packages/db/migrations/0000_base.sql#L368-L418) y [0005 · Duración](../../packages/db/migrations/0005_service_duration_five_minutes.sql).

### `business_calendars`

Horario semanal JSON, uno por negocio, validado estructuralmente por `valid_business_weekly_schedule`. La zona del motor es fija (`America/Argentina/Buenos_Aires`); no es una columna seleccionable por el agente.

### `business_calendar_closures`

Cierres de fecha completa (`date`) o intervalo (`interval`). Los intervalos conservan entrada textual y milisegundos de inicio y fin; la fecha completa usa `closed_date`. No representan ocupación por reservas.

### `appointments`

Turno con cliente, servicio, recurso asignado y preferencia opcional separada. Conserva etiquetas, precio y duración acordados. `start_raw`, `start_ms` y `end_ms` representan el intervalo; un `CHECK` exige coherencia entre duración y final numérico. La grilla de inicios de 15 minutos se valida fuera del DDL.

Estados: `confirmed`, `done`, `cancelled`, `no_show`; origen: `manual` o `ai`. GiST excluye superposición de confirmados por recurso e intervalo semiabierto. Las [reglas del dominio](../../packages/domain/src/appointments) gobiernan cambios y transiciones; no hay trigger que complete automáticamente un turno al pasar la hora.

### `appointment_operation_receipts`

Resultado idempotente del protocolo de operaciones del panel; PK `(business_id, actor_id, operation_key)`. Distingue `create`, `change`, `notes`, `state` y resultados `completed`, `failed`, `cancelled`. Fingerprint y resultado permiten recuperar la respuesta de una operación sin repetir sus efectos. `cancelled` cancela la solicitud, no el turno. La FK de actor es global, excepción relevante para la baja de identidades.

## Fuera del diccionario

- **`admin_business_status`:** vista administrativa, no tabla. Desde 0007 oculta negocios con baja.
- **`agendia_production_migrations`:** registro del migrador (archivo, checksum, fecha), creado por el [runner](../../scripts/db/db-migrate.ts), no una entidad del producto.
- **Esquema `pgboss`:** almacenamiento interno de colas mantenido por la biblioteca, no inventariado acá.

---

**Volvé → [Garantías de datos](../database.md#garantías-al-guardar)** o seguí [una reserva](../booking-journey.md) para ver cómo se usan estas tablas. [Volver al mapa](../README.md).

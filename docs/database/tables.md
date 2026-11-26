[Portada](../../README.md) / [Índice de documentación](../README.md) / [Base de datos](../database.md) / Diccionario de tablas

# Diccionario de tablas

**35 tablas de PostgreSQL, agrupadas por lo que guardan.** El nombre de cada tabla abre su definición original; debajo de cada grupo se indican los cambios de esquema relevantes. Para ver cómo encajan, consultá el [mapa del modelo](../database.md#mapa-del-modelo).

**Por tema:** [Agenda](#agenda) · [Catálogo](#catálogo) · [WhatsApp](#whatsapp) · [Identidad y acceso](#identidad-y-acceso) · [Configuración](#configuración) · [Eventos y control](#eventos-y-control)

**Saltá directo a:** [turno guardado](#appointments) · [estado de un envío](#outbound_commands) · [baja de un negocio](#businesses)

> [!NOTE]
> `business_id` indica a qué negocio pertenece un dato, pero no garantiza una política de acceso uniforme. Las claves foráneas (FK) de agenda y mensajería suelen incluirlo para impedir referencias entre negocios. Hay [excepciones](../database.md#relaciones-y-excepciones), además de claves primarias (PK) compuestas y tablas de una sola fila (singleton).

## Agenda

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="appointments"></a>[`appointments`](../../packages/db/migrations/0000_base.sql#L369-L403) | Turno con cliente, servicio, recurso asignado y preferencia opcional. Conserva los nombres, el precio y la duración acordados. | Solo los `confirmed` bloquean solapamientos por negocio y recurso. El intervalo incluye el inicio, no el final. |
| <a name="clients"></a>[`clients`](../../packages/db/migrations/0000_base.sql#L307-L317) | Ficha de cliente: nombre completo (`name`) y teléfono E.164 único por negocio. | No es una [cuenta del panel](#auth_identities). Para verificar titularidad se usa el teléfono actual. |
| <a name="business_calendars"></a>[`business_calendars`](../../packages/db/migrations/0000_base.sql#L318-L321) | Horario semanal del negocio, un JSON validado por SQL. | La zona del motor es fija (`America/Argentina/Buenos_Aires`); no se guarda en esta tabla. |
| <a name="business_calendar_closures"></a>[`business_calendar_closures`](../../packages/db/migrations/0000_base.sql#L323-L342) | Cierre de día completo (`closed_date`) o intervalo con texto original y milisegundos exactos. | Un cierre bloquea disponibilidad sin ser un turno. |
| <a name="appointment_operation_receipts"></a>[`appointment_operation_receipts`](../../packages/db/migrations/0000_base.sql#L404-L418) | Huella y resultado para reintentar operaciones del panel (`create`, `change`, `notes`, `state`) sin repetir efectos. PK `(business_id, actor_id, operation_key)`. | `completed`, `failed` y `cancelled` describen la operación, no el turno. `actor_id` es una FK global a [identidades](#auth_identities); `target_id` no es una FK. |

**Reglas del turno:** los estados son `confirmed`, `done`, `cancelled` y `no_show`; el origen es `manual` o `ai`. SQL comprueba que `end_ms` coincida con `start_ms` más la duración; `start_raw` conserva el texto de entrada. La [lógica de agenda](../../packages/domain/src/appointments) valida la grilla de inicio de 15 minutos y las transiciones. No hay un trigger que complete turnos al pasar la hora.

**Cambios de esquema:** [0005 · Duraciones en múltiplos de 5 min](../../packages/db/migrations/0005_service_duration_five_minutes.sql), tanto en turnos como en servicios; [0009 · Nombre completo del cliente](../../packages/db/migrations/0009_client_name.sql), que une nombre y apellido, elimina espacios repetidos de los datos migrados y conserva identificadores, teléfonos y relaciones.

## Catálogo

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="services"></a>[`services`](../../packages/db/migrations/0000_base.sql#L289-L306) | Oferta, duración positiva en múltiplos de 5 min, precio ARS finito y no negativo, y categoría opcional. | Cambiar el catálogo no reescribe las condiciones de un [turno guardado](#appointments). |
| <a name="service_categories"></a>[`service_categories`](../../packages/db/migrations/0006_service_categories.sql#L1-L12) | Agrupación de servicios por negocio, con aislamiento por fila (RLS) forzado. | La FK compuesta impide categorías ajenas. El [repositorio](../../packages/db/src/repositories/catalog.ts#L123-L129) desvincula los servicios antes de borrar la categoría. |
| <a name="resources"></a>[`resources`](../../packages/db/migrations/0000_base.sql#L344-L359) | Capacidad asignable (persona, sala o equipo), estado y horario semanal JSON validado. | Su horario complementa al [del negocio](#business_calendars). |
| <a name="resource_services"></a>[`resource_services`](../../packages/db/migrations/0000_base.sql#L360-L367) | Qué recursos pueden atender qué servicios. PK `(business_id, resource_id, service_id)`. | Las FK compuestas exigen que ambos pertenezcan al negocio. Estar habilitado no equivale a estar disponible. |

**Retiro de catálogo:** servicios y recursos pueden suspenderse o marcarse con `deleted_at`. Los nombres normalizados son únicos por negocio entre filas sin borrado lógico. Para retirar una fila, el [repositorio](../../packages/db/src/repositories/catalog.ts#L162-L180) comprueba turnos con inicio futuro en cualquier estado, no solo confirmados.

**Cambios de esquema:** [0005 · Duración de servicios](../../packages/db/migrations/0005_service_duration_five_minutes.sql) y [0006 · FK de categoría](../../packages/db/migrations/0006_service_categories.sql#L14-L16).

## WhatsApp

### Conexión y credenciales

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="whatsapp_connections"></a>[`whatsapp_connections`](../../packages/db/migrations/0000_base.sql#L145-L164) | Una conexión por negocio: estado, ID público de sesión, clave de datos envuelta y datos de propiedad (`heartbeat_at`, `ownership_token`). | `CONNECTED` describe al canal, no si el [agente](#agent_configs) está habilitado. |
| <a name="whatsapp_auth_records"></a>[`whatsapp_auth_records`](../../packages/db/migrations/0000_base.sql#L165-L175) | Credenciales Baileys cifradas y versionadas. PK `(business_id, connection_id, record_name)`. | Acceso del gestor del canal, no del proceso que genera respuestas. |
| <a name="whatsapp_link_codes"></a>[`whatsapp_link_codes`](../../packages/db/migrations/0000_base.sql#L176-L187) | Secreto temporal cifrado, uno por conexión, con token único y vencimiento. | Se borra en cascada al borrar la conexión; no es una regla general del esquema. |

### Historial y entrega

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="conversations"></a>[`conversations`](../../packages/db/migrations/0000_base.sql#L188-L202) | Un hilo por negocio, conexión y `remote_jid`; secuencia y plazos de respuesta. | Agrupa mensajes, no identifica al cliente. |
| <a name="messages"></a>[`messages`](../../packages/db/migrations/0000_base.sql#L203-L222) | Mensajes de entrada y salida, ordenados por secuencia y deduplicados por ID del proveedor dentro de la conexión. | `raw_text` es legible e indexado para búsqueda. `processing_state` sigue el procesamiento, no la entrega al cliente. |
| <a name="conversation_summaries"></a>[`conversation_summaries`](../../packages/db/migrations/0000_base.sql#L223-L234) | Contexto JSON versionado; `covered_through` indica hasta qué secuencia llega. | No reemplaza el historial ni prueba aceptación o titularidad. |
| <a name="outbound_commands"></a>[`outbound_commands`](../../packages/db/migrations/0000_base.sql#L235-L260) | Orden de envío con texto, estado, reclamo e ID de proveedor. `source_message_id` es único cuando existe, pero no es una FK. | `sent` confirma el acuse del canal, no la lectura. `delivery_unknown` no autoriza reenviar. |

### Remitente y contexto de agenda

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="whatsapp_sender_bindings"></a>[`whatsapp_sender_bindings`](../../packages/db/migrations/0000_base.sql#L419-L430) | Vínculo entre teléfono, `pn_jid` y `lid_jid` opcional, por negocio y conexión. | Sale de evidencia validada del canal, no de texto libre ni de un número elegido por la IA. |
| <a name="whatsapp_received_senders"></a>[`whatsapp_received_senders`](../../packages/db/migrations/0000_base.sql#L431-L440) | Remitente vinculado de un mensaje entrante. PK `message_id`. | Permite volver a verificar quién escribió antes de operar en la agenda. |
| <a name="whatsapp_agenda_dialogues"></a>[`whatsapp_agenda_dialogues`](../../packages/db/migrations/0000_base.sql#L441-L451) | Propuesta, datos pendientes y aceptación retenida, en JSON por negocio, conexión y teléfono. | Una propuesta no bloquea un horario ni equivale a un [turno](#appointments). |
| <a name="whatsapp_agenda_receipts"></a>[`whatsapp_agenda_receipts`](../../packages/db/migrations/0000_base.sql#L452-L460) | Comprobante de operación de agenda por mensaje, con FK a la orden de salida. | `outbound_id` es `NULL` si y solo si la operación es `silent`. Una consulta informativa también puede dejar comprobante. |

**Cambio de esquema:** [0002 · Comprobante sin salida](../../packages/db/migrations/0002_agent_silent_completion.sql).

## Identidad y acceso

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="businesses"></a>[`businesses`](../../packages/db/migrations/0000_base.sql#L23-L29) | Identidad del negocio, estado (`active` o `suspended`) y última actividad técnica. | Suspender no borra datos. La baja irreversible (`deleted_at`) conserva la fila suspendida para auditoría y bloquea nuevas escrituras del negocio. |
| <a name="auth_identities"></a>[`auth_identities`](../../packages/db/migrations/0000_base.sql#L36-L46) | Cuenta web: un `business_user` por negocio como máximo; `platform_admin` no pertenece a un negocio. | La baja borra la cuenta, salvo si un [comprobante](#appointment_operation_receipts) ajeno la referencia: queda inactiva, anonimizada y sin contraseña utilizable. |
| <a name="web_sessions"></a>[`web_sessions`](../../packages/db/migrations/0000_base.sql#L47-L57) | Sesiones por identidad: hashes de sesión y CSRF, vencimientos y revocación; no los tokens originales. | `idle_ttl_ms` fija la política de inactividad al emitir la sesión. `NULL` conserva el comportamiento de sesiones anteriores a 0003. |
| <a name="pending_registrations"></a>[`pending_registrations`](../../packages/db/migrations/0004_registration.sql#L4-L12) | Solicitud de alta con nombre, correo normalizado y hash Argon2id, no visible para administración. | Aprobar crea negocio y cuenta; tanto aprobar como rechazar elimina la solicitud. La decisión queda en [auditoría](#audit_events). |
| <a name="tenant_records"></a>[`tenant_records`](../../packages/db/migrations/0000_base.sql#L30-L35) | Datos mínimos para comprobar el aislamiento por fila (RLS). | No guarda información de catálogo, clientes ni turnos. |

### Límites de ingreso

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="login_throttle_global"></a>[`login_throttle_global`](../../packages/db/migrations/0000_base.sql#L463-L468) | Contador de una sola fila: 120 intentos de ingreso por minuto. | Compartido por todas las cuentas; se aplica antes de verificar la contraseña. |
| <a name="login_throttle_accounts"></a>[`login_throttle_accounts`](../../packages/db/migrations/0000_base.sql#L469-L474) | Hasta 20 intentos cada 15 min por hash del correo normalizado. | No guarda el correo. La admisión limpia vencidos en lotes, no necesariamente al vencer. |
| <a name="registration_throttle"></a>[`registration_throttle`](../../packages/db/migrations/0004_registration.sql#L1-L3) | Contador de una sola fila: 30 solicitudes de alta por minuto. | Es independiente del presupuesto de inicio de sesión. |

**Cambios de esquema:** [0003 · Inactividad de sesión](../../packages/db/migrations/0003_session_idle_ttl.sql), [0007 · Baja de negocio](../../packages/db/migrations/0007_private_business_purge.sql) y [0008 · Código SQL al rechazar cambios de negocio](../../packages/db/migrations/0008_ownership_sqlstate.sql).

## Configuración

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="business_profiles"></a>[`business_profiles`](../../packages/db/migrations/0000_base.sql#L58-L64) | Nombre visible, descripción y dirección que puede consultar el agente. | Un perfil por negocio; no contiene oferta ni horarios. |
| <a name="agent_configs"></a>[`agent_configs`](../../packages/db/migrations/0000_base.sql#L65-L73) | Activación, estilo, instrucciones y revisión del agente. | Una fila por negocio, inactiva al nacer. Sus instrucciones no reemplazan las reglas de agenda. |
| <a name="operational_controls"></a>[`operational_controls`](../../packages/db/migrations/0000_base.sql#L131-L143) | Interruptor global de automatización, referencia de incidente y demoras de respuesta y reinicio. | Una sola fila para toda la plataforma. Las instrucciones pertenecen a `agent_configs`. |

**Cambio de esquema:** [0001 · Eliminación de `additional_instructions`](../../packages/db/migrations/0001_remove_admin_ai_guidance.sql) de los controles globales.

## Eventos y control

| Tabla · DDL | Qué guarda | Relación o límite |
| --- | --- | --- |
| <a name="audit_events"></a>[`audit_events`](../../packages/db/migrations/0000_base.sql#L75-L93) | Historial con secuencia y hashes, por negocio o plataforma (`business_id` nulo). | Un trigger impide editar o borrar filas. Se conserva tras la baja y puede contener datos personales. |
| <a name="technical_events"></a>[`technical_events`](../../packages/db/migrations/0000_base.sql#L94-L103) | Diagnóstico por negocio: componente, código, severidad y `safe_details`. | Al insertar se actualiza `last_technical_activity_at` del negocio. `safe_details` no filtra secretos automáticamente. |
| <a name="outbox_events"></a>[`outbox_events`](../../packages/db/migrations/0000_base.sql#L104-L121) | Trabajo pendiente guardado en la misma transacción, con clave estable por negocio, reclamo y reintentos. | `published_at` cierra la publicación o marca el descarte de trabajo superado; no acredita entrega por WhatsApp. |
| <a name="inbox_events"></a>[`inbox_events`](../../packages/db/migrations/0000_base.sql#L122-L130) | Claves de deduplicación por negocio, origen y entrada. | El cuerpo del mensaje está en [`messages`](#messages), no acá. |

**Permiso de escritura:** [`append_runtime_audit`](../../packages/db/migrations/0004_registration.sql#L42-L66) admite un conjunto acotado de eventos, no escritura arbitraria en la auditoría de plataforma.

## Fuera del diccionario

- **`admin_business_status`:** [vista administrativa](../../packages/db/migrations/0007_private_business_purge.sql#L167-L171) que excluye negocios dados de baja.
- **`agendia_production_migrations`:** registro de archivo, checksum y fecha creado por el [migrador](../../scripts/db/db-migrate.ts); no está declarado en las migraciones SQL.
- **Esquema `pgboss`:** almacenamiento interno de colas mantenido por la biblioteca.

---

[Volver al índice](../README.md) · [Garantías al guardar](../database.md#garantías-al-guardar)

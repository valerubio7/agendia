[agendIA](../README.md) / [Documentación](README.md) / Base de datos

# Base de datos

**PostgreSQL guarda lo acordado y el trabajo pendiente, no solo un calendario.** Un turno conserva sus condiciones; una conversación conserva contexto; una orden de envío conserva el estado de entrega. Mezclar esas tres cosas lleva a duplicar reservas o a anunciar operaciones que no se confirmaron.

Las [migraciones SQL](../packages/db/migrations) son la autoridad del modelo. Esta guía describe el árbol del repositorio, **no verifica una base en ejecución**. [`schema.ts`](../packages/db/src/schema.ts) solo declara tres tablas y no representa todo el esquema ni todos sus cambios.

## Cómo leer

- **Entender una escritura:** [recorrido de reserva](booking-journey.md).
- **Entender relaciones y garantías:** esta página.
- **Consultar una tabla:** [diccionario](database/tables.md), con enlaces al DDL por área.

## Modelo en pocas palabras

Pensá los datos en tres capas:

| Capa | Pregunta que responde | Referencia |
| --- | --- | --- |
| Configuración actual | ¿Qué ofrece el negocio y cuándo puede atender? | [Catálogo](database/tables.md#catálogo), [calendario](database/tables.md#agenda), perfil y agente. |
| Acuerdos y contexto | ¿Quién reservó qué? ¿Qué quedó pendiente en la conversación? | `appointments`, `clients`, `whatsapp_agenda_dialogues`, mensajes y resúmenes. |
| Coordinación y evidencia | ¿Qué falta procesar o enviar? ¿Qué operación ya terminó? | Outbox/inbox, `outbound_commands`, comprobantes y auditoría. |

El **negocio** es la unidad de aislamiento: `business_id` acompaña los datos propios. La identidad del panel no es el cliente de WhatsApp, y un comprobante de operación no es un turno.

## Relaciones

No necesitás memorizar todas las columnas para seguir una reserva:

- `appointments` une **cliente, servicio y recurso** del mismo negocio. Guarda etiquetas, precio y duración como copia de las condiciones acordadas; no reconstruye el pasado leyendo el catálogo actual.
- `resource_services` habilita servicios para cada recurso. `services.category_id` agrupa el catálogo sin alterar la capacidad de atención.
- `business_calendars` y `business_calendar_closures` delimitan atención; cada recurso aporta además su horario propio. La validación de disponibilidad cruza estos datos con turnos confirmados.
- Una `whatsapp_connections` agrupa conversaciones; cada conversación ordena mensajes, resúmenes y órdenes de salida. Los bindings vinculan remitente, teléfono y conexión; el diálogo pendiente no reserva capacidad.

**Integridad física frente a relación lógica:** las FK de agenda y mensajería usan normalmente `(business_id, id)` para impedir referencias a entidades de otro negocio. No todas siguen ese patrón: `outbound_commands.source_message_id` es una referencia lógica con índice único, no una FK; `appointment_operation_receipts.actor_id` referencia globalmente a `auth_identities`; `audit_events.business_id` puede ser NULL para la plataforma. No deduzcas una garantía SQL solo por el nombre de una columna.

## Garantías al guardar

| Regla | Dónde se sostiene | Qué no demuestra |
| --- | --- | --- |
| No superponer turnos confirmados de un recurso | Exclusión GiST sobre negocio, recurso e intervalo `[inicio, fin)` en [0000](../packages/db/migrations/0000_base.sql). | Horarios de atención, anticipación o aceptación: se validan en dominio/repositorios. |
| Conservar condiciones acordadas | Copia en `appointments`; [reglas de cambios](../packages/domain/src/appointments/changes.ts). | Que un servicio siga activo hoy. |
| Duración positiva en múltiplos de 5 minutos | `CHECK` actualizado por [0005](../packages/db/migrations/0005_service_duration_five_minutes.sql). | Que el inicio sea seleccionable: la grilla de 15 minutos se aplica en el motor de agenda. |
| Mutación, auditoría y trabajo pendiente coherentes | [Unit of work HTTP](../packages/db/src/unit-of-work.ts) y [sesión de agenda WhatsApp](../apps/message-worker/src/agent/adapters/agenda.ts). | Que el proveedor externo haya recibido la respuesta. |
| Reintentos de operaciones del panel | Comprobante por negocio, actor y clave de operación, con fingerprint y resultado. | Idempotencia de cualquier mensaje externo o de cualquier petición sin ese protocolo. |

Los intervalos semiabiertos permiten terminar un turno donde empieza el siguiente. El [repositorio](../packages/db/src/repositories/appointments.ts) serializa operaciones con el lock del calendario y vuelve a comprobar estado, reglas y ocupación; la exclusión sigue siendo una barrera para escritores SQL directos.

## Aislamiento y roles

**RLS, permisos y autorización se complementan.** Las tablas de negocio usan `ENABLE` y `FORCE ROW LEVEL SECURITY`; `service_categories` se suma en 0006. Las globales —negocios, identidades, sesiones, controles y admisión de login/registro— dependen de ACL, funciones y verificaciones explícitas, no de una política tenant uniforme.

| Rol de capacidad | Uso principal |
| --- | --- |
| `agendia_runtime` | Operaciones del panel del negocio. |
| `agendia_admin_runtime` | Administración de plataforma, con accesos acotados. |
| `agendia_whatsapp_runtime` | Conexiones, credenciales, ingesta y entrega de WhatsApp. |
| `agendia_worker_runtime` | Contexto, herramientas de agenda, generación y resúmenes. |

Son roles `NOLOGIN` y `NOBYPASSRLS`, no usuarios finales. Los logins de conexión se [provisionan por capacidad](../scripts/db/provision-production-db.ts); el manager tiene también membresía de worker para su uso de colas. [`RolePool.run`](../packages/db/src/runtime-pools.ts) activa el rol y publica contexto transaccional local (`app.tenant_id`, actor y request).

Funciones de capacidad como `route_whatsapp_session` y `claim_owned_outbound` usan `SECURITY DEFINER` para enrutar sesiones o reclamar trabajo; su ejecución se revoca de `PUBLIC`. Eso no las convierte en endpoints de uso libre. Administración puede leer datos no sensibles de solicitudes pendientes, pero no su hash de contraseña. Hay un solo `business_user` por negocio mediante índice parcial; la unicidad del administrador la controla el bootstrap, no la tabla.

RLS no es cifrado ni protege frente a superusuarios. Para comprobar el aislamiento al desarrollar, consultá [las pruebas RLS](../tests/integration/tenant-rls.integration.test.ts) y [las de esquema y permisos](../tests/integration/database-schema.integration.test.ts).

## Migraciones

El modelo surge de **todo el historial**, no de ejecutar solo la base inicial:

| Archivo | Cambio que importa al leer los datos |
| --- | --- |
| [0000 · Base](../packages/db/migrations/0000_base.sql) | Tablas iniciales, roles, RLS, funciones, triggers, vista administrativa, extensión `btree_gist` y esquema `pgboss`. |
| [0001 · Instrucciones globales](../packages/db/migrations/0001_remove_admin_ai_guidance.sql) | Elimina irreversiblemente `operational_controls.additional_instructions`. |
| [0002 · Silencio del agente](../packages/db/migrations/0002_agent_silent_completion.sql) | Comprobante sin salida solo cuando `operation = 'silent'`. |
| [0003 · Inactividad](../packages/db/migrations/0003_session_idle_ttl.sql) | Agrega `web_sessions.idle_ttl_ms`; NULL conserva la política anterior. |
| [0004 · Registro](../packages/db/migrations/0004_registration.sql) | Solicitudes pendientes, presupuesto de registro y funciones de admisión/decisión. |
| [0005 · Duración](../packages/db/migrations/0005_service_duration_five_minutes.sql) | Cambia múltiplos de 15 a 5 minutos en servicio y turno; no cambia la grilla de inicios. |
| [0006 · Categorías](../packages/db/migrations/0006_service_categories.sql) | Agrega `service_categories`, su RLS y la FK tenant de `services.category_id`. |
| [0007 · Baja privada](../packages/db/migrations/0007_private_business_purge.sql) | Marca irreversible, purga acotada, barreras de escritura y admisión de envío. |
| [0008 · Ownership](../packages/db/migrations/0008_ownership_sqlstate.sql) | Conserva SQLSTATE `42501` al intentar cambiar la pertenencia de una fila. |

El [migrador](../scripts/db/db-migrate.ts) ordena archivos `.sql`, calcula SHA-256 y valida **todo** el historial registrado antes de ejecutar pendientes. Rechaza archivos aplicados modificados o ausentes y una base inicializada sin historial válido. Mantiene `agendia_production_migrations`, separado del modelo de producto.

No edites archivos ya aplicados ni trates `schema.ts` como sustituto del historial. Desarrollo y despliegue usan el mismo migrador; los comandos y la compatibilidad entre versiones corresponden a [Desarrollo](DEVELOPMENT.md#migraciones) y [Operaciones](OPERATIONS.md). Las tablas internas de `pgboss` las administra la biblioteca.

### Baja de negocios

La baja no es un `DELETE` aislado sobre `businesses`. `delete_business` exige administración con sesión vigente, bloquea la raíz del negocio y confirma purga, auditoría y marca irreversible juntas. Conserva identidad de negocio y auditoría; elimina datos activos y sesiones. Una identidad referenciada desde otro negocio puede permanecer anonimizada e inactiva. No invoques `purge_business_data_private` como operación manual.

Los triggers rechazan escrituras tras la baja; la función usa un rol privado `agendia_business_purge` sin login ni BYPASSRLS, con permisos y políticas específicos. Ese rol no se entrega a la aplicación. Los jobs de `pgboss`, copias anteriores y mensajes ya enviados no se purgan con estos datos. Ver [la frontera y los límites de envío](ARCHITECTURE.md#baja-de-negocios) antes de interpretar «baja» como borrado de todo rastro.

## Datos sensibles

| Dato | Tratamiento real |
| --- | --- |
| Contraseña | Hash Argon2id en `password_phc`; no es cifrado reversible. |
| Sesión y CSRF | Hash SHA-256 almacenado; no el token original de sesión. |
| Credenciales de WhatsApp | [AES-256-GCM](../packages/whatsapp-baileys/src/auth-store.ts), con clave de datos envuelta por clave de cifrado. |
| Código de vinculación | Cifrado, temporal; se elimina al consumirlo o limpiarlo, reemplazarlo o borrar su conexión. |
| Mensajes y resúmenes | Texto/JSON legible en la base; sin cifrado de aplicación. |
| Auditoría y diagnóstico | Pueden contener datos personales; el nombre `safe_details` no aplica un filtro automático. |

No copies textos reales, tokens, códigos ni credenciales a ejemplos, logs o capturas. Cifrado de disco, copias y retención son decisiones de despliegue, no garantías de este esquema.

## Para profundizar

**Continuá → [Diccionario de tablas](database/tables.md)** para ubicar una entidad. Para entender quién escribe, volvé a [Arquitectura](ARCHITECTURE.md); para separar commit y entrega, al [recorrido de reserva](booking-journey.md). [Volver al mapa](README.md).

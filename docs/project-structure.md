# Dónde cambiar cada comportamiento

Para trabajar en agendIA, empezá por la capacidad que querés cambiar, no por el tamaño de un archivo. La interfaz vive en las features web; las reglas, en el dominio; los contratos HTTP, en contracts; y la persistencia, detrás de los repositorios. Esta guía describe la estructura actual y los límites que conviene conservar.

## Ruta rápida

1. Ubicá la capacidad en la tabla web o en el mapa del agente.
2. Si cambia lo observable por HTTP, revisá contrato, cliente y ruta; si cambia una regla, revisá dominio y persistencia.
3. Buscá las pruebas del mismo dueño y las pruebas centrales que cruzan esas capas. No hace falta modificar todas las capas en cada cambio.

## Carpetas y procesos

| Ubicación | Responsabilidad |
| --- | --- |
| [apps/](../apps/) | Composición de los procesos: API, web, message-worker y whatsapp-manager. |
| [packages/](../packages/) | Dominio, contratos, autenticación, persistencia y adaptadores compartidos. |
| [scripts/](../scripts/) | Herramientas de desarrollo y base de datos, agrupadas en `dev` y `db`. |
| [tests/](../tests/) | Pruebas que cruzan dueños y soporte común; no reemplaza las unitarias junto al código. |
| [.github/](../.github/) | Workflows de CI y publicación del release (imagen OCI en GHCR). |
| [docs/](./) | Guías vigentes para mantenimiento, incluido este documento. |

Los cuatro procesos tienen responsabilidades distintas:

- **API:** [app.ts](../apps/api/src/app.ts) compone Fastify, autenticación, contexto de tenant, escrituras y registro de rutas. [index.ts](../apps/api/src/index.ts) es su entrada.
- **Web:** [apps/web/app/](../apps/web/app/) contiene las entradas de Next; [apps/web/src/](../apps/web/src/) contiene la implementación de la interfaz.
- **message-worker:** [index.ts](../apps/message-worker/src/index.ts) conecta las colas `ai-generate` y `conversation-summary` con sus procesadores y el proveedor de IA.
- **whatsapp-manager:** [index.ts](../apps/whatsapp-manager/src/index.ts) compone conexión, recepción, despacho de trabajos de IA y salida de mensajes. Sus módulos [connection.ts](../apps/whatsapp-manager/src/connection.ts), [inbound.ts](../apps/whatsapp-manager/src/inbound.ts), [ai-outbox.ts](../apps/whatsapp-manager/src/ai-outbox.ts) y [outbound.ts](../apps/whatsapp-manager/src/outbound.ts) separan esas tareas.

## Web: rutas finas, features por capacidad

Las páginas de [Next](../apps/web/app/) seleccionan el modo de `LivePanel`; no son el lugar para concentrar reglas o pantallas. Los grupos `(business)` y `(admin)` organizan archivos sin formar parte de la URL.

| Capacidad en `apps/web/src/features/` | Entrada web | Qué buscar allí |
| --- | --- | --- |
| [auth](../apps/web/src/features/auth/) | `/` | Pantalla de ingreso. |
| [appointments](../apps/web/src/features/appointments/) | `/turnos` | Agenda visual, reserva manual, detalle y auxiliares de calendario. |
| [clients](../apps/web/src/features/clients/) | `/clients` | Registro de clientes e historial asociado. |
| [services](../apps/web/src/features/services/) | `/services` | Edición y ciclo de vida del catálogo de servicios. |
| [resources](../apps/web/src/features/resources/) | `/resources` | Recursos, asignaciones de servicios y horarios. |
| [business-calendar](../apps/web/src/features/business-calendar/) | `/business-calendar` | Horario del negocio y cierres. |
| [business-profile](../apps/web/src/features/business-profile/) | `/profile` | Perfil público del negocio. |
| [agent-settings](../apps/web/src/features/agent-settings/) | `/assistant` | Configuración del asistente y presentación de sus datos. |
| [whatsapp](../apps/web/src/features/whatsapp/) | `/whatsapp` | Estado de conexión, vinculación y representación del QR. |
| [administration](../apps/web/src/features/administration/) | `/businesses` | Negocios e instrucciones globales de IA. |

Antes de extraer estado de una pantalla, identificá quién controla su vigencia:

- [shell/live-panel.tsx](../apps/web/src/shell/live-panel.tsx) coordina sesión, acceso por rol, carga compartida, mutaciones y recuperación. Conserva generaciones de solicitudes, invalidación y cancelación al cambiar de modo o desmontar; las features también pueden tener estado y solicitudes propios.
- [shell/authenticated-shell.tsx](../apps/web/src/shell/authenticated-shell.tsx) contiene navegación, marco autenticado y estados terminales. No reemplaza la autorización del servidor.
- Las pantallas de turnos y clientes reciben la vigencia de sesión desde el shell. Al mover lógica, conservá ese dueño y sus señales: no permitas que una respuesta de una sesión anterior actualice otra.
- [components/](../apps/web/src/components/) reúne componentes compartidos, como marca y editor de horario. [app/styles.css](../apps/web/app/styles.css) contiene los estilos comunes.
- [api/api-client.ts](../apps/web/src/api/api-client.ts) concentra transporte HTTP del navegador, DTO, errores, CSRF y seguimiento de operaciones de turnos. Reutilizalo sin cambiar la forma de los cuerpos ni convertir un refresco fallido en repetición de una mutación confirmada.

## Paquetes: reglas, contratos y adaptadores

El inventario de paquetes de [package.json](../package.json) se organiza así:

| Paquete | Dueño de |
| --- | --- |
| [@agendia/domain](../packages/domain/) | Reglas y valores del negocio, contratos de proveedor y de unidad de trabajo. |
| [@agendia/contracts](../packages/contracts/) | Esquemas y tipos públicos HTTP y de eventos. |
| [@agendia/auth](../packages/auth/) | Primitivas de contraseña, sesión, tokens y protección de mutaciones; incluye el servicio en memoria existente. |
| [@agendia/db](../packages/db/) | Repositorios PostgreSQL, roles, contexto de tenant, unidad de trabajo, esquema y migraciones. |
| [@agendia/ai-deepseek](../packages/ai-deepseek/) | Adaptación del protocolo de IA y resumen conversacional al proveedor DeepSeek. |
| [@agendia/whatsapp-baileys](../packages/whatsapp-baileys/) | Gateway Baileys y almacenamiento/adaptación de su autenticación. |

Los adaptadores traducen protocolos e integran infraestructura; no son un lugar nuevo para decidir políticas de turnos. Tampoco hace falta introducir un framework o una capa genérica para agregar una capacidad.

### Dominio y superficie pública

En [domain/src/](../packages/domain/src/), `appointments/` separa disponibilidad, cambios y ciclo de vida; `business-calendar/`, calendario y valores temporales; `agent/`, configuración, proveedor e instrucciones; `messaging/`, contexto, entrega y ritmo de respuesta; y `whatsapp/`, conexión y diálogo de agenda. Administración, perfil, clientes, recursos y servicios conservan sus módulos propios.

El [barrel público](../packages/domain/src/index.ts) reúne las exportaciones. Además, el [manifiesto del paquete](../packages/domain/package.json) declara los subpaths `client-registry`, `calendar-values`, `appointment-lifecycle`, `business-calendar`, `agenda-availability` y `resource-catalog`. Revisá esa superficie antes de cambiar imports o mover símbolos: la organización interna no autoriza romper sus consumidores.

En contracts, [src/index.ts](../packages/contracts/src/index.ts) exporta eventos y [http.ts](../packages/contracts/src/http.ts). Este último mantiene rutas, errores y documentación OpenAPI, además de reexportar las capacidades de [http/](../packages/contracts/src/http/): appointments, resources, business-calendar y agent-settings. No todo contrato tiene un archivo separado; comprobá el barrel antes de crear otro.

### API y autenticación HTTP

Buscá el handler en [api/src/routes/](../apps/api/src/routes/), por la misma capacidad. [routes/context.ts](../apps/api/src/routes/context.ts) define los tipos de contexto que reciben los registradores. La composición y los helpers compartidos de escritura siguen en [app.ts](../apps/api/src/app.ts).

[auth/http-auth.ts](../apps/api/src/auth/http-auth.ts) resuelve sesión y protección de mutaciones; [auth/legacy-api.ts](../apps/api/src/auth/legacy-api.ts) conserva la variante compatible con `AuthService`. Mover un handler no debe cambiar cookies, Origin, CSRF, roles, códigos de estado ni errores públicos.

## Agente: dónde revisar cada decisión

El punto de entrada de trabajos es [jobs/ai-job.ts](../apps/message-worker/src/jobs/ai-job.ts): procesa generación y resúmenes, carga datos y coordina su ejecución. El comportamiento conversacional está separado en [agent/](../apps/message-worker/src/agent/):

| Archivo | Responsabilidad |
| --- | --- |
| [context.ts](../apps/message-worker/src/agent/context.ts) | Armar mensajes con configuración, historial, resumen y grupo actual dentro del presupuesto. |
| [limits.ts](../apps/message-worker/src/agent/limits.ts) | Presupuesto de solicitud y cálculo de bytes. |
| [runtime.ts](../apps/message-worker/src/agent/runtime.ts) | Bucle del proveedor, rondas, llamadas, tiempo y cancelación de la sesión. |
| [tools.ts](../apps/message-worker/src/agent/tools.ts) | Definiciones y validación de herramientas, ejecución serializada, evidencia y vigencia de sesión. |
| [response.ts](../apps/message-worker/src/agent/response.ts) | Interpretar el formato de respuesta y representar hechos de herramientas; validar su forma no prueba la verdad de la prosa. |
| [adapters/agenda.ts](../apps/message-worker/src/agent/adapters/agenda.ts) | Conectar herramientas con repositorios y diálogo; mantener transacción, guardas y persistencia de acciones y respuesta. |

Las instrucciones canónicas viven en [domain/src/agent/instructions.ts](../packages/domain/src/agent/instructions.ts), no en el adaptador del proveedor. Configuración del negocio, instrucciones adicionales, historial y texto recibido son datos: no sustituyen esa autoridad ni las comprobaciones del backend. Los contratos del proveedor están en [agent/provider.ts](../packages/domain/src/agent/provider.ts).

`Assistant`, las rutas `/assistant` y `/me/assistant`, y los nombres `RECEPTIONIST_*` existentes son compatibilidad pública o interna vigente, no una lista de renombres pendientes. Una propuesta de herramienta no equivale a una acción persistida; respetá la sesión y su dueño transaccional. Las referencias de procedencia no prueban consentimiento semántico del cliente.

## Persistencia: fachada y capacidades

La entrada pública de db es [src/index.ts](../packages/db/src/index.ts). [repositories.ts](../packages/db/src/repositories.ts) conserva `PostgresRepositories`, firmas, errores y reexportaciones; delega operaciones a [repositories/](../packages/db/src/repositories/), pasando el `db` y, cuando corresponde, la fachada original.

| Módulo de repositorios | Responsabilidad |
| --- | --- |
| [identity.ts](../packages/db/src/repositories/identity.ts) | Identidades, admisión de login y sesiones. |
| [business.ts](../packages/db/src/repositories/business.ts) | Administración de negocios, usuarios del negocio y perfil. |
| [clients.ts](../packages/db/src/repositories/clients.ts) | Registro y búsqueda de clientes. |
| [catalog.ts](../packages/db/src/repositories/catalog.ts) | Servicios, recursos, asignaciones, estados y retiro del catálogo. |
| [business-calendar.ts](../packages/db/src/repositories/business-calendar.ts) | Horario del negocio y cierres. |
| [appointments.ts](../packages/db/src/repositories/appointments.ts) | Lecturas, disponibilidad, creación, cambios, notas y estados de turnos. |
| [agent-settings.ts](../packages/db/src/repositories/agent-settings.ts) | Configuración del asistente, instrucciones globales y ritmo de respuesta. |
| [whatsapp.ts](../packages/db/src/repositories/whatsapp.ts) | Conexión, autenticación persistida, vinculación y propiedad de la conexión. |
| [whatsapp-agenda.ts](../packages/db/src/repositories/whatsapp-agenda.ts) | Remitente, diálogo, procedencia, recibos de agenda y preferencia. |
| [messaging.ts](../packages/db/src/repositories/messaging.ts) | Entrada de mensajes, contexto de IA, resúmenes, generación y entrega saliente. |
| [events.ts](../packages/db/src/repositories/events.ts) | Inbox, outbox, despacho y auditoría. |
| [shared.ts](../packages/db/src/repositories/shared.ts) | Tipos y normalización compartida, incluido `asDbJson`. |

**No todo el SQL está en las capacidades.** La raíz `repositories.ts` conserva recibos de operaciones de turnos, savepoints, bloqueo de calendario, utilidades criptográficas de vinculación y métodos de inspección como `tenantSnapshot`, `conversationTexts` y `authRecordNames`. El import raíz de `asDbJson` sigue siendo necesario para `recordAppointmentOperation`; no es un import sobrante.

[runtime-pools.ts](../packages/db/src/runtime-pools.ts) es dueño de `RolePool`, roles y transacciones con contexto local. [tenant-context.ts](../packages/db/src/tenant-context.ts) construye el contexto derivado del servidor. [unit-of-work.ts](../packages/db/src/unit-of-work.ts) coordina mutación, auditoría, outbox y el protocolo opcional de recibos de operaciones. [schema.ts](../packages/db/src/schema.ts) y [migrations/](../packages/db/migrations/) son las referencias del modelo persistido.

Al extender una capacidad, conservá el `db`/`tx` original y el receptor público de la fachada en llamadas cruzadas. No abras otra transacción para reemplazar esa coordinación: preservá orden y alcance de locks, recibos, savepoints y atomicidad de auditoría/outbox. El aislamiento por tenant depende del contexto y de RLS, no del hash de un lock ni de un ID enviado por el navegador o el modelo.

## Ejemplo de mantenimiento: cambiar una regla de turnos

Usá esta lista para decidir qué revisar; no representa una cadena de ejecución idéntica para todos los canales:

1. **Interfaz:** revisá [features/appointments/](../apps/web/src/features/appointments/) y el [cliente HTTP](../apps/web/src/api/api-client.ts). Si afecta clientes o calendario, revisá también esas features y su relación con el shell.
2. **Contrato:** contrastá entradas, salidas y errores con [http/appointments.ts](../packages/contracts/src/http/appointments.ts) y el barrel HTTP; conservá campos omitidos, valores `null`, confirmaciones y semántica de los cuerpos.
3. **API:** revisá [routes/appointments.ts](../apps/api/src/routes/appointments.ts), autenticación y helpers de escritura de `app.ts`. No deduzcas identidad de cliente desde una sesión administrativa.
4. **Regla:** ubicá disponibilidad, planificación del cambio o transición en [domain/src/appointments/](../packages/domain/src/appointments/). Si afecta diálogo de WhatsApp, contrastá también [whatsapp/agenda.ts](../packages/domain/src/whatsapp/agenda.ts) y el adaptador del agente.
5. **Persistencia:** revisá [repositories/appointments.ts](../packages/db/src/repositories/appointments.ts), fachada y unidad de trabajo. Cambios de calendario o catálogo pueden compartir locks y guardas de turnos futuros.
6. **Pruebas:** actualizá la unitaria del dueño y las pruebas centrales del canal afectado; por ejemplo [appointment-manual-api](../tests/integration/appointment-manual-api.integration.test.ts), [appointment-storage](../tests/integration/appointment-storage.integration.test.ts) y [system-turnos-ui](../tests/e2e/system-turnos-ui.spec.ts).

La ubicación de un archivo no cambia por sí sola rutas, comandos, exports, esquema o identidad de clases de error. Preservá esos contratos salvo un cambio de comportamiento deliberado y probado; esta guía no introduce garantías nuevas ni correcciones de seguridad.

## Pruebas: elegir por dueño y alcance

Las unitarias con dueño claro viven junto al código en apps, packages o scripts. Las unitarias mixtas siguen en [tests/unit/](../tests/unit/); [integration/](../tests/integration/) cubre persistencia y composición; [contracts/](../tests/contracts/) cruza interfaces; y [e2e/](../tests/e2e/) cubre recorridos web. [tests/support/](../tests/support/) reúne soporte compartido y por proceso/capacidad; las fixtures del navegador también tienen [e2e/support/](../tests/e2e/support/).

Referencia breve de los runners definidos en el [package.json raíz](../package.json), para ejecutar desde la raíz según el alcance del cambio:

| Comando | Selección existente |
| --- | --- |
| `bun run test:unit` | `bun test tests/unit packages apps scripts`. |
| `bun run test:integration` | `bun test tests/integration`. |
| `bun run test:contracts` | `bun test tests/contracts`. |
| `bun run test:e2e` | Playwright e2e (navegador real). |

[playwright.config.ts](../playwright.config.ts) ejecuta la suite `system-*` sobre la app web real. Elegí los runners que correspondan y sus requisitos de entorno; esta tabla no es un procedimiento de instalación ni un informe de pruebas aprobadas.

Este archivo es la guía vigente de estructura. Los documentos de `odd/tasks/` son un registro interno histórico de trabajo, no la referencia pública de arquitectura.

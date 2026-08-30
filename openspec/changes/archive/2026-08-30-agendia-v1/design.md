# Diseño técnico: AgendIA v1

## Resumen de decisiones

AgendIA se implementará como un monorepo TypeScript con panel web, API de control, gestor persistente de sesiones Baileys y trabajador asíncrono separados. PostgreSQL será la fuente de verdad, aplicará Row-Level Security (RLS) como defensa adicional y alojará una cola durable basada en `pg-boss`. Las sesiones web serán opacas y revocables; el material Baileys se guardará cifrado por envolvente. El historial crudo se conservará completo, pero DeepSeek recibirá una representación finita compuesta por resumen acumulativo, recuperación textual y ventana reciente.

Esta arquitectura privilegia aislamiento verificable, recuperación tras reinicios y una ruta de despliegue simple sin someter conexiones largas de WhatsApp al ciclo de vida del servidor web.

## 1. Stack y organización del repositorio

| Área | Decisión |
|---|---|
| Lenguaje y ejecución | TypeScript estricto. Node.js LTS será el runtime de producción de Next.js, Fastify, `whatsapp-manager` y `message-worker`, en una versión compatible con Baileys y los frameworks seleccionados. |
| Gestor y monorepo | Bun será el gestor de paquetes, gestor de workspaces, propietario del lockfile y punto de entrada de scripts. El repositorio usará Bun workspaces, dependencias internas `workspace:*` y un único `bun.lock` en la raíz; los scripts raíz coordinarán paquetes sin introducir un orquestador adicional inicialmente. |
| Web | `apps/web`: Next.js con App Router y React, renderizado del panel y llamadas al API del mismo origen. No contendrá secretos ni acceso directo a PostgreSQL/proveedores. |
| API | `apps/api`: Fastify REST, OpenAPI generado desde contratos y manejo explícito de transacciones, identidad y errores. |
| Procesos persistentes | `apps/whatsapp-manager`: sockets Baileys y vinculación; `apps/message-worker`: outbox, cola y procesamiento de IA. |
| Dominio | `packages/domain`: casos de uso y puertos; `packages/contracts`: esquemas Zod y tipos de API/eventos. |
| Persistencia | `packages/db`: Drizzle ORM para SQL tipado, repositorios y migraciones SQL revisables. Consultas sensibles pueden usar SQL explícito. |
| Integraciones | `packages/whatsapp-baileys`, `packages/ai-deepseek`, ambos implementan puertos de `domain`. |
| Transversales | `packages/auth`, `packages/observability` y `packages/test-support`. |
| Validación | Zod en fronteras HTTP, configuración, eventos internos y respuesta del proveedor; restricciones equivalentes en PostgreSQL. |
| UI | Componentes accesibles y formularios tipados; no se agrega visor, búsqueda ni ruta de conversaciones. |

Bun se usará para instalar dependencias, resolver workspaces y ejecutar scripts de paquete mediante `bun run`; esta elección de tooling no cambia el runtime de producción. En v1 no se usará `bun --bun` ni otro mecanismo para forzar que las dependencias o servicios se ejecuten bajo el runtime de Bun. Las dependencias usarán rangos compatibles resueltos durante el scaffolding contra documentación oficial; no se fijan versiones sin esa comprobación. Drizzle generará migraciones, pero cada SQL se revisará, incluyendo RLS, índices, triggers y grants. Un rol exclusivo de migración tendrá DDL; los procesos de runtime no serán propietarios del esquema. Los cambios seguirán expansión/migración/contracción y se revertirán con una migración correctiva, no con un `down` destructivo automático.

## 2. Topología y flujo de datos

```text
Navegador -> TLS/reverse proxy -> web
                            \-> API -> PostgreSQL/pg-boss
                                       ^       |
WhatsApp <-> whatsapp-manager ---------+       v
                                             message-worker -> DeepSeek
                                                    |
                                                    +-> comando saliente -> whatsapp-manager -> WhatsApp
```

- `web` y `api` son contenedores sin estado, escalables horizontalmente. El proxy publica un solo origen y enruta `/api` al API.
- `whatsapp-manager` es un servicio no serverless, sin scale-to-zero, con almacenamiento de proceso efímero, terminación gradual y conexiones salientes largas. Puede tener varias réplicas, pero una sola posee cada sesión.
- `message-worker` escala independientemente y consume `pg-boss`. El dispatcher de outbox se ejecuta como modo del mismo artefacto, con elección/claims en PostgreSQL.
- PostgreSQL administrado es la única persistencia necesaria para v1. No se agrega Redis. El KMS/gestor de secretos de la plataforma guarda claves maestras y la clave DeepSeek.
- Los límites son unidades de despliegue separadas aunque compartan paquetes. Un fallo o despliegue web no reinicia sockets de WhatsApp.

### Flujo de control

1. El API autentica, deriva rol/tenant del servidor y ejecuta el caso de uso dentro de una transacción con contexto RLS.
2. La mutación, su auditoría y un evento outbox se confirman atómicamente.
3. El dispatcher publica el evento con clave estable en `pg-boss`; la entrega es al menos una vez.
4. El consumidor usa inbox/idempotencia antes de cualquier efecto. Los comandos de conexión quedan en una tabla durable que solo ejecuta el gestor propietario.

### Flujo de mensaje

1. El gestor recibe un evento y parte de su `session_public_id` interno, nunca de un tenant aportado por el mensaje.
2. Una función de enrutamiento con permisos mínimos resuelve `session -> business_id`; una sesión desconocida termina el flujo sin leer datos tenant.
3. En una transacción tenant se deduplica el identificador de WhatsApp, se aplica el filtro y, si corresponde, se persisten conversación/mensaje y outbox.
4. El trabajador serializa por conversación con advisory lock, vuelve a comprobar negocio activo, asistente activo y sesión apta, construye contexto y llama al puerto de IA.
5. Una respuesta válida se persiste como salida pendiente antes de enviar. El gestor dueño usa únicamente la misma conexión y registra resultado/actividad.

## 3. Multi-tenancy en PostgreSQL

Cada tabla propiedad de un negocio tendrá `business_id UUID NOT NULL`. Las claves foráneas entre datos tenant serán compuestas `(business_id, id)`, evitando relaciones cruzadas aun si una consulta tiene un error. UUID no predecibles reducen enumeración, pero no sustituyen autorización.

Se habilitará y forzará RLS (`ENABLE` y `FORCE ROW LEVEL SECURITY`). Los roles de runtime no tendrán `BYPASSRLS` ni serán dueños. Toda unidad de trabajo abre una transacción y establece mediante `set_config(..., true)` parametrizado:

- `app.tenant_id`: derivado de la sesión autenticada o del registro interno de enrutamiento;
- `app.actor_role`: `business_user`, `platform_admin` o un rol interno específico;
- `app.actor_id` y `app.request_id` para auditoría.

Las políticas fallan cerradas si falta contexto. Los repositorios tenant exigen `TenantContext` y no aceptan un `business_id` arbitrario. El pool se limpia por transacción mediante `SET LOCAL`/`set_config(..., true)`.

`auth_identities` y `web_sessions` son tablas de control de plataforma: el servicio de autenticación puede buscar una identidad por correo normalizado sin abrir acceso a datos tenant. Tras validar, el tenant siempre procede de esa identidad. Un índice único parcial garantiza un solo `business_user` por negocio.

Las operaciones administrativas usan rutas, repositorios y credenciales DB distintas. RLS permite al rol administrativo solo datos necesarios para alta, edición y proyecciones de estado; no le concede contenido de conversaciones ni credenciales Baileys. Cada operación sobre un tenant objetivo lo fija explícitamente y se audita. Las funciones `SECURITY DEFINER` se limitan al enrutamiento y proyecciones necesarias, fijan `search_path`, validan rol y no devuelven secretos.

## 4. Identidad, sesiones y autorización

- Roles cerrados: `platform_admin` con `business_id = NULL` y `business_user` con exactamente un negocio.
- El administrador crea negocio, correo y contraseña inicial directamente. Puede sustituir esa contraseña y activar/desactivar la cuenta; nunca puede leerla. No habrá registro, invitación, “olvidé mi contraseña”, tokens de recuperación ni envío de correo.
- Contraseñas con Argon2id en formato PHC, parámetros calibrados en la infraestructura y mínimo de longitud/contraseñas comunes validado al crearlas. Cambio administrativo revoca todas las sesiones del usuario.
- En login se genera un token aleatorio de 256 bits; PostgreSQL guarda solo su SHA-256, usuario, expiración absoluta e inactiva, creación y revocación. El navegador recibe `__Host-agendia_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, sin `Domain` y `Path=/`.
- Login rota el identificador; logout revoca en servidor y borra cookie. Suspender negocio o cuenta revoca sesiones inmediatamente. Cada request vuelve a comprobar identidad, revocación y estado del negocio antes de acceder al tenant.
- Toda mutación exige cabecera CSRF con token ligado a la sesión y validación estricta de `Origin`; CORS no acepta orígenes arbitrarios. GET no muta estado.
- La autorización reside en políticas por caso de uso: el usuario de negocio solo opera su tenant; el administrador usa capacidades explícitas. Un recurso ajeno responde como no encontrado/denegado sin confirmar existencia.
- La cuenta administrativa inicial se crea mediante comando operacional de bootstrap de un solo uso; después se deshabilita ese camino. No existe recuperación de contraseña: la recuperación operacional de un admin requiere procedimiento manual auditado con acceso a infraestructura.

## 5. Modelo conceptual

| Entidad | Propiedad y cardinalidad |
|---|---|
| `business` | Raíz tenant; estado `active/suspended`, nombre, creación y proyección de última actividad. |
| `auth_identity` | Plataforma; exactamente un administrador general y exactamente un usuario por negocio; correo único normalizado. |
| `web_session` | Muchas por identidad; revocables. No contiene autorización autocontenida. |
| `business_profile` | Uno a uno con negocio; campos comerciales explícitos y textos con límites. |
| `assistant_config` | Uno a uno; personalidad, tono, instrucciones, conocimiento, reglas, restricciones, activo y revisión optimista. |
| `whatsapp_connection` | Uno a uno; identificador público, número, estado, vínculo, última conexión, dueño/heartbeat y versión. Unique sobre `business_id`. |
| `whatsapp_auth_record` | Muchos fragmentos cifrados por conexión para credenciales/Signal keys; jamás sale por API. |
| `conversation` | Muchas por negocio/conexión, una por JID individual; unique tenant + conexión + JID normalizado. No tiene endpoint humano. |
| `message` | Muchos por conversación; secuencia, ID proveedor, dirección/origen, texto crudo, timestamps y estado de proceso/envío. Unique tenant + conexión + ID proveedor. |
| `conversation_summary` | Versiones derivadas por conversación; cubren un prefijo exacto de secuencias y nunca sustituyen `message`. |
| `inbox_event` / `outbox_event` | Deduplicación y efectos durables tenant-scoped. |
| `audit_event` | Append-only; actor/fuente, tipo, objetivo, tenant opcional, resultado, tiempo, request y metadatos permitidos. |
| `technical_event` | Diagnóstico operacional estructurado, severidad/código/componente/estado; sin contenido conversacional ni secretos. |

Los textos individuales recibidos y los textos salientes observados se conservan crudos para reconstruir el chat. Un texto `fromMe` puede persistirse como parte del estado conversacional, pero jamás dispara IA. Grupos y multimedia se filtran antes de crear conversación/mensaje; solo se conserva la huella mínima de deduplicación y el motivo técnico, sin descargar medios. No existe borrado funcional en v1: suspender conserva todo mientras exista el negocio.

## 6. Baileys: custodia y ciclo de vida

### Cifrado

El adaptador implementará un `AuthenticationStateStore` transaccional sobre PostgreSQL. Cada conexión tiene una DEK aleatoria; credenciales y claves se cifran con AES-256-GCM, nonce único y AAD que incluye negocio, conexión, nombre de registro y versión. La DEK se guarda envuelta por una KEK del KMS/gestor de secretos, fuera de PostgreSQL. La rotación reenvuelve DEK sin abrir sesiones; la rotación criptográfica completa crea nuevos ciphertexts. Solo `whatsapp-manager` puede desenvolverlas.

Nunca se registran claves, payloads cifrados completos, QR, JID completos ni respuestas del proveedor. El QR/código de vínculo es efímero, cifrado, expira en minutos y solo el API puede entregarlo al usuario autenticado del mismo tenant con `Cache-Control: no-store`; es la única información de vínculo mostrada y no expone credenciales persistentes.

### Propietario y estados

Una conexión requiere advisory lock dedicado por `connection_id`. La réplica que lo mantiene actualiza lease/heartbeat visible; el lock de PostgreSQL es la autoridad contra split-brain. Otra réplica solo toma propiedad después de perderse lock/heartbeat y obtener el lock. Escrituras de credenciales usan versión optimista y transacción.

Estados internos y proyección de panel:

```text
sin credenciales -> LINK_REQUIRED (requiere vinculación)
LINK_REQUIRED -> LINKING -> CONNECTED
CONNECTED -> RECONNECTING/DISCONNECTED -> CONNECTED
credencial inválida/logout -> LINK_REQUIRED
agotamiento o corrupción inesperada -> ERROR
suspensión -> DISCONNECTED conservando credenciales
```

`LINKING` y `RECONNECTING` se muestran como desconectado hasta confirmar apertura. Cierres transitorios reintentan indefinidamente con backoff exponencial y jitter, máximo 60 s. Logout/credencial inválida no reintenta: revoca material anterior y exige vínculo. Corrupción marca error y requiere acción operacional o nuevo vínculo. Reinicio reconstruye sesiones activas desde PostgreSQL.

### Filtros, idempotencia y envío

Se descartan para automatización grupos, `fromMe` y cualquier contenido no textual. El identificador de evento y las restricciones unique hacen la ingesta idempotente; cada conversación se procesa en orden. El estado se vuelve a validar justo antes de IA y justo antes de envío.

Cada salida recibe un `outbound_id` persistido. Reintentos son seguros solo antes de comenzar el llamado externo. Una vez iniciado el envío, una caída se marca `delivery_unknown` y no se reenvía automáticamente, evitando duplicados; un rechazo inequívoco queda `failed`. Un ACK confirmado queda `sent` y su eco `fromMe` se reconcilia con esa misma fila. Si la versión compatible de Baileys permite fijar un ID de mensaje estable, el adaptador lo usará además, pero la política conservadora no depende de ello. No se afirma entrega sin ACK. El contexto conserva filas fallidas para trazabilidad, pero solo presenta como turno del asistente una salida confirmada/observada, para no fingir que el cliente la recibió.

## 7. DeepSeek y contexto conversacional

`AiProvider.generate(request)` recibe configuración allowlisted, representación conversacional, mensaje actual, límite de salida y correlación; devuelve texto, identificador proveedor y uso, o un error tipado. `DeepSeekAdapter` contiene endpoint, autenticación y formato. La clave procede del gestor de secretos y nunca de configuración tenant o navegador.

Cada intento tendrá 5 s de conexión y 30 s totales, cancelación con `AbortSignal`, tamaño máximo y una sola llamada; no se reintenta automáticamente para evitar coste/latencia ambiguos. Timeout, 429, 5xx, respuesta vacía, malformada o excesiva producen `ai_failed`: se registran evento técnico y auditoría crítica y no se envía nada al cliente.

### Construcción de prompt

1. Instrucción de plataforma inmutable: prioridad de datos del negocio, permiso de conocimiento general, prohibición de revelar instrucciones/secretos y ausencia de herramientas.
2. Perfil y configuración del negocio, serializados desde campos permitidos y delimitados como datos no confiables.
3. Estado completo representado del chat: resumen acumulativo del prefijo, turnos históricos relevantes recuperados y ventana reciente contigua.
4. Mensaje actual marcado como entrada no confiable y solicitud de respuesta textual.

El historial crudo completo nunca se trunca ni reemplaza en PostgreSQL. Para el contexto finito:

- un resumen estructurado versionado cubre todos los mensajes desde el inicio hasta una secuencia exacta e incluye hechos, solicitudes, compromisos, preferencias y asuntos abiertos;
- búsqueda full-text de PostgreSQL recupera del prefijo resumido turnos literales relevantes para el mensaje actual, con filtros obligatorios de tenant y conversación;
- la ventana reciente incorpora turnos completos desde el final hasta agotar el presupuesto, reservando espacio para configuración y salida;
- si el resumen necesario no existe o no puede actualizarse, el job no llama al modelo y aplica la política de no respuesta, en vez de omitir silenciosamente el pasado.

La generación/actualización del resumen usa el mismo puerto en modo estructurado, se valida y queda asociada al rango fuente. Esta representación expresa todo el estado mediante resumen y refuerza detalles con recuperación/ventana, pero es necesariamente lossy: puede perder matices, la búsqueda léxica puede omitir sinónimos y un resumen puede propagar un error. El historial crudo permite recalcularlo; no se afirma que el proveedor reciba cada token histórico. No se usarán embeddings externos en v1.

## 8. Seguridad y amenazas

| Amenaza | Controles principales |
|---|---|
| Confusión tenant/IDOR | Tenant derivado en servidor, RLS forzada, FK compuestas, repositorios con contexto, IDs opacos y pruebas negativas exhaustivas. |
| Acceso admin excesivo | Pool/rutas/capacidades separadas, políticas por tabla, sin acceso de producto a conversaciones o credenciales y auditoría obligatoria. |
| Fuga de secretos | KMS, cifrado autenticado, grants mínimos, redacción central, sin secretos en browser/log/error, escaneo de commits e imágenes. |
| Prompt injection/exfiltración | Sin herramientas para el modelo, contexto allowlisted de un solo tenant, delimitación de datos no confiables, instrucción superior fija y límites de salida. El modelo todavía puede repetir información autorizada del mismo chat/configuración; es una limitación conocida. |
| Robo de sesión | Cookie `__Host`, token opaco hasheado, TLS, expiración/revocación, rotación al login, invalidación por suspensión y alertas de acceso anómalo. |
| CSRF/XSS | Token CSRF + Origin, SameSite, CSP estricta, escaping React, sin HTML del modelo, cabeceras de seguridad y dependencias auditadas. |
| Abuso/DoS/coste | Límites en proxy y token-bucket compartido en PostgreSQL por IP/cuenta/tenant/chat; límites más estrictos en login y vinculación; tamaño Zod y cuotas de cola. El exceso no genera respuesta y queda observable. |
| Inyección/entrada inválida | Zod, SQL parametrizado, límites de longitud, enums cerrados, JSON allowlisted y rechazo atómico. |
| Auditoría alterada | Tabla append-only sin UPDATE/DELETE para runtime, inserción transaccional, hash encadenado por stream tenant/plataforma con clave HMAC externa y verificación periódica. |
| Logs sensibles | Eventos estructurados con códigos, IDs pseudónimos y request ID; no contenido de mensajes, prompts, cookies, QR, JID completos ni payloads proveedor. |

## 9. Fiabilidad, observabilidad y operación

Las mutaciones internas usan transacción para estado + auditoría + outbox. `pg-boss`, inbox unique, claims `SKIP LOCKED` y claves estables dan entrega al menos una vez con consumidores idempotentes. No se pretende “exactly once” frente a WhatsApp; los estados `pending/processing/generated/sending/sent/failed/delivery_unknown` hacen visible la incertidumbre.

`audit_event` prueba acciones críticas y fallos: contrato estable, append-only y conservado con el negocio. Cubre login exitoso/fallido y logout, altas y cambios de credenciales, configuración comercial/asistente, activación, vínculo y transiciones relevantes de WhatsApp, suspensión/reactivación y fallos críticos de IA/conexión/envío. `technical_event` sirve diagnóstico y puede repetirse/agregarse; `business.last_technical_activity_at` es una proyección actualizada. Un evento puede escribir ambos contratos, pero debe satisfacer por separado sus campos. El panel solo expone estados y última actividad autorizada, no un visor de logs o conversaciones.

OpenTelemetry instrumentará HTTP, jobs, DB y proveedores con trazas, métricas y logs JSON. Métricas: latencia/error API, login denegado, edad/profundidad de cola, sesiones por estado, reconexiones, IA timeout/error, envío fallido/unknown y heartbeat. Etiquetas globales evitan `business_id` de alta cardinalidad; la investigación tenant usa IDs pseudónimos y acceso operacional. Alertas cubren cola estancada, gestor sin heartbeat, crecimiento de errores, fallo de backups y desconexiones anómalas.

La recuperación reinicia jobs no confirmados, reconstruye sockets y recalcula proyecciones. Un kill switch operacional global y los controles existentes de suspender/desactivar contienen incidentes sin borrar datos ni reactivar asistentes al desplegar. API y workers tienen readiness/liveness; el gestor puede estar sano aunque una sesión concreta no lo esté.

PostgreSQL tendrá cifrado de volumen y tránsito, WAL continuo/PITR de 14 días y snapshots diarios cifrados por 30 días en otra zona. Se probará la restauración trimestral, incluyendo acceso a KEK históricas, RLS, conteos tenant, jobs y sesiones cifradas. Backups no sustituyen la conservación primaria mientras exista el negocio. RPO/RTO contractuales quedan sin fijar porque el producto no define SLA.

## 10. Contratos HTTP y módulos

- `/auth/login`, `/auth/logout`, `/auth/session`: autenticación; no existen endpoints de registro o recuperación.
- `/admin/businesses`, `/admin/businesses/:id/user`, `/admin/businesses/:id/status`: alta, edición, credenciales, suspensión/reactivación y proyección de supervisión.
- `/me/business-profile`, `/me/assistant`: configuración y activación del tenant derivado; no aceptan tenant en body.
- `/me/whatsapp`, `/me/whatsapp/link`, `/me/whatsapp/status`: comando de vínculo, QR efímero y estado único.
- No habrá `/conversations`, `/messages`, búsqueda ni payload que exponga su contenido.

Los contratos Zod generan OpenAPI y errores uniformes (`code`, `message`, `requestId`, detalles de campo seguros). Los puertos principales son `BusinessRepository`, `TenantUnitOfWork`, `AuditSink`, `Queue`, `WhatsAppGateway`, `WhatsAppAuthStore`, `AiProvider` y `ConversationContextBuilder`. Dominio no importa Fastify, Drizzle, Baileys ni DeepSeek.

## 11. Estrategia de pruebas y trazabilidad

Se aplicará TDD estricto: primero prueba roja del requisito/caso, luego implementación mínima verde y refactor. Vitest cubre unidades, integración y contratos; Playwright cubre navegador. Testcontainers levanta PostgreSQL real para RLS, migraciones, locks, outbox y concurrencia. Dobles con contrato simulan Baileys/DeepSeek de forma determinista; una suite opt-in de smoke contra proveedores no bloquea CI ni usa cuentas productivas.

| Dominio de spec | Componentes | Verificación principal |
|---|---|---|
| `administration-and-isolation` | auth, API admin/me, RLS, sesiones | unitarias de políticas; integración real PG; matriz IDOR usuario/admin; E2E alta, login, suspensión/reactivación. |
| `configuration-and-whatsapp` | perfiles, asistente, gestor y auth store | schemas/estados; unique 1:1; contrato Baileys; cifrado/rotación; E2E configuración y vínculo con doble. |
| `messaging-and-ai` | ingesta, filtros, contexto, DeepSeek, salida | duplicados/orden; grupos/propios/media; resumen+retrieval+ventana; timeout/no-respuesta; mismo session ID; crash en envío. |
| `persistence-and-operations` | migraciones, outbox, auditoría, telemetría, backups | rollback transaccional; append-only/HMAC; redacción; reinicio/restore ensayado; ausencia de rutas/visor. |

Pruebas de aislamiento generan al menos dos tenants y ejercitan cada repositorio/endpoint con IDs propios y ajenos; también ejecutan SQL con contexto ausente, contexto falsificado, rol admin limitado y workers concurrentes. Deben demostrar cero filas/efectos cruzados, no solo códigos HTTP.

Comandos previstos tras scaffolding:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contracts
bun run test:tenant-isolation
bun run test:e2e
bun run test                 # todas las suites bloqueantes anteriores
bun run db:generate          # genera SQL a revisar
bun run db:migrate           # aplica migraciones con rol DDL
bun run db:check             # deriva una DB limpia y verifica drift/RLS
bun run build
```

`test:integration`, `test:tenant-isolation` y `test:e2e` requerirán Docker; sus scripts crean y destruyen dependencias aisladas. CI ejecutará lint, tipos, suites bloqueantes, migración desde cero y build. Ninguna prueba depende de DeepSeek o WhatsApp reales.

## 12. Alternativas y trade-offs

| Alternativa descartada | Motivo |
|---|---|
| Monolito Next.js con Baileys dentro | Los deploys/requests web cortarían conexiones largas y mezclarían escalado interactivo con sockets. |
| JWT autocontenido | Revocación inmediata por logout, cambio de contraseña y suspensión sería más compleja. |
| Solo filtros `business_id` en ORM | Un olvido produciría fuga; RLS + FK compuestas aporta defensa independiente. |
| Esquema o base por tenant | Mayor aislamiento físico, pero migración, pool y operación crecen por tenant sin necesidad v1. |
| Prisma | Es viable, pero Drizzle/SQL explícito ofrece control más directo sobre RLS, roles, migraciones y transacciones de contexto. |
| Redis/BullMQ | Agrega otra persistencia y coordinación; PostgreSQL/pg-boss cubre el volumen inicial y atomicidad requerida. |
| Archivos/volúmenes para auth Baileys | Dificultan cifrado, failover y propietario único; PostgreSQL cifrado permite reconstrucción portable. |
| Enviar todo el historial o truncarlo | El primero excede contexto finito y el segundo pierde estado; resumen + recuperación + ventana conserva crudo y representa el prefijo completo con límites explícitos. |
| Reintentar envío ambiguo | Podría duplicar respuestas; `delivery_unknown` prefiere silencio observable. |

Trade-offs asumidos: PostgreSQL soporta datos, cola y coordinación, por lo que requiere capacidad/monitoreo cuidadosos; RLS eleva complejidad de pruebas y transacciones; el resumen es lossy; Baileys es una integración no oficial y puede exigir adaptación frecuente; la política conservadora de envío puede perder una respuesta ante una caída ambigua.

## 13. Rollout y migraciones

1. Crear monorepo, toolchain, CI, contenedores locales y migración base con roles/RLS; hacer verdes primero los tests de aislamiento.
2. Incorporar autenticación, administración, configuración y paneles; bootstrap controlado del admin.
3. Desplegar gestor con doble Baileys, almacenamiento cifrado y estados; luego validar una cuenta operativa controlada.
4. Activar ingesta, outbox/cola, contexto y doble DeepSeek; ejecutar pruebas de reinicio, duplicación y no-respuesta.
5. Habilitar DeepSeek real y WhatsApp por tenants controlados, observando coste/latencia/estados antes de ampliarlo a todos.
6. Ensayar restore, rotación de claves, suspensión, rollback binario y despliegue gradual del gestor antes de disponibilidad general.

Las migraciones serán compatibles hacia atrás durante un despliegue. Un rollback revierte contenedores solo si el esquema sigue siendo compatible; de lo contrario se avanza con una migración correctiva. Flags operacionales nunca activarán asistentes inactivos ni tenants suspendidos.

## 14. Detalles pendientes sin decisión de producto

- Resolver versiones compatibles de Node, Baileys, Next.js, Fastify, Drizzle, pg-boss, Vitest y Playwright según documentación oficial al crear el lockfile.
- Seleccionar el modelo DeepSeek disponible y medir su tokenizador para fijar presupuestos, umbrales de resumen y límites de salida sin cambiar la estrategia.
- Calibrar Argon2id, rate limits, concurrencia, backoff y tamaños máximos con pruebas de carga; los estados y políticas de seguridad ya están fijados.
- Elegir proveedor concreto de KMS, PostgreSQL administrado, cómputo y OpenTelemetry según el entorno de despliegue.
- Confirmar en la versión Baileys elegida si admite ID saliente estable; la política `delivery_unknown` sigue siendo válida si no lo admite.
- Definir RPO/RTO y retenciones operacionales más exigentes cuando exista un SLA; no afecta la conservación primaria requerida.

Ninguno de estos puntos introduce una decisión de alcance ni deja abiertos stack, tenancy, autenticación, topología, persistencia o estrategia de pruebas.
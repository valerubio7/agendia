[agendIA](../README.md) / Documentación

# Entender primero. Construir después.

Documentación para **desarrolladores y colaboradores**. Elegí un recorrido según lo que necesitás resolver: conocer el producto, seguir el código o trabajar con el sistema.

**Primera visita:** [Modelo del producto](understanding.md) → [Recorrido de una reserva](booking-journey.md) → [Arquitectura](ARCHITECTURE.md) → [Desarrollo local](DEVELOPMENT.md).

## 01 · Comprender el producto

### [Qué agenda agendIA](understanding.md)

El vocabulario compartido: negocio, servicios, recursos, calendario, clientes y turnos. Incluye un ejemplo de disponibilidad y explica por qué conversar, proponer y guardar son cosas distintas.

**Al terminar:** podés explicar qué decide el negocio, qué interpreta el agente y qué valida el backend.

## 02 · Seguir el sistema

### [Recorrido de una reserva](booking-journey.md)

Un ejemplo concreto desde la propuesta hasta el turno guardado y su confirmación por WhatsApp. Distingue entrega, aceptación, revalidación y commit, con enlaces al código y sus pruebas.

### [Arquitectura](ARCHITECTURE.md)

Los cuatro procesos y sus límites. Seguí una petición del panel o un mensaje de WhatsApp y ubicá dónde viven la autorización, las herramientas del agente y la persistencia.

### [Base de datos](DATABASE.md)

Relaciones, aislamiento por negocio, roles y migraciones. Para consultar una entidad concreta, abrí el [diccionario de tablas](database/tables.md).

**Al terminar:** sabés qué componente cambiar y qué frontera de seguridad no podés saltarte.

## 03 · Trabajar con el proyecto

### [Desarrollo](DEVELOPMENT.md)

Requisitos, primera puesta en marcha, servicios, pruebas y depuración local. Empezá por acá si ya conocés el producto y querés levantarlo.

### [Operaciones](OPERATIONS.md)

Topología de despliegue, configuración, release y runbook. Leé las advertencias antes de ejecutar comandos que afecten datos; desarrollo local no equivale a producción.

**Al terminar:** tenés una ruta para preparar el entorno, comprobar un cambio y entender su despliegue.

## Buscá por el cambio que vas a hacer

- **Interfaz o contratos HTTP:** [Arquitectura](ARCHITECTURE.md) → [`apps/web`](../apps/web), [`apps/api`](../apps/api) y [`packages/contracts`](../packages/contracts).
- **Reglas de agenda:** [Modelo del producto](understanding.md) → [`packages/domain`](../packages/domain) y [`repositorios de turnos`](../packages/db/src/repositories/appointments.ts).
- **Comportamiento del agente:** [Sus límites](understanding.md#el-agente-conversa-el-backend-valida) → [`message-worker`](../apps/message-worker/src/agent) y [`prompt del sistema`](../packages/domain/src/agent/system-prompt.ts).
- **Datos o aislamiento:** [Base de datos](DATABASE.md) → [diccionario](database/tables.md) y [`migraciones SQL`](../packages/db/migrations).
- **Recepción o entrega de mensajes:** [Arquitectura](ARCHITECTURE.md#flujo-de-un-mensaje-de-whatsapp) → [`whatsapp-manager`](../apps/whatsapp-manager).

## Mantener este mapa útil

**Una pregunta, una página.** La portada presenta; este índice orienta; las guías explican. Evitá copiar listas de comandos o reglas de negocio en varios lugares.

La fuente de verdad depende de la pregunta:

- **Producto y políticas:** [`packages/domain/src`](../packages/domain/src), las [rutas HTTP](../apps/api/src/routes) y las [herramientas del agente](../apps/message-worker/src/agent/tools.ts). Actualizá el modelo cuando cambie el significado de una entidad o una regla visible.
- **Arquitectura:** [`apps`](../apps) y [`packages`](../packages). Actualizá la guía al mover responsabilidades o cambiar un flujo.
- **Datos:** el historial de [`migraciones`](../packages/db/migrations), no solo la migración inicial ni el esquema parcial de Drizzle. Actualizá la visión de datos y el diccionario al cambiar tablas, relaciones o roles.
- **Desarrollo y despliegue:** [`package.json`](../package.json), [`scripts`](../scripts), [`docker-compose.yml`](../docker-compose.yml), [`compose.production.yml`](../compose.production.yml) y [workflows](../.github/workflows). Actualizá la guía correspondiente al cambiar un comando o el entorno.

En el mismo cambio que modifica el comportamiento, revisá la explicación y sus enlaces. Usá rutas relativas al documento, texto alternativo en imágenes y ejemplos ficticios; nunca datos de clientes ni credenciales.

---

**Siguiente paso → [Entender el producto](understanding.md)** · [Volver a la portada](../README.md)

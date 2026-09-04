# Producto

<!-- impeccable:product-schema 1 -->

## Platform

web

## Usuarios

- **Administradores de la plataforma:** aprovisionan y supervisan negocios. Su trabajo consiste en crear y mantener cada negocio y su cuenta de acceso, activarlo o suspenderlo y consultar el estado operativo de su asistente y de WhatsApp.
- **Usuarios de negocio:** trabajan únicamente dentro del negocio que tienen asignado. Su trabajo consiste en mantener el perfil del negocio, configurar y activar el asistente, vincular la cuenta de WhatsApp del negocio y supervisar esa conexión sin modificar código.
- **Clientes de los negocios:** contactan con el negocio a través de WhatsApp. No crean una cuenta de agendIA ni instalan otra aplicación; su interacción permanece en un chat individual de WhatsApp.

## Propósito del producto

agendIA es un producto SaaS multitenant que permite a un negocio configurar un asistente de IA y conectarlo con WhatsApp sin tener que desarrollar ni operar por su cuenta esa infraestructura de automatización. La principal interfaz destinada a personas es el panel de `apps/web`. La API, los workers de mensajes, el gestor de WhatsApp, la capa de base de datos, el adaptador de DeepSeek y el gateway de Baileys sustentan tanto el panel como el flujo automatizado de mensajes.

La V1 cumple su objetivo cuando un administrador puede aprovisionar un negocio, ese negocio puede configurar y activar su asistente y vincular WhatsApp, y un texto entrante apto de un cliente puede recibir una respuesta automatizada específica del tenant, mientras los datos y los accesos permanecen aislados entre negocios.

## Posicionamiento

agendIA ofrece automatización de WhatsApp basada en configuración para tenants de negocio gestionados de forma independiente: cada respuesta se encamina mediante la conexión de WhatsApp propia del negocio receptor y se genera a partir del perfil, la configuración del asistente y el contexto de conversación de ese tenant. La plataforma, en lugar de cada negocio, se encarga de la administración compartida, el aislamiento, el procesamiento de mensajes, la integración de IA y el ciclo de vida de la conexión de WhatsApp.

## Contexto operativo

- Los administradores de la plataforma utilizan el panel web para aprovisionar y supervisar los negocios y sus accesos.
- Los usuarios de negocio utilizan el panel web para mantener el perfil del negocio, el comportamiento y el estado de activación del asistente, y el estado de la vinculación con WhatsApp.
- Cada negocio vincula una conexión de WhatsApp. Los clientes siguen enviando mensajes a ese negocio mediante WhatsApp; agendIA no exige una cuenta ni una aplicación independiente para el cliente.
- El procesamiento de entradas es asíncrono: el gestor de WhatsApp recibe y clasifica eventos, las colas de trabajo de pg-boss respaldadas por PostgreSQL coordinan el procesamiento, DeepSeek genera las respuestas aptas y el gateway de Baileys las envía mediante WhatsApp.

## Capacidades y restricciones

- El producto es multitenant. Los perfiles de negocio, la configuración del asistente, los usuarios, el estado de WhatsApp, los mensajes y los registros operativos están asociados a un negocio; los servicios del backend, y no solo la interfaz web, hacen cumplir la autenticación, la autorización y los límites entre tenants.
- Un administrador de la plataforma puede crear y gestionar negocios y sus accesos, consultar el estado del negocio, del asistente y de WhatsApp, y activar o suspender un negocio.
- Un usuario de negocio puede editar la información del perfil, configurar la personalidad, el tono, las instrucciones, el conocimiento, las reglas y las restricciones del asistente, activar o desactivar el asistente, y vincular o consultar WhatsApp.
- Se permite una conexión de WhatsApp por negocio.
- La gestión automatizada se limita a mensajes de texto entrantes en chats individuales. Los eventos duplicados del proveedor se deduplican; se ignoran los mensajes de grupo, los mensajes enviados por la propia cuenta vinculada y los mensajes que no sean de texto o contengan archivos multimedia.
- La automatización requiere que tanto el negocio como el asistente estén activos. La entrega de respuestas también depende de que haya una conexión de WhatsApp vinculada y disponible.
- DeepSeek es el proveedor de IA implementado. Las solicitudes incluyen el perfil de negocio del tenant, la configuración del asistente, el contexto de conversación autorizado y el texto entrante del cliente; el modelo devuelve una respuesta textual para el cliente.
- Baileys es el gateway de WhatsApp implementado. PostgreSQL es el sistema de registro, Drizzle gestiona las definiciones de la base de datos, Fastify sirve la API y pg-boss sustenta el trabajo en cola.
- **Decisiones abiertas:** no se han confirmado el mercado o sector empresarial principal, el modelo comercial ni el alcance del producto más allá de la V1 implementada. Los trabajos futuros deben tratarlos como aspectos sin decidir y no inferir compromisos.

## Compromisos de marca

- Se debe preservar el nombre del producto y su capitalización: **agendIA**.
- El descriptor en español establecido es **«Tu asistente inteligente para WhatsApp.»**
- La terminología existente de cara al usuario está en español y utiliza términos como *negocio*, *asistente* y *WhatsApp*. Esto demuestra el idioma actual del producto, pero no autoriza a inventar afirmaciones más amplias sobre mercados o regiones.

## Evidencia disponible

- `apps/web/app/` y `apps/web/src/ui/` implementan las principales interfaces destinadas a personas para el inicio de sesión, la administración de la plataforma, el perfil del negocio, el asistente y WhatsApp. El panel implementado no contiene ninguna ruta para una bandeja de conversaciones.
- `apps/api/src/app.ts` expone los flujos de la API del panel con autenticación y control por roles.
- `apps/whatsapp-manager/src/inbound-handler.ts` implementa el encaminamiento por tenant, la gestión de duplicados, el filtrado de textos individuales y la comprobación de que el negocio y el asistente estén activos.
- `apps/message-worker/src/ai-job.ts` y `packages/ai-deepseek/src/deepseek-adapter.ts` implementan la composición del contexto y las respuestas textuales generadas mediante DeepSeek.
- `packages/domain/src/whatsapp/connection.ts`, `packages/whatsapp-baileys/` y `packages/db/migrations/` documentan el ciclo de vida de una única conexión, el límite de Baileys, la persistencia por tenant, las colas y el modelo de procesamiento de mensajes.
- `tests/e2e/acceptance.spec.ts`, junto con las suites de contrato, integración, aislamiento entre tenants y pruebas unitarias, aporta evidencia ejecutable del comportamiento implementado en la V1.
- No hay clientes, testimonios, métricas comparativas, precios ni pruebas comerciales verificados. Los trabajos futuros de producto o marketing no deben inventarlos.

## Principios del producto

1. **El aislamiento entre tenants es invariable.** Cada acción de usuario, lectura de configuración, mensaje y registro operativo debe permanecer dentro del negocio propietario, salvo cuando se realice mediante la autoridad explícita de un administrador de la plataforma.
2. **La configuración debe residir en el producto.** Los administradores y los usuarios de negocio deben aprovisionar y operar el asistente mediante el panel web, no mediante cambios de código.
3. **El cliente permanece en WhatsApp.** agendIA respalda al negocio detrás del canal; la V1 no introduce una aplicación independiente para clientes ni duplica la bandeja de conversaciones.
4. **Solo se automatizan los mensajes aptos.** La propiedad de la conexión, el estado del negocio y del asistente, el tipo de mensaje y de chat, el remitente y la condición de duplicado determinan si la automatización puede responder.
5. **La IA se fundamenta en cada tenant y está controlada por la plataforma.** Las respuestas utilizan la configuración y el contexto autorizados del negocio, mientras que las credenciales del proveedor, las instrucciones de seguridad y la entrega permanecen tras los límites del backend.

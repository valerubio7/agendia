# Mensajería e inteligencia artificial Specification

## Purpose

Procesar de forma segura los mensajes admisibles de WhatsApp y responder con contexto autorizado.

## Requirements

### Requirement: Resolución de sesión y tenant antes del acceso

Para todo evento entrante, el sistema MUST identificar y validar primero la sesión de WhatsApp y el negocio asociado antes de acceder a configuración, historial, registros o servicios de IA. Una sesión desconocida, inexistente, inválida o no asociada a un negocio activo MUST impedir el procesamiento y la respuesta automática.

#### Scenario: Evento de sesión conocida

- GIVEN un evento entrante de una sesión conectada asociada a un negocio activo
- WHEN el sistema lo recibe
- THEN resuelve ese negocio antes de recuperar datos o construir contexto.

#### Scenario: Evento de sesión desconocida

- GIVEN un evento entrante sin sesión válida o sin negocio asociado
- WHEN el sistema lo recibe
- THEN no accede a datos de ningún tenant
- AND no solicita IA ni envía una respuesta.

### Requirement: Admisibilidad de mensajes entrantes

El sistema MUST procesar exclusivamente mensajes de texto recibidos en chats individuales desde clientes finales. MUST ignorar grupos, mensajes originados por el propio número conectado y contenido multimedia u otros tipos no textuales, sin solicitar IA ni enviar una respuesta automática.

#### Scenario: Texto individual admisible

- GIVEN un texto entrante de un cliente final en un chat individual de una sesión válida
- WHEN el negocio está activo y su asistente está activo
- THEN el mensaje es elegible para el flujo de respuesta.

#### Scenario: Evento no admisible

- GIVEN un mensaje de grupo, propio, de audio, imagen, video, documento u otro contenido no textual
- WHEN el sistema lo recibe
- THEN lo ignora
- AND no genera salida automática ni bucle de mensajes.

### Requirement: Historial conversacional completo y aislado

El sistema MUST conservar duraderamente el historial crudo completo de cada chat de cliente final mientras exista el negocio asociado. Para cada solicitud de IA admisible, MUST proporcionar una representación compatible con el modelo del estado conversacional completo de ese chat, junto con el mensaje pertinente, sin incluir datos, historial o secretos de otro tenant. La técnica de representación no se especifica en esta capacidad.

#### Scenario: Contexto completo del mismo chat

- GIVEN un chat con mensajes históricos y un nuevo texto admisible
- WHEN se prepara la solicitud de IA
- THEN el contexto representa el estado conversacional completo de ese chat y conserva el historial crudo asociado.

#### Scenario: No cruce entre chats o tenants

- GIVEN chats de clientes pertenecientes a negocios distintos
- WHEN se prepara una solicitud para un chat del negocio A
- THEN no contiene historial ni configuración del negocio B.

### Requirement: Respuesta contextual mediante DeepSeek

El sistema MUST usar DeepSeek como proveedor inicial para interpretar textos y generar respuestas, exclusivamente desde el backend. La solicitud MUST incluir la configuración autorizada del negocio y el contexto conversacional aplicable. Las respuestas MUST basarse principalmente en la información del negocio y MAY complementarse con conocimiento general; no MUST limitarse a plantillas predeterminadas.

#### Scenario: Respuesta basada en el negocio

- GIVEN un texto admisible y una configuración comercial y de asistente del tenant
- WHEN DeepSeek genera una respuesta satisfactoria
- THEN la respuesta usa principalmente esa información y se envía por la misma sesión de WhatsApp.

#### Scenario: Credenciales de IA fuera del navegador

- GIVEN un navegador de usuario o cliente final
- WHEN interactúa con funciones de AgendIA
- THEN no recibe credenciales de DeepSeek ni invoca al proveedor con credenciales de la plataforma.

### Requirement: Límite reemplazable del proveedor de IA

La comunicación con DeepSeek MUST estar separada de la lógica de negocio mediante un límite reemplazable, de modo que un proveedor futuro pueda cumplir el mismo contrato de generación sin cambiar los requisitos de enrutamiento, aislamiento ni configuración de AgendIA.

#### Scenario: Dependencia de proveedor contenida

- GIVEN el flujo de generación de una respuesta
- WHEN AgendIA solicita la generación
- THEN la lógica de negocio interactúa con el contrato de proveedor y no depende de detalles exclusivos de DeepSeek.

### Requirement: Fallo de IA y envío de respuestas

Cuando DeepSeek falle, no esté disponible o no produzca una respuesta utilizable, el sistema MUST no enviar respuesta al cliente final y MUST registrar el fallo técnico sin secretos. Cuando exista respuesta, MUST intentar enviarla por la misma conexión de WhatsApp; si el envío falla, MUST registrar el fallo y actualizar el estado operativo cuando corresponda, sin afirmar al cliente que el mensaje fue enviado.

#### Scenario: Indisponibilidad de DeepSeek

- GIVEN un mensaje admisible para un asistente activo
- WHEN DeepSeek devuelve un error, agota el tiempo aplicable o no está disponible
- THEN el cliente no recibe una respuesta automática
- AND el sistema registra el fallo técnico.

#### Scenario: Fallo de envío

- GIVEN una respuesta generada para una sesión conectada
- WHEN WhatsApp o Baileys rechaza o no completa el envío
- THEN el sistema registra el fallo
- AND refleja el estado de conexión aplicable sin exponer secretos.

### Requirement: Operación continua del asistente activo

Un asistente activo de un negocio activo con conexión válida MUST poder procesar mensajes admisibles y responder automáticamente las 24 horas. Los horarios configurados por el negocio MUST servir como información contextual y no bloquear este comportamiento.

#### Scenario: Consulta fuera de horario comercial

- GIVEN un asistente activo, una conexión válida y un texto individual recibido fuera de los horarios informados
- WHEN se procesa el evento
- THEN el sistema puede generar y enviar una respuesta automática.

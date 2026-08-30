# Configuración y WhatsApp Specification

## Purpose

Permitir que cada negocio configure y conecte su asistente sin modificar código y sin perder el aislamiento.

## Requirements

### Requirement: Configuración comercial por negocio

El sistema MUST permitir al único usuario autorizado guardar y editar desde la interfaz web, para su negocio, nombre comercial, descripción, dirección, contacto, horarios, servicios o productos, preguntas frecuentes, políticas e información adicional. Esta información MUST permanecer aislada y estar disponible como contexto del asistente; los horarios serán informativos y no limitarán la operación automática.

#### Scenario: Guardado de información comercial

- GIVEN un usuario autorizado de un negocio activo
- WHEN guarda información comercial válida
- THEN el sistema la conserva para ese negocio y la hace disponible para su asistente.

#### Scenario: Datos inválidos o de otro negocio

- GIVEN una solicitud con datos que no cumplen las reglas de validación o con ámbito de otro negocio
- WHEN se intenta guardar la configuración
- THEN el backend la rechaza con un error utilizable
- AND no altera la configuración existente de ningún tenant.

### Requirement: Configuración y activación del asistente

El sistema MUST permitir al usuario autorizado definir personalidad, tono, instrucciones generales, conocimiento, reglas y restricciones, y activar o desactivar el asistente. MUST admitir la activación con cualquier configuración que sea válida según el esquema y las condiciones operativas, sin exigir una lista adicional de contenidos obligatorios. El estado MUST persistir por negocio y reflejarse en el panel.

#### Scenario: Activación con configuración válida mínima

- GIVEN un negocio activo con una configuración que cumple la validación aplicable
- WHEN su usuario activa el asistente
- THEN el estado queda activo aunque no contenga campos adicionales no requeridos.

#### Scenario: Asistente inactivo

- GIVEN un asistente inactivo
- WHEN llega un mensaje entrante admisible
- THEN el sistema no solicita una respuesta automática ni envía un mensaje al cliente.

### Requirement: Vinculación única de WhatsApp mediante Baileys

El sistema MUST usar Baileys como integración inicial de WhatsApp. El usuario autorizado MUST poder iniciar desde su panel el mecanismo de vinculación y completar el enlace. Cada negocio MUST tener exactamente una cuenta y una sesión de WhatsApp; el sistema MUST impedir crear o asociar una segunda cuenta o sesión al mismo negocio.

#### Scenario: Vinculación correcta

- GIVEN un negocio activo sin sesión vinculada y un usuario autorizado
- WHEN inicia y completa el mecanismo de vinculación
- THEN la sesión queda asociada exclusivamente a ese negocio.

#### Scenario: Segundo vínculo no permitido

- GIVEN un negocio que ya posee una cuenta y sesión de WhatsApp asociadas
- WHEN se intenta asociar otra cuenta o sesión
- THEN el sistema rechaza la asociación
- AND conserva la asociación existente.

### Requirement: Estado y metadatos de la sesión de WhatsApp

El sistema MUST conservar de forma segura el negocio asociado, identificador de sesión, número conectado, fecha de vinculación, última conexión y estado de cada sesión. MUST representar y mostrar los estados conectado, desconectado, requiere vinculación y error de conexión. Ante pérdida, corrupción o invalidez de una sesión, MUST reflejar el estado aplicable, registrar el incidente y requerir una nueva vinculación cuando corresponda.

#### Scenario: Desconexión observable

- GIVEN una sesión vinculada que se desconecta
- WHEN el sistema recibe o detecta el cambio
- THEN actualiza el estado a desconectado, requiere vinculación o error de conexión según corresponda
- AND registra la actividad técnica relevante.

#### Scenario: Sesión no disponible para envío

- GIVEN una sesión con estado distinto de conectado
- WHEN una operación requiere enviar una respuesta
- THEN el sistema no intenta atribuir ni enviar mediante una sesión inválida
- AND registra el fallo aplicable.

### Requirement: Protección de material sensible

El sistema MUST proteger contraseñas, sesiones de usuario, credenciales de DeepSeek y material de sesión o vinculación de Baileys. Ninguno de estos secretos MUST exponerse al navegador, a usuarios no autorizados, a otros tenants ni a registros o mensajes de error inseguros.

#### Scenario: Consulta de material de sesión por usuario no autorizado

- GIVEN un usuario de negocio o cliente sin autorización para administrar secretos operativos
- WHEN solicita credenciales, archivos o datos de vinculación de una sesión
- THEN el backend deniega la solicitud y no expone el material sensible.

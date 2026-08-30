# Administración y aislamiento Specification

## Purpose

Gestionar negocios y accesos de una plataforma multiempresa con controles obligatorios en el backend.

## Requirements

### Requirement: Autenticación y administración de plataforma

El sistema MUST permitir al administrador general, como identidad separada, iniciar y cerrar sesión, crear y editar negocios, crear y administrar las credenciales iniciales del único usuario de cada negocio, y supervisar la plataforma.

#### Scenario: Administración autorizada

- GIVEN un administrador general autenticado
- WHEN crea un negocio y las credenciales de su usuario
- THEN el negocio y su único usuario quedan disponibles para la operación autorizada
- AND la acción queda auditada.

#### Scenario: Administración sin autorización

- GIVEN una solicitud sin autenticación o sin rol de administrador general
- WHEN intenta crear, editar o administrar un negocio ajeno
- THEN el backend rechaza la operación
- AND no revela datos protegidos del negocio.

### Requirement: Un único usuario de negocio y ámbito de acceso

El sistema MUST asociar exactamente un usuario de negocio a cada negocio. Ese usuario MUST poder iniciar y cerrar sesión y operar únicamente la información, configuración, conexión y automatización de su propio negocio; no habrá autoservicio de registro, invitaciones ni recuperación o restablecimiento de contraseña.

#### Scenario: Usuario opera su propio negocio

- GIVEN el único usuario autenticado de un negocio activo
- WHEN consulta o modifica un recurso permitido de su negocio
- THEN el backend permite la operación dentro de su ámbito.

#### Scenario: Intento de cruzar tenants

- GIVEN un usuario de negocio autenticado
- WHEN envía un identificador manipulado de otro negocio a una operación privada
- THEN el backend rechaza la solicitud
- AND no lee, modifica ni confirma la existencia del recurso ajeno.

### Requirement: Autorización y aislamiento estricto por tenant

El backend MUST validar autenticación, rol, asociación con el negocio y permiso en toda operación privada. MUST aislar por negocio toda información comercial, configuración del asistente, usuarios, sesiones y credenciales de WhatsApp, historial conversacional, estados, actividad técnica, auditoría y errores; la interfaz web no será un control de seguridad suficiente.

#### Scenario: Acceso indirecto a datos de otro tenant

- GIVEN un usuario autorizado de un negocio A
- WHEN solicita por cualquier operación privada historial, sesión, registro o configuración del negocio B
- THEN el backend deniega el acceso
- AND ningún dato del negocio B se incluye en la respuesta o en el contexto de procesamiento.

#### Scenario: Datos de identidad inválidos

- GIVEN una solicitud privada con sesión inválida, expirada o identidad no asociada a un negocio válido
- WHEN el backend evalúa la solicitud
- THEN la rechaza antes de acceder a datos del tenant.

### Requirement: Ciclo de vida del negocio

El administrador general MUST poder activar, suspender y reactivar negocios. La suspensión MUST bloquear el acceso del usuario del negocio y toda automatización de respuestas, conservar información protegida, credenciales, sesión e historial, y reflejarse en el estado visible. La reactivación MUST restaurar la elegibilidad de acceso y automatización conforme al estado conservado, sin activar por sí misma un asistente que estuviera inactivo.

#### Scenario: Suspensión contiene la operación

- GIVEN un negocio con usuario, sesión y asistente activo
- WHEN el administrador lo suspende
- THEN su usuario no puede acceder
- AND los mensajes entrantes no reciben respuestas automáticas
- AND los datos y materiales protegidos se conservan.

#### Scenario: Reactivación preserva el estado del asistente

- GIVEN un negocio suspendido cuyo asistente estaba inactivo al momento de suspenderse
- WHEN el administrador reactiva el negocio
- THEN el usuario vuelve a poder autenticarse
- AND el asistente permanece inactivo hasta una activación autorizada.

### Requirement: Estados de supervisión administrativa

El sistema MUST mostrar al administrador general, por cada negocio, nombre, estado del negocio, fecha de creación, estado del asistente, estado de WhatsApp y última actividad técnica. El usuario de negocio MUST poder consultar el estado de su asistente y de su conexión, pero no los de otros negocios.

#### Scenario: Supervisión de estado

- GIVEN un administrador general autenticado y negocios con estados distintos
- WHEN consulta el panel administrativo
- THEN obtiene los campos requeridos para cada negocio.

#### Scenario: Visibilidad limitada del usuario de negocio

- GIVEN un usuario de negocio autenticado
- WHEN solicita estados de otro negocio
- THEN el backend rechaza la solicitud.

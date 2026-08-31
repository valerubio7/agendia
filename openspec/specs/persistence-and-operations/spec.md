# Persistencia y operación Specification

## Purpose

Conservar los datos operativos necesarios y hacer observable el servicio sin exponer conversaciones ni secretos.

## Requirements

### Requirement: Persistencia principal y alcance de datos

El sistema MUST usar PostgreSQL como base de datos principal. MUST persistir, según corresponda, negocios, cuentas y sus relaciones, configuraciones, estados, metadatos de conexión, historial conversacional, actividad técnica, auditoría y fallos relevantes, preservando el aislamiento por tenant y la conservación exigida mientras exista el negocio.

#### Scenario: Recuperación de estado persistido

- GIVEN un negocio con configuración, asistente, sesión e historial previamente registrados
- WHEN el sistema necesita operar ese negocio después de una interrupción operativa prevista
- THEN recupera los datos persistidos autorizados sin mezclarlos con otro tenant.

#### Scenario: Negocio inexistente

- GIVEN una operación que referencia un negocio que no existe
- WHEN el backend la valida
- THEN la rechaza sin crear datos huérfanos ni revelar información de otros negocios.

### Requirement: Auditoría de eventos críticos

El sistema MUST generar registros de auditoría para accesos a la plataforma, cambios de configuración comercial o del asistente, vinculación y cambios relevantes de WhatsApp, activación o desactivación del asistente, y suspensión o reactivación de negocios. Los fallos relevantes de DeepSeek, de vinculación o conexión de WhatsApp y de envío de respuestas salientes MUST clasificarse también como eventos críticos de auditoría. Cada registro de auditoría MUST conservar el ámbito del negocio cuando aplique, la marca temporal, el resultado y el actor o la fuente que esté disponible, y estar protegido contra consulta cruzada entre tenants. La auditoría y los registros operativos son contratos distintos; un mismo registro MAY satisfacer ambos cuando contenga los requisitos de ambos contratos, sin reducir la cobertura de auditoría ni la de observabilidad operativa.

#### Scenario: Cambio crítico auditable

- GIVEN una operación autorizada que desactiva el asistente o suspende un negocio
- WHEN se completa
- THEN se crea un registro de auditoría del evento.

#### Scenario: Fallos técnicos críticos auditables

- GIVEN fallos relevantes de DeepSeek, de vinculación o conexión de WhatsApp, o de envío de una respuesta saliente asociados al negocio A
- WHEN el sistema procesa cada fallo
- THEN registra cada uno como evento crítico de auditoría con el ámbito del negocio A, la marca temporal, el resultado y el actor o la fuente disponible
- AND no incluye credenciales, material de sesión ni datos del negocio B.

#### Scenario: Auditoría no accesible entre tenants

- GIVEN un usuario del negocio A
- WHEN intenta consultar registros del negocio B
- THEN el backend deniega el acceso y no expone sus registros.

### Requirement: Actividad técnica, errores y visibilidad segura

El sistema MUST registrar actividad técnica y fallos relevantes, incluidos fallos de DeepSeek, desconexiones, necesidad de vinculación, errores de conexión de WhatsApp y fallos de envío. MUST actualizar la última actividad técnica y los estados observables que correspondan. Los registros y errores MUST ser útiles para supervisión sin contener secretos ni datos de otros tenants.

#### Scenario: Fallo técnico visible al administrador

- GIVEN un fallo de conexión o envío asociado a un negocio
- WHEN se registra el incidente
- THEN la última actividad y el estado aplicable quedan disponibles para la supervisión administrativa.

#### Scenario: Error sin filtración

- GIVEN un fallo técnico que incluye información sensible del proveedor o de una sesión
- WHEN se registra o comunica el error
- THEN no incluye credenciales, material de sesión ni datos de otro tenant.

### Requirement: Sin visor de conversaciones en agendIA

El sistema MUST conservar y usar el historial solo para la operación autorizada del asistente y MUST NOT ofrecer en agendIA una bandeja, visor, búsqueda ni gestión humana de conversaciones. La consulta humana de conversaciones se realizará directamente en WhatsApp.

#### Scenario: Panel sin consulta de conversaciones

- GIVEN un administrador general o usuario de negocio autenticado
- WHEN navega las funciones de agendIA
- THEN puede consultar los estados y la configuración autorizados
- AND no dispone de una función para ver, buscar o gestionar el contenido de conversaciones.

### Requirement: Validación y tratamiento seguro de errores

El backend MUST validar los datos recibidos y proteger los endpoints privados. Ante datos inválidos, permisos insuficientes, negocio suspendido, negocio inexistente o sesión no apta, MUST rechazar o detener la operación antes de efectos no autorizados, comunicar un resultado utilizable al actor autorizado cuando corresponda y registrar los fallos técnicos relevantes.

#### Scenario: Solicitud inválida no produce efectos

- GIVEN una solicitud privada con datos inválidos
- WHEN el backend la procesa
- THEN devuelve un error de validación utilizable
- AND no persiste cambios parciales ni inicia automatización.

#### Scenario: Mensaje de negocio suspendido

- GIVEN un texto individual asociado a un negocio suspendido
- WHEN llega el evento
- THEN el sistema no construye contexto, no invoca IA y no envía respuesta automática.

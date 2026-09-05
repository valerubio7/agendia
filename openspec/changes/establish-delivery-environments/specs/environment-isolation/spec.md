# Environment Isolation Specification

## Purpose

Impedir que los cuatro entornos mezclen estado, identidades, credenciales o material criptográfico.

## Requirements

### Requirement: Separación completa de datos y persistencia

Desarrollo, test, staging y producción MUST NOT compartir bases de datos PostgreSQL, datos, roles o credenciales de inicio de sesión de PostgreSQL, redes de estado ni volúmenes persistentes. Staging y producción SHALL tener identidades, redes, volúmenes y roles independientes aunque se ejecuten en el mismo host.

#### Scenario: Destrucción de staging aislada

- GIVEN staging y producción con estado independiente
- WHEN se elimina el estado de staging al finalizar una ventana
- THEN los datos, roles y volúmenes de producción permanecen sin cambios.

### Requirement: Separación de secretos e identidades de WhatsApp

Los entornos MUST NOT compartir secretos de aplicación o proveedores, sesiones, números ni material de vinculación de WhatsApp, KEK de Baileys, claves de cifrado de QR ni credenciales de bootstrap del administrador. Los secretos MUST NOT incorporarse a imágenes, ejemplos versionados, logs ni historial de Git; las URL de base de datos MUST tratarse como secretos.

#### Scenario: Configuración versionada segura

- GIVEN un ejemplo de configuración versionado y registros operativos de una release
- WHEN se inspeccionan para operar un entorno
- THEN no contienen credenciales utilizables, URL de base de datos ni material criptográfico
- AND no permiten reutilizar identidades de WhatsApp de otro entorno.

### Requirement: Validación de configuración por entorno

Cada proceso SHALL validar su configuración antes de servir tráfico o procesar trabajo. Ante una variable obligatoria ausente, una combinación insegura o una referencia cruzada entre entornos, el proceso MUST fallar de forma segura y MUST NOT iniciar actividad operativa.

#### Scenario: Referencia cruzada rechazada

- GIVEN la configuración de staging referencia una credencial o recurso de producción
- WHEN un proceso de staging inicia
- THEN rechaza la configuración antes de servir tráfico o procesar trabajo
- AND no revela el valor secreto en su salida.

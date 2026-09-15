# Delta for Persistence and Operations

## ADDED Requirements

### Requirement: Evidencia operativa redactada de despliegue y recuperación

El sistema MUST conservar, por entorno de despliegue, evidencia operativa redactada del resultado de verificación manual de CI e imagen, migración gobernada, bootstrap, convergencia, health, readiness, heartbeats, smoke y rollback cuando se ejecuten. La evidencia MUST identificar el entorno, commit limpio del checkout de tooling, versión de Bun, digest inmutable aplicable, resultado y marca temporal, sin incluir secretos, credenciales, URL de base de datos, material de sesión ni datos de otro tenant. La evidencia de rollback MUST distinguir explícitamente una reversión compatible de imagen/Compose de la recuperación de datos, y MUST NOT afirmar que se realizó un rollback SQL o restore externo cuando no ocurrió.

#### Scenario: Evidencia de convergencia exitosa

- GIVEN una convergencia de producción autorizada desde un checkout limpio verificado manualmente
- WHEN concluyen sus comprobaciones operativas
- THEN la evidencia identifica producción, commit de tooling, versión de Bun, digest, resultado y fecha de las comprobaciones realizadas
- AND no contiene secretos, URL de base de datos, material de sesión ni datos de otro tenant.

#### Scenario: Recuperación limitada registrada correctamente

- GIVEN un rollback compatible de imagen y Compose sin restauración de datos
- WHEN se conserva la evidencia de la operación
- THEN identifica el snapshot y resultado de rollback aplicados
- AND declara que no revierte SQL ni sustituye el procedimiento externo de backup y restore.

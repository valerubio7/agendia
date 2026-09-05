# Delta for Persistence and Operations

## ADDED Requirements

### Requirement: Operación segura de procesos de release

Los procesos de una release SHALL publicar health y readiness verificables y SHALL permitir cierre ordenado y reinicio controlado. La operación MUST aplicar límites de recursos, rotación de logs y diagnóstico seguro; los probes, logs y errores MUST NOT revelar secretos, material de sesión ni datos de otro tenant.

#### Scenario: Diagnóstico de proceso de release

- GIVEN un proceso de release iniciado con configuración válida
- WHEN un operador consulta su health, readiness y registros tras un reinicio
- THEN puede determinar su estado operativo
- AND la información expuesta no contiene secretos, material de sesión ni datos de otro tenant.

### Requirement: Migraciones y bootstrap gobernados

Las migraciones de producción SHALL ejecutarse como un paso operativo único, explícito y separado del arranque normal de réplicas de aplicación. Antes de una migración, el proceso MUST requerir preflight, backup verificable y una declaración de compatibilidad con el digest de aplicación anterior. El bootstrap de administración MUST ser un paso controlado y separado del arranque de aplicación; MUST NOT recrear ni reemplazar credenciales existentes de forma implícita.

#### Scenario: Arranque sin migración implícita

- GIVEN una release de producción lista para iniciar y una migración pendiente
- WHEN los procesos de aplicación arrancan normalmente
- THEN no ejecutan la migración ni bootstrap de forma implícita
- AND la migración requiere su paso controlado con preflight, backup y compatibilidad declarada.

### Requirement: Runbooks operativos separados

La documentación operativa SHALL distinguir los artefactos implementados en el repositorio, el aprovisionamiento único del host, los prerrequisitos externos, el despliegue y promoción de aplicación, el rollback de aplicación, la recuperación de datos y la reconstrucción completa del host. El rollback de aplicación MUST volver a un digest conocido sin reconstruirlo y MUST NOT declararse como recuperación de esquema o datos.

#### Scenario: Incidente con recuperación correcta

- GIVEN un incidente que requiere recuperar datos después de una migración incompatible
- WHEN un operador consulta los runbooks
- THEN encuentra un procedimiento de recuperación de datos distinto del rollback de aplicación
- AND no interpreta el cambio de digest como restauración de PostgreSQL o del host completo.

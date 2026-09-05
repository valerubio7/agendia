# Backup and Restore Specification

## Purpose

Asegurar que el estado de producción y el material criptográfico necesario puedan recuperarse fuera del host doméstico.

## Requirements

### Requirement: Backup externo diario cifrado

Producción SHALL realizar un backup diario cifrado fuera del PC que cubra PostgreSQL y el material necesario para recuperar las sesiones protegidas. La retención, el destino y el responsable MAY decidirse posteriormente, pero el backup MUST NOT depender exclusivamente del SSD del host.

#### Scenario: Backup diario fuera del host

- GIVEN producción con datos persistidos
- WHEN se completa el ciclo diario de backup
- THEN existe una copia cifrada fuera del PC que incluye PostgreSQL
- AND la evidencia identifica su resultado sin exponer secretos.

### Requirement: Custodia recuperable de claves históricas

El backup y su custodia MUST conservar todas las KEK históricas de Baileys necesarias para descifrar sesiones respaldadas y la clave de cifrado de QR correspondiente. Conservar únicamente ciphertext sin el material histórico requerido MUST NOT considerarse un backup recuperable.

#### Scenario: Sesión histórica recuperable

- GIVEN una sesión respaldada cuya DEK fue envuelta con una KEK histórica
- WHEN se prepara su restauración
- THEN está disponible la KEK histórica correspondiente y la clave QR requerida
- AND la sesión no se declara recuperable si falta ese material.

### Requirement: Restore drill aislado con evidencia RPO y RTO

El sistema SHALL definir un restore drill aislado que restaure PostgreSQL y verifique el acceso al material criptográfico histórico sin mezclar estado restaurado con producción o staging. El drill MUST generar evidencia de la fecha recuperada y del tiempo empleado para que se puedan verificar los objetivos de RPO y RTO definidos para la operación.

#### Scenario: Restauración aislada verificada

- GIVEN un backup externo cifrado y una custodia de claves disponible
- WHEN se ejecuta el restore drill en un entorno aislado
- THEN PostgreSQL se restaura y se verifica el acceso a las claves históricas necesarias
- AND se registra la fecha recuperada y la duración del ejercicio.

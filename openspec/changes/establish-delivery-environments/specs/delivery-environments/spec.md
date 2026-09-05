# Delivery Environments Specification

## Purpose

Definir una ruta de entrega verificable que separe desarrollo, test, staging y producción sin alterar el comportamiento funcional del producto.

## Requirements

### Requirement: Desarrollo local preservado y aislado

El sistema SHALL preservar el flujo cotidiano de desarrollo en la estación de trabajo, incluidos el comando de desarrollo, la configuración local y PostgreSQL local. El entorno de desarrollo MUST permanecer en la estación de trabajo y MUST NOT usar datos, secretos, sesiones, servicios ni estado remoto de staging o producción.

#### Scenario: Desarrollo sin dependencia remota

- GIVEN una estación de trabajo con la configuración local autorizada
- WHEN una persona desarrolla o ejecuta el flujo local existente
- THEN puede iterar sin conectarse a staging ni a producción
- AND no consume su estado ni sus credenciales.

### Requirement: Test efímero y determinista

El sistema SHALL proporcionar pruebas que usen dependencias efímeras y PostgreSQL descartable, con dobles deterministas para Baileys y DeepSeek. Las pruebas MUST NOT requerir proveedores ni secretos reales y MUST ser ejecutables tanto localmente como en un futuro runner de CI.

#### Scenario: Ejecución de pruebas sin proveedores reales

- GIVEN un entorno de pruebas sin secretos de proveedores
- WHEN se ejecuta la suite de pruebas determinista
- THEN crea y descarta sus dependencias de prueba
- AND usa dobles deterministas sin contactar Baileys ni DeepSeek reales.

### Requirement: Staging temporal y producción persistente

El sistema SHALL definir staging y producción como pilas separadas en el mismo host doméstico. Staging MUST ser privado, temporal y activarse únicamente en ventanas controladas; producción MUST conservar el estado real de usuarios y ser la única pila normalmente activa de forma continua. Staging MAY eliminarse y recrearse sin afectar producción.

#### Scenario: Ventana de staging controlada

- GIVEN producción está activa en el host doméstico
- WHEN se autoriza una ventana de staging
- THEN staging se inicia como una pila privada y aislada
- AND puede detenerse y eliminarse sin modificar datos ni procesos de producción.

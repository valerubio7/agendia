# Immutable Release Promotion Specification

## Purpose

Garantizar que una release probada conserve los mismos bytes al avanzar entre test, staging y producción.

## Requirements

### Requirement: Artefacto de release único e inmutable

La ruta de release SHALL construir una sola vez por commit un artefacto coherente para web, API, manager y worker a partir de dependencias bloqueadas. El artefacto MUST tener una identidad inmutable por digest; una etiqueta mutable por sí sola MUST NOT constituir evidencia de la release ni de su promoción.

#### Scenario: Identidad verificable de una release

- GIVEN un commit candidato aprobado para construir
- WHEN la ruta de release genera su artefacto
- THEN registra un digest inmutable que identifica los bytes de los cuatro procesos
- AND no usa únicamente una etiqueta mutable como prueba de identidad.

### Requirement: Puertas y procedencia de release

Las puertas de CI y las ejecuciones locales SHALL ejecutar las suites de prueba aplicables antes de construir y comprobaciones sobre el artefacto arrancado en modo release. Los procesos de release MUST NOT depender de servidores de desarrollo. La evidencia de release MUST asociar el commit, el digest, los resultados de las puertas y la aprobación de promoción aplicable.

#### Scenario: Artefacto arrancado como release

- GIVEN un artefacto construido para un commit candidato
- WHEN se ejecutan las comprobaciones de release
- THEN los cuatro procesos se inician en modo release
- AND la evidencia conserva el digest, el commit y los resultados de las puertas.

### Requirement: Promoción por digest independiente de ramas

Staging MUST desplegar el digest candidato con su propia configuración y secretos. Producción MUST recibir exactamente el digest ya validado en staging, sin reconstrucción ni copia de árboles de trabajo al host. La selección de una rama MUST NOT determinar los bytes desplegados ni la configuración de un entorno; las ramas MAY activar automatización, pero MUST NOT sustituir la selección explícita por digest ni las puertas de promoción.

#### Scenario: Promoción sin reconstrucción

- GIVEN un digest validado en staging y aprobado para producción
- WHEN se promueve la release
- THEN producción despliega ese mismo digest con su configuración de producción
- AND no se reconstruye el artefacto ni se elige otro por la rama de origen.

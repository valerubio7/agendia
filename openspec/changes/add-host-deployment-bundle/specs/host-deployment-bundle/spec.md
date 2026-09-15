# Host Deployment Operations Specification

## Purpose

Operar el primer despliegue SOLO-PILOT desde tooling propiedad del repositorio, ejecutado con fuentes y runtimes fijados, conservando releases de aplicación inmutables por digest y sin requerir un paquete host independiente.

## Requirements

### Requirement: Preflight de fuentes y herramientas fijadas

Antes de cualquier operación de despliegue, el PC central y el host MUST usar un checkout limpio fijado al commit exacto de la release. El procedimiento MUST comprobar que el árbol no contiene cambios locales y que el commit esperado coincide; MUST rechazar una rama, revisión o checkout arbitrario distinto. El PC central MUST usar una versión fijada de `gh`; el host MUST usar una versión fijada de Bun para ejecutar el tooling del repositorio, y las dependencias necesarias MUST respetar el lockfile sin resolución flotante. Las versiones concretas y comandos compatibles MAY definirse en diseño, pero Bun y el checkout del host MUST prepararse explícitamente antes de operar y MUST NOT suponerse ya instalados.

#### Scenario: Preflight de despliegue válido

- GIVEN checkouts limpios del PC central y host fijados al commit de release esperado
- AND versiones fijadas de `gh` en el PC central y Bun en el host
- WHEN el operador ejecuta el preflight
- THEN permite continuar con el tooling de ese commit y sus dependencias bloqueadas.

#### Scenario: Deriva de checkout o runtime

- GIVEN un checkout modificado, una revisión distinta, una versión de herramienta no fijada o dependencias fuera del lockfile
- WHEN se intenta iniciar una operación de despliegue
- THEN el preflight la bloquea antes de invocar el runtime o Docker/Compose.

### Requirement: Verificación manual de CI e imagen en el PC central

El PC central MUST verificar manualmente con `gh` fijado los artefactos y attestations exactos de CI e imagen correspondientes al repositorio, workflow/run, commit y digest aprobados. La evidencia operativa MUST conservar de forma redactada el contexto de repositorio, workflow/run, commit, digest de imagen, autorización y SBOM/provenance aplicables. Una declaración local `verified: true` MUST NOT sustituir esa verificación real. Si falta evidencia, la verificación falla o el contexto no coincide, la operación MUST detenerse. El host MUST NOT conservar un token GitHub persistente ni afirmar que verifica independientemente un paquete host.

#### Scenario: Evidencia de release verificada manualmente

- GIVEN el commit y digest candidato aprobados
- WHEN el operador verifica con `gh` fijado los artefactos y attestations de CI e imagen
- THEN conserva evidencia redactada que los vincula al repositorio, run, commit, digest, autorización, SBOM y provenance esperados.

#### Scenario: Evidencia ausente o no coincidente

- GIVEN evidencia incompleta, una attestation no verificable o un contexto distinto del commit o digest aprobado
- WHEN se solicita continuar el despliegue
- THEN la operación se bloquea
- AND un booleano local de éxito no permite continuar.

### Requirement: Operación SSH con tooling cerrado de fuentes fijadas

El operador MUST ejecutar `scripts/deployctl.ts` y su tooling de operador desde el checkout limpio aprobado mediante Bun fijado, sobre SSH autenticado con la clave del host ya verificada. El checkout MAY alojar tooling de operador, pero MUST NOT usarse para construir imágenes de aplicación ni ejecutar aplicaciones desde fuentes, `tsx` o `next dev`. El CLI MUST aceptar solo operaciones documentadas y argumentos validados para `staging` o `production`; MUST NOT aceptar shell libre, checkout alternativo, builds, pushes, runner CI, puertos host ni acciones destructivas nuevas. Las credenciales GHCR de solo lectura MUST permanecer separadas de fuentes, configuración no secreta y evidencia.

#### Scenario: CLI cerrado desde el commit aprobado

- GIVEN un checkout limpio y Bun fijado en el host para el commit aprobado
- WHEN el operador autorizado ejecuta una operación permitida mediante SSH autenticado
- THEN se ejecuta el CLI de ese checkout con argumentos controlados
- AND no construye ni ejecuta una aplicación desde fuentes.

#### Scenario: Entrada o fuente no permitida

- GIVEN una solicitud con shell libre, checkout alternativo, build, push, runner CI, puerto host o acción destructiva no documentada
- WHEN el CLI la recibe
- THEN la rechaza antes de invocar Docker o Compose.

### Requirement: Runtime de aplicación inmutable y recuperación compatible

El adaptador MUST validar plataforma `amd64` y operar imágenes de aplicación exclusivamente por digest inmutable mediante pull e inspección controlados. Staging MUST validar un digest candidato con su configuración aislada y producción MUST recibir exactamente ese digest autorizado, sin reconstrucción ni copia de árboles de trabajo. Por entorno, el CLI MUST conservar Compose renderizado, evidencia redactada y un snapshot atómico `{current,previous}` bajo `/srv/agendia/{production,staging}/release/`. El rollback MUST usar solo un snapshot compatible de imagen y Compose; MUST NOT deshacer migraciones SQL, borrar datos o identidades. Ante incompatibilidad, fallo de bootstrap o necesidad de recuperación de datos, MUST detenerse y remitir al procedimiento operativo aplicable.

#### Scenario: Promoción staging a producción por digest

- GIVEN un digest `amd64` validado en staging y autorizado para producción
- WHEN el operador aplica la promoción mediante el CLI permitido
- THEN producción converge al mismo digest con configuración y estado aislados
- AND no se reconstruye ni se selecciona una imagen por rama o tag.

#### Scenario: Recuperación no equivale a rollback SQL

- GIVEN un snapshot previo incompatible o una migración que requiere recuperación de datos
- WHEN el operador solicita rollback
- THEN el CLI no revierte SQL ni borra datos o identidades
- AND bloquea el rollback incompatible y conserva la evidencia disponible.

### Requirement: Bundle de Slice 1 opcional y no autoritativo

El artefacto determinista de Slice 1 MAY conservarse como artefacto futuro opcional, pero MUST NOT ser autoridad de confianza, prerrequisito ni ruta de instalación del primer despliegue SOLO-PILOT. El primer despliegue MUST NOT requerir transferencia de bundle, checksum, extracción, instalación por hash, enlace de activación ni verificador separado. La evidencia de CI e imagen MUST NOT presentarse como attestation independiente de un checkout o paquete host.

#### Scenario: Primer despliegue sin bundle

- GIVEN un PC central y host que completaron el preflight de fuentes, runtimes y evidencia manual requeridos
- WHEN el operador prepara el primer despliegue SOLO-PILOT
- THEN puede continuar sin bundle, checksum, instalador ni verificador separado
- AND el bundle opcional no altera la autoridad de confianza.

### Requirement: Continuidad revisable de slices

La entrega MUST conservar la trazabilidad de cinco slices `feature-branch-chain`: Slice 1 permanece como artefacto opcional futuro, Slice 2 de instalación separada está retirada, y las slices 3–5 continúan con runtime/rollback, configuración/one-shots y bootstrap/runbook respectivamente. Cada slice activa MUST incluir sus pruebas esenciales y modificar como máximo 400 líneas de código, pruebas y documentación combinadas. El tracker MUST permanecer draft/no-merge y conservar la relación de ramas existente. Si una slice activa supera el límite, el trabajo MUST detenerse bajo `ask-on-risk`; MUST NOT inferir `size:exception` ni crear slices nuevas.

#### Scenario: Revisión de una slice activa

- GIVEN una slice activa preparada para apply
- WHEN se calcula su diff completo, incluidas pruebas y documentación
- THEN respeta su unidad de entrega y no supera 400 líneas cambiadas.

#### Scenario: Riesgo de exceso de tamaño

- GIVEN que el forecast o diff de una slice activa supera 400 líneas
- WHEN se evalúa antes de apply
- THEN el trabajo se detiene para una decisión humana bajo `ask-on-risk`
- AND no crea una excepción de tamaño ni una slice adicional.

# Host Bootstrap Operations Specification

## Purpose

Conectar la configuración aislada y los pasos de primer arranque al tooling de operador ejecutado desde fuentes fijadas, sin iniciar aplicaciones con secretos incorrectos, estado incompleto ni una identidad administrativa sustituida.

## Requirements

### Requirement: Inyección aislada de configuración y secretos por proceso

Cada proceso de `staging` y `production` MUST recibir únicamente su configuración no secreta y las rutas de archivo `*_FILE` correspondientes a su entorno. La configuración renderizada MUST entregar rutas de archivos secretos sin interpolar ni imprimir sus valores. Los procesos normales MUST NOT usar una `DATABASE_URL` genérica. Antes de iniciar aplicaciones, el sistema MUST rechazar una variable obligatoria ausente, una ruta de secreto ausente o una referencia de configuración, secreto, base de datos, red o identidad cruzada entre entornos.

#### Scenario: Proceso configurado correctamente

- GIVEN un proceso de producción con su configuración no secreta y las rutas `*_FILE` de producción válidas
- WHEN se prepara su arranque
- THEN recibe solo esas referencias de configuración y secretos
- AND no recibe valores secretos ni una `DATABASE_URL` genérica.

#### Scenario: Configuración ausente o cruzada

- GIVEN un proceso con una variable obligatoria ausente o una referencia a un recurso de otro entorno
- WHEN se valida antes del arranque
- THEN la validación falla antes de iniciar actividad de aplicación
- AND el resultado no expone el valor secreto.

### Requirement: Orden de bootstrap y convergencia inicial

Para un entorno vacío o que requiera los pasos gobernados, el sistema MUST ejecutar en este orden: PostgreSQL saludable, provisionamiento de roles, migración gobernada, inicialización de colas, bootstrap de primer administrador cuando corresponda, convergencia de aplicaciones y health/readiness/heartbeats y smoke privado existentes. PostgreSQL inicial MUST levantar solo el servicio necesario hasta que esté saludable. Los one-shots MUST usar únicamente la red y mounts mínimos del proyecto. Un fallo MUST detener la secuencia, MUST NOT marcar éxito y MUST NOT iniciar aplicaciones normales antes de completar los pasos predecesores requeridos.

#### Scenario: Primer arranque completo

- GIVEN un entorno sin inicializar y configuración válida
- WHEN el operador realiza el primer bootstrap autorizado
- THEN PostgreSQL se confirma saludable antes de roles, migración y colas
- AND las aplicaciones convergen solo después del bootstrap de administrador aplicable
- AND health, readiness, heartbeats y smoke se evalúan después de la convergencia.

#### Scenario: Fallo de un one-shot

- GIVEN que roles, migración, colas o bootstrap falla
- WHEN la secuencia detecta el fallo
- THEN no inicia los procesos normales posteriores
- AND conserva un resultado de fallo redactado para reintento o recuperación segura.

### Requirement: Bootstrap único del administrador con secreto efímero

El bootstrap del primer administrador MUST ser un paso explícito, idempotente y separado del arranque normal. Cuando sea aplicable, MUST leer su secreto exclusivamente desde un archivo root-only de un solo uso en tmpfs bajo `/run`. Tras éxito, MUST desvincular y eliminar el archivo; la evidencia MUST registrar solo resultado y fecha. El sistema MUST NOT registrar el secreto, conservarlo en el checkout, estado, evidence, logs ni archivos de identidad no secreta, y MUST NOT reemplazar un administrador existente. Un fallo MUST conservar el estado necesario para un reintento seguro sin declarar bootstrap correcto ni revelar el secreto.

#### Scenario: Consumo correcto del secreto de primer administrador

- GIVEN que no existe un administrador y existe un archivo root-only de secreto en tmpfs bajo `/run`
- WHEN el bootstrap termina correctamente
- THEN se crea el primer administrador sin exponer el secreto
- AND el archivo queda eliminado y la evidencia conserva solo resultado y fecha.

#### Scenario: Administrador existente o bootstrap fallido

- GIVEN que ya existe un administrador, o que el bootstrap no puede completarse
- WHEN se solicita bootstrap
- THEN no reemplaza la identidad existente ni registra éxito falso
- AND no expone ni persiste el secreto en salida, estado o evidencia.

### Requirement: Gates operativos externos visibles y bloqueantes

Los runbooks y la evidencia de operación MUST distinguir la entrega simulada del repositorio de la habilitación operativa y de la admisión de usuarios reales. El timer de backup que apunta a un ejecutable no entregado MUST permanecer deshabilitado; el sistema MUST NOT crear enlaces rotos ni declarar el backup operativo. La admisión de usuarios reales MUST permanecer bloqueada hasta que exista evidencia aceptada de túnel, dominio y DNS operables; backup externo con restore probado; secretos e identidades separados; y la aceptación explícita de Wi-Fi sin UPS como riesgo doméstico. La aceptación de ese riesgo MUST NOT sustituir backup ni restore externo.

#### Scenario: Gate externo pendiente

- GIVEN que falta evidencia de backup externo con restore probado, o cualquier otro gate externo requerido
- WHEN un runbook o un operador evalúa la admisión de usuarios reales
- THEN la admisión permanece bloqueada
- AND el tooling desde fuentes no afirma que las pruebas simuladas preparan producción para usuarios reales.

#### Scenario: Ejecutable de backup ausente

- GIVEN que no se entrega un ejecutable de backup funcional
- WHEN se documenta la operación del host
- THEN el timer relacionado permanece deshabilitado
- AND no se crea un enlace roto ni se presenta backup como operativo.

### Requirement: Contrato operativo simulable y documentado

El runbook MUST documentar el preflight de checkout limpio y commit exacto, las versiones fijadas de `gh` y Bun, la verificación manual de artefactos y attestations de CI/imagen con `gh` en el PC central, la operación SSH autenticada con la clave de host ya verificada, privilegios sudo, preparación de configuración, primer arranque, actualización, smoke, rollback y gates externos. Sus contratos de runtime MUST poder ejercerse con una raíz temporal y dobles Docker/Compose sin credenciales, Docker real, contacto con el servidor ni modificación de rutas reales del host.

#### Scenario: Validación integral sin host real

- GIVEN una raíz temporal y dobles controlados de Docker y Compose
- WHEN se ejecuta el contrato de preflight de fuentes y primer arranque
- THEN comprueba checkout limpio, runtime fijado, aislamiento por entorno, orden operativo y resultados redactados
- AND no accede a `/etc` o `/srv` reales, Docker real, credenciales ni al servidor.

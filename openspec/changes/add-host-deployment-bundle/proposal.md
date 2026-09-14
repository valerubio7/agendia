# Propuesta: add-host-deployment-bundle

## Intención

Hacer operable el primer despliegue SOLO-PILOT en el Ubuntu 26.04 x86_64 preparado mediante tooling de operador propiedad del repositorio, ejecutado desde un checkout limpio fijado al commit exacto de la release y con Bun de versión fijada en el host. Los contenedores de aplicación siguen usando exclusivamente imágenes inmutables por digest.

La decisión humana final sustituye el bundle instalado como camino obligatorio. El identificador del cambio se conserva por continuidad; el trabajo determinista de Slice 1, declarado completado por el usuario, se retiene como artefacto opcional futuro, no como prerrequisito del primer despliegue. Esta fase no vuelve a verificar su implementación.

El destinatario es `valerubio7`, operador LAN. El resultado conecta los contratos existentes de promoción, runtime, configuración, bootstrap y recuperación; no automatiza despliegues desde GitHub ni habilita usuarios reales.

## Autoridad y decisiones confirmadas

Esta revisión sigue la dirección humana final y `preproposal.md`, que sustituyen las recomendaciones incompatibles de `exploration.md` y las decisiones previas de confianza. Se mantienen ejecución automática, artefactos OpenSpec, research no seleccionado y ausencia de entrevista.

- El PC central usa un checkout limpio fijado al commit exacto de release y verifica manualmente con una versión fijada de `gh` los artefactos y attestations de CI/imagen de GitHub correspondientes.
- Se registra contexto de repositorio, workflow/run, commit, digest de imagen, autorización y evidencia aplicable de SBOM/provenance. La verificación humana real no se sustituye por un booleano local `verified: true`.
- El PC transfiere únicamente configuración/evidencia requerida o actúa mediante SSH autenticado, con la clave del host ya verificada. No transfiere ni instala un paquete host como condición del primer despliegue; no se guarda un token GitHub persistente en el host.
- El host instalará/usará Bun de versión fijada y ejecutará tooling del repositorio desde ese mismo commit limpio. El procedimiento debe documentar cómo disponer de ese checkout exacto sin introducir un instalador/verificador de bundle; no se afirma que Bun o ese checkout estén ya instalados.
- No se afirma que exista un paquete host independientemente verificado. La confianza SOLO-PILOT reside en el PC y operador confiables, verificación manual de CI/imagen, checkout exacto limpio, runtimes fijados y operación SSH autenticada.
- `valerubio7` conserva sudo; ninguna cuenta de operador o aplicación ingresa al grupo docker.
- El secreto del primer administrador se entrega root-only, una sola vez, mediante tmpfs bajo `/run` y se elimina tras éxito.
- Se preserva promoción manual staging → producción del mismo digest, aislamiento de entornos y tenant, Docker CE/Compose existentes y rutas separadas `/etc/agendia` y `/srv/agendia`.
- Wi-Fi/sin UPS está aceptado sin eximir backup externo y restore probado.

Se conservan las restricciones de `openspec/config.yaml` y los límites V1, sin inferir mercado/modelo comercial. En la fase inicial no estaban disponibles `AGENTS.md` ni `PRODUCT.md` en la raíz; esta revisión no añade decisiones de producto fuera del handoff.

## Alcance seleccionado

### 1. Operación desde fuentes fijadas y evidencia manual

Documentar un procedimiento mínimo para comprobar commit exacto y checkout limpio tanto en el PC central como en el checkout ejecutado en el host. Fijar explícitamente versiones de `gh` y Bun, y respetar el lockfile del repositorio para las dependencias necesarias, sin resolución flotante ni cambios locales durante la operación. Las versiones concretas y comandos existentes compatibles se precisan en diseño, sin ampliar el producto.

La verificación manual con `gh` en el PC central debe relacionar los artefactos/attestations de CI e imagen con el repositorio, workflow/run, commit y digest aprobados. Conservar evidencia redactada y autorización por entorno. Si la verificación falla, falta evidencia o el checkout no coincide/está modificado, detener la operación; una declaración local de éxito no reemplaza la comprobación.

No desarrollar un verificador separado, recibo firmado, instalador SSH de bundle, protocolo Ed25519, parser tar propio ni instalador Python. Tampoco exigir transferencia de tarball/checksum, extracción, instalación por hash o enlace de activación de paquete host. La evidencia de CI/imagen no se presenta como attestation independiente del checkout o de un paquete host.

### 2. Tooling del repositorio y adaptador host

Conectar `scripts/deployctl.ts` y sus contratos con operaciones Docker/Compose permitidas y argumentos controlados, ejecutadas mediante Bun fijado desde el checkout aprobado. El checkout aloja tooling de operador, no el runtime de aplicación: no construir imágenes en el host ni ejecutar aplicaciones desde fuentes, `tsx` o `next dev`.

Mantener pull/inspect de imágenes por digest y plataforma amd64, autorización existente y gates sin bypass. Las credenciales GHCR de solo lectura permanecen separadas de fuentes, configuración no secreta y evidencia. El adaptador no admite shell libre, pushes, runner CI ni acciones destructivas nuevas.

Conservar por entorno Compose renderizado, evidencia y snapshot atómico `{current,previous}` bajo `/srv/agendia/{production,staging}/release/`. La activación de release y recuperación conservan la semántica atómica existente; retirar el instalador de bundle no retira estas garantías.

### 3. Configuración y bootstrap seguro

Conectar cada proceso con configuración no secreta y rutas `*_FILE` de su entorno. Rechazar archivos ausentes/cruzados antes de iniciar aplicaciones; no reintroducir `DATABASE_URL` genérica para procesos normales ni persistir secretos en checkout, estado, evidencia o logs.

Habilitar en la imagen los comandos one-shot mínimos necesarios. Orden obligatorio: PostgreSQL saludable → roles → migración gobernada → queue-init → primer administrador cuando corresponda → aplicaciones → health/readiness/heartbeats y smoke privado existentes.

Usar red y mounts mínimos por entorno. Preservar idempotencia aplicable; no reemplazar un administrador existente. El secreto root-only bajo `/run` se consume una vez y se desvincula tras éxito, registrando solo resultado/fecha. Fallos no filtran secretos, marcan éxito ni permiten arranque prematuro; specs/diseño precisarán reintento y limpieza segura.

### 4. Runbook y validación local

Documentar preparación posterior de Bun/checkout, verificación manual con `gh`, operación SSH, configuración/evidencia mínima, primer arranque, promoción staging → mismo digest en producción, smoke y recuperación. Ningún paso de ese runbook se ejecuta durante esta fase de repositorio.

Contratos usan directorios temporales y Docker/Compose falso sin credenciales ni contacto con el servidor. Cada incremento incluye pruebas propias mediante TDD estricto; pruebas simuladas no son evidencia de host preparado.

No entregar ejecutable/proveedor de backup. Mantener deshabilitado el timer dirigido al ejecutable ausente y visible el gate externo, sin enlaces rotos ni afirmaciones de backup operativo.

## Fuera de alcance

- Todo trabajo separado de verificación/instalación de bundle para el primer SOLO-PILOT, incluso la anterior solución SSH/SCP + checksum + instalación estándar.
- Eliminar el trabajo determinista ya completado de Slice 1 o convertirlo en requisito del primer despliegue.
- Afirmar verificación independiente de paquete host o automatizar la verificación manual mediante un nuevo subsistema de confianza.
- Rediseñar los cuatro entornos, promoción, capacidades de negocio o aislamiento multiempresa.
- Implementar/configurar Cloudflare, DNS, túneles, restic, age o repositorios/proveedores de backup.
- Tokens GitHub persistentes en host, builds de aplicación en host, puertos host nuevos, socket Docker en aplicaciones o incorporación al grupo docker.
- Rollback SQL, evidencia externa fabricada o aceptación de riesgos adicionales.
- En esta fase: código, instalación de herramientas, despliegue, contacto con host, Docker, commit, push o subagentes.

## Áreas afectadas previstas

| Área | Alcance |
| --- | --- |
| Release CI/packaging de Slice 1 | Conservar artefacto determinista opcional; fuera de la ruta crítica |
| `scripts/deployctl.ts` y tooling de operador | Ejecución con Bun fijado, adaptador Docker/Compose, estado/evidencia/rollback |
| `scripts/render-compose.ts`, `deploy/compose.yml` | Configuración por proceso y one-shots aislados |
| Build de imagen, dispatcher y runtime-config | Comandos funcionales mínimos de provisionamiento/bootstrap |
| Contratos y runbooks | Checkout limpio/exacto, versiones fijadas, verificación manual, SSH y recuperación |
| Documentación/systemd de backup | Deshabilitación honesta y gates externos, sin proveedor |

## Entrega y continuidad de slices

Se conserva la trazabilidad de las cinco slices `feature-branch-chain` documentadas, sin inventar una nueva estrategia de ramas ni una excepción de tamaño. La decisión final elimina su dependencia funcional del instalador:

| Slice previa | Disposición confirmada |
| --- | --- |
| 1 — bundle determinista y CI provenance | Completada según el usuario; conservar como artefacto opcional futuro, no requisito del primer despliegue |
| 2 — verificación/instalación separada PC→host | Retirada del alcance seleccionado; no continuar ni sustituir por otro instalador |
| 3 — runtime, CLI, estado/evidencia/rollback | Continúa desde fuentes del repositorio con Bun fijado |
| 4 — configuración y one-shots/genesis | Continúa con aislamiento y orden gobernado |
| 5 — bootstrap, contrato integral y runbooks | Continúa e incorpora el procedimiento manual de fuentes fijadas |

El límite sigue siendo 400 líneas cambiadas por slice activa, incluyendo código, pruebas y docs. Mantener tracker draft/no-merge y relación de ramas existente; tasks debe actualizar dependencias para no exigir Slice 2 ni el bundle opcional antes del primer deploy. No reescribir ramas, borrar código previo ni publicar desde esta revisión. Si la redistribución amenaza el presupuesto, detenerse bajo `ask-on-risk`; no inferir `size:exception` ni nuevas slices. Ninguna slice aislada autoriza despliegue o usuarios reales.

## Gates separados

**Entrega del repositorio:** tooling ejecutable desde el commit limpio exacto, versiones fijadas documentadas, procedimiento manual de verificación CI/imagen, adaptador seguro, configuración, bootstrap y recuperación comprobables. No depende de verificador/instalador de paquete host ni del bundle opcional.

**Despliegue operativo posterior:** requiere autorización explícita, preparación de Bun/checkout en host y controles existentes de promoción/evidencia. Validar staging antes de promover el mismo digest a producción; no reconstruir ni sustituir por una tag. La propuesta no autoriza ejecutar esos pasos ni saltar gates de primer arranque.

**Usuarios reales:** permanece bloqueado hasta evidencia externa de túnel/dominio/DNS, backup externo con restore probado y secretos/identidades separados. Conservar aceptación explícita de Wi-Fi/sin UPS sin sustituir backup. Ni el tooling desde fuentes ni Slice 1 satisfacen estos gates.

## Riesgos y mitigación

- **Deriva de fuentes/runtime:** commit exacto, checkout limpio, versiones Bun/gh fijadas y dependencias gobernadas por lockfile; detenerse ante discrepancias, sin editar tooling durante operación.
- **Error de verificación manual o PC comprometido:** registrar contexto exacto y resultado de verificación real con `gh`, exigir aprobación del operador y SSH con clave host ya verificada. Reconocer este límite humano SOLO-PILOT; no atribuir protección de paquete independientemente verificado.
- **Privilegios y secretos:** sudo del operador, allowlist sin shell libre, mounts/config mínimos y evidencia redactada; ninguna cuenta entra al grupo docker.
- **Arranque parcial/configuración cruzada:** validación previa por entorno y orden gobernado de one-shots antes de aplicaciones.
- **Bootstrap inseguro:** archivo tmpfs root-only, eliminación tras éxito y rechazo de reemplazo del administrador.
- **Recuperación incompatible:** rollback de imagen/state/Compose únicamente compatible, nunca SQL automático.
- **Expansión o falsa preparación:** no reintroducir instaladores/proveedores, mantener presupuesto y gates externos independientes.

## Rollback

Conservar snapshot `{current,previous}`, Compose y evidencia por entorno conforme al contrato atómico existente. Ante fallo, no declarar activación exitosa; recuperar solo una release compatible por digest sin revertir SQL, borrar datos o identidades.

Registrar commit y versión de Bun usados por el tooling. Una recuperación que requiera otra revisión del tooling debe usar un checkout limpio explícitamente seleccionado y compatible con state/formatos existentes; no cambiar fuentes a ciegas. No existe requisito de rollback de enlace/paquete host porque el instalador está fuera del camino seleccionado. Restaurar datos sigue dependiendo del procedimiento externo de backup/restore.

## Criterios de éxito

1. El runbook selecciona tooling de repositorio desde el commit exacto limpio con Bun fijado en host y `gh` fijado en PC; no necesita bundle, verificador o instalador separado.
2. La verificación manual documenta artefactos/attestations exactos de CI/imagen y contexto de repositorio/run/commit/digest/autorización. Fallos o evidencia ausente bloquean operación; no se afirma paquete host independientemente verificado.
3. Se documenta SSH autenticado para operar o transferir solo configuración/evidencia requerida, sin token GitHub persistente en host ni protocolo/recibo de firma propio.
4. Contratos enfocados comprueban restricciones de entradas/ejecución y runner falso: pull/inspect por digest amd64, orden PostgreSQL→roles→migrate→queue-init→bootstrap aplicable→apps y fallo cerrado.
5. Configuración ausente/cruzada se rechaza; cada proceso recibe `_FILE` correcto sin filtración de secretos. Se preserva aislamiento staging/producción y multiempresa.
6. Bootstrap conserva idempotencia aplicable, rechazo de reemplazo y secreto root-only de un solo uso eliminado tras éxito.
7. Se conserva promoción staging→producción del mismo digest, health/smoke, evidencia redactada, activación/state atómicos y rollback compatible, sin rollback SQL.
8. Slice 1 permanece opcional; Slice 2 instalador deja de ser dependencia. Las slices activas cumplen 400 líneas y pruebas propias, con gates externos y backup deshabilitado explícitos.
9. La validación de repositorio utiliza temporales y dobles, sin tocar host, `/etc`/`/srv` reales ni Docker real para estos contratos. Esta propuesta no aporta evidencia de ejecución o despliegue.

## Siguiente fase

Alinear specs, diseño y tasks con la decisión final: retirar requisitos/dependencias del instalador y verificador separados, conservar Slice 1 opcional y precisar invocación del tooling/versions fijadas sin reabrir producto. No modificar esos artefactos, implementar ni operar el host en esta fase.

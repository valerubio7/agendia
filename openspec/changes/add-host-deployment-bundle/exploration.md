# Exploración: add-host-deployment-bundle

## Resultado del phase contract

| Campo | Resultado |
| --- | --- |
| Fase | `explore` |
| Cambio | `add-host-deployment-bundle` |
| Estado recomendado | listo para propuesta acotada, sujeto a los gates indicados |
| Artifact store | `openspec` |
| Skill resolution | `paths-injected` — se leyó `gentle-ai/SKILL.md` provisto por el padre |
| Mutaciones realizadas | solo este artefacto OpenSpec; no se desplegó, contactó host, ejecutó Docker, cometió, publicó ni creó subagentes |
| Navegación | existe `.codegraph/`, pero no se expuso MCP/CLI CodeGraph ni una herramienta shell en esta sesión; se usó lectura dirigida como respaldo |

## Objetivo confirmado y no objetivos

El objetivo mínimo es hacer **operable y verificable** el primer despliegue oficial en el Ubuntu x86_64 ya preparado, reutilizando la ruta existente de release por digest. No se rediseñan los cuatro entornos, proveedores Cloudflare/restic/age, backup externo, DNS, ni se toca el host.

El resultado no será un sistema de despliegue automático desde GitHub. La promoción sigue siendo pull-based, con autorización manual staging/producción por el mismo digest y operación LAN. El bundle tampoco satisface por sí mismo los gates externos para admitir usuarios reales.

## Hechos reutilizables comprobados

- CI ya construye una imagen universal `linux/amd64`, la publica por digest en GHCR y emite manifest, SBOM, provenance y release evidence (`.github/workflows/release.yml`). La autorización manual valida el mismo digest en staging y producción (`authorize-promotion.yml`).
- `scripts/deployctl.ts` ya valida manifest/autorización/evidence/SBOM/provenance/gates, renderiza Compose, hace pull+inspect por digest, persiste snapshot `{current,previous}` atómicamente y aplica rollback de imagen compatible. Sus interfaces de runtime son inyectadas; no tiene parser CLI, adaptador Docker/Compose ni verificador real de artefactos GitHub.
- `scripts/render-compose.ts` y `deploy/compose.yml` fijan proyectos/rutas/redes, imágenes por digest, sin puertos host, límites, healthchecks, y separación staging/producción. Roles, `queue-init`, migrador gobernado, probes/heartbeats, backup y restore drill ya existen como componentes y contratos separados.
- Los runbooks son conscientemente honestos: actualmente dicen que no se entrega un ejecutable host de `deployctl` ni de backup. `deploy/systemd/agendia-backup.service` apunta a `/usr/libexec/agendia/agendia-backup`, que aún no es producido ni instalado.

## Brecha mínima real

La implementación actual es un control-plane comprobable en repositorio, no una instalación host ejecutable. En particular:

1. La confianza de `deployctl` termina en un input ya marcado `verified`; el comentario de código delega la verificación de artefactos GitHub a un límite externo. Un JSON local puede imitar esos booleanos si no existe un verificador host que obtenga/verifique el artefacto de autorización y attestations.
2. No hay adaptador que traduzca `pull`, `inspect` y `converge` a `docker pull`, inspección de plataforma y `docker compose`, ni CLI que mantenga los state/Compose bytes bajo el layout de host.
3. El Compose renderizado monta `/run/agendia/config`, pero no declara `env_file` ni `environment` para entregar las variables `AGENDIA_*` y los `*_DATABASE_URL_FILE` que exige cada entrypoint. Por tanto los servicios de release fallarían antes de readiness aunque los archivos de configuración existan en el host.
4. El orden operativo requerido no está conectado: hay que iniciar solamente PostgreSQL, provisionar roles, migrar, inicializar queues y, en primer arranque, bootstrap del admin antes de converger los cuatro procesos. `provision-roles.ts` y `bootstrap-admin.ts` no están incluidos como comandos funcionales de la imagen actual; el dispatcher rechaza bootstrap y el runtime-config tampoco contempla `provision-roles`.
5. El backup/adaptador de restic es deliberadamente abstracto y el ejecutable referenciado por systemd no existe. Implementar un proveedor o una integración real de backup no es necesario para este cambio, pero un primer despliegue con usuarios no puede declarar satisfecho el gate de backup/restore sin la evidencia externa ya exigida.

Estos cinco puntos son el puente faltante. Sólo añadir un wrapper shell alrededor de `deployctl.ts`, o copiar un checkout al servidor, no sería oficial, no sería verificable por procedencia y contradice los runbooks existentes.

## Recomendación: un único host deployment bundle, no otro entorno

Publicar desde el workflow de release un **bundle de operador para Linux x86_64** asociado al mismo commit y release digest. Debe ser un tarball de contenido determinista, con manifiesto de bundle y attestation/SBOM verificables, nunca una copia del checkout ni una etiqueta Docker mutable.

Layout propuesto después de verificar el bundle:

```text
/usr/lib/agendia/bundles/<bundle-sha256>/
  bin/agendia-deployctl
  bin/agendia-backup                 # solo si se compila desde la lógica existente; no crea proveedor
  share/bundle-manifest.json
  share/compose.yml.tmpl
  share/cloudflared-config.yml.tmpl
/usr/local/sbin/agendia-deployctl -> /usr/lib/agendia/bundles/<bundle-sha256>/bin/agendia-deployctl
/usr/libexec/agendia/agendia-backup -> /usr/lib/agendia/bundles/<bundle-sha256>/bin/agendia-backup
/srv/agendia/{production,staging}/release/{state.json,compose.yml,evidence/}
/etc/agendia/{production,staging}/{config,secrets,release.env}
```

Los enlaces se actualizan sólo después de verificar el manifiesto/attestation del bundle. `state.json` y el Compose renderizado permanecen por entorno y siguen siendo el mecanismo de rollback existente; no se guardan secretos dentro del bundle, `release.env`, evidencia o estado.

### Trust boundary de procedencia

El bundle debe incluir un adaptador explícito de **verificación**, no aceptar campos `verified` enviados por stdin como autoridad. La opción mínima compatible con el diseño actual es usar un cliente GitHub/attestation ya instalado y autenticado con privilegios mínimos para:

1. descargar artefactos exactos de un workflow `Release evidence` y de `Authorize promotion` por run-id;
2. comprobar su estructura y hashes contra el manifest/evidence/autorización ya validados por las librerías existentes;
3. verificar las attestations de SBOM y provenance para el sujeto `@sha256` de la release;
4. generar el input inmutable que `planDeployment` ya consume.

El bundle no debe recibir un token GHCR: Docker conserva su credencial de sólo lectura fuera del bundle, como prescribe el diseño. El token/API de GitHub, si se usa para descargar/verificar, también es una credencial de host separada y de mínimo alcance. Una transferencia LAN de los artefactos descargados es aceptable sólo si el bundle verifica sus hashes/attestations; transferir fuentes o un checkout no lo es.

### Adaptador runtime y comandos propuestos

El binario `agendia-deployctl` debe ser un ejecutable compilado para `linux-x64`, invocable sólo con `sudo` por el operador documentado. Su adaptador limitado puede ejecutar exclusivamente una allowlist de Docker/Compose con argumentos fijos; no recibe shell libre, path de checkout, build, push, destroy de producción ni acceso GitHub de despliegue.

Secuencia propuesta para el primer **staging** o **production** vacío (los nombres son contractuales, pero la interfaz exacta queda para diseño):

```text
1. agendia-deployctl verify --environment <staging|production> --release <digest> --authorization-run <id>
2. agendia-deployctl bootstrap-postgres --environment <...>
3. agendia-deployctl provision-roles --environment <...>       # solamente primer clúster o idempotente
4. agendia-deployctl migrate --environment <...>               # evidence/compatibilidad existentes
5. agendia-deployctl queue-init --environment <...>
6. agendia-deployctl bootstrap-admin --environment production  # sólo primer admin y secreto one-shot
7. agendia-deployctl apply --environment <...>                 # plan/apply existente, pull/inspect/converge
8. agendia-deployctl smoke --environment <...>                 # reutiliza health/readiness/heartbeat/private smoke
9. agendia-deployctl rollback --environment <...>              # sólo snapshot compatible; nunca rollback SQL
```

`bootstrap-postgres` levanta únicamente `postgres` y espera su healthcheck; no levanta la aplicación antes de roles/migración/colas. Los one-shot se ejecutan como contenedores transitorios sobre la red data del proyecto y con los mounts de configuración/secrets estrictamente necesarios. El bundle no abre puertos, no añade un Docker socket a un contenedor de aplicación y no crea un runner CI en el host.

### Cambios de conexión mínimos alrededor de los componentes existentes

- Hacer que el renderer entregue un `env_file` por proceso desde `/etc/agendia/<env>/config`, cuyos valores son identidad no secreta y rutas `*_FILE`; no interpolar ni imprimir secretos.
- Añadir servicios/commands one-shot explícitos (o una invocación Compose igualmente declarada) para `provision-roles`, `migrate`, `queue-init` y bootstrap. Construir sólo las salidas JavaScript necesarias y extender el dispatcher/runtime-config con esos nombres; no ejecutar fuentes, `tsx` ni `next dev`.
- Tratar el bootstrap de admin como material one-shot: archivo root-only, registrar sólo resultado/fecha, borrar el password tras éxito y rechazar reemplazar el admin existente. No reintroducir `DATABASE_URL` genérico en los procesos normales.
- Implementar el runtime adapter del bundle con operaciones atómicas existentes para state/Compose y rollback. Las verificaciones de health/smoke deben ocurrir después de convergence y conservar evidencia redactada.
- Empaquetar el ejecutable backup sólo si se puede limitar a la lógica provider-agnostic existente y a adaptadores locales de comandos `pg_dump`/`restic`/`age`; elegir, crear o configurar un repositorio restic no forma parte de este cambio. Si eso excede la slice, dejar el timer deshabilitado y documentar que es un gate externo bloqueante, no fingir backup operativo.

## CI packaging mínimo

Extender `release.yml`, después de la imagen, manifest, SBOM y provenance existentes, para compilar el bundle `linux-x64` desde el SHA exacto, emitir:

- `host-bundle.tar.gz` con executables generados, templates y `bundle-manifest.json` canónico;
- checksum SHA-256 del tarball y binding explícito a `commit`, `releaseDigest`, plataforma, hashes de ejecutables y versión de schema;
- SBOM y build provenance del archivo bundle, publicados/adjuntos al mismo release workflow;
- artefacto descargable de nombre ligado al SHA/run-id, no una tag ni una release reconstruible;
- contrato CI que instale el tarball en un root temporal, verifica manifest/attestation fixtures y ejecuta la CLI contra un Docker/Compose fake sin credenciales ni host.

No se necesita crear un registry nuevo, enviar SSH desde GitHub ni añadir un self-hosted runner. GHCR sigue siendo la fuente de la imagen de aplicación por digest.

## Pruebas mínimas

1. **Bundle contract:** rechaza tarball/manifiesto alterado, SHA/plataforma/release digest incongruentes, una tag, y binario o template no listado.
2. **Provenance boundary:** rechaza authorization/evidence locales con `verified: true` sin resultado del verificador; acepta sólo un fixture de verificación ligado al run, repositorio, artefacto, digest, SBOM y provenance exactos.
3. **Docker runtime adapter:** con runner falso, permite solamente pull/inspect/converge y comandos one-shot fijos; comprueba argumentos, plataforma amd64, orden PostgreSQL→roles→migrate→queue-init→apps, y que errores restauran bytes/snapshot mediante la semántica actual.
4. **Compose/config contract:** renderiza `env_file` por proceso, no valores secretos, y prueba que cada runtime recibe su variable `_FILE`; un archivo cruzado o faltante falla antes de health.
5. **First-bootstrap contract:** prueba idempotencia de roles/queue-init, bootstrap admin de un solo uso, borrado del secret de bootstrap y que no se ejecuta ningún proceso normal antes de migración/colas.
6. **Installation contract:** usa un root temporal, comprueba permisos/enlaces/rutas esperadas y que state/evidence se segregan por staging/producción; ninguna prueba toca `/etc`, `/srv`, Docker real ni el host.

La simulación integral PR17 ya es un safety net útil para digest, aislamiento, migración/queue-init, readiness, smoke y rollback; esta change sólo añade pruebas del borde host que aquella simulación no puede ejercer.

## Forecast de revisión

| Slice sugerida | Archivos aproximados | Líneas estimadas |
| --- | ---: | ---: |
| Bundle manifest, compilación CI y contrato de integridad | 4–6 | 160–240 |
| CLI, verificador de procedencia y adapter Docker/Compose | 4–6 | 260–420 |
| Compose env/one-shots y empaquetado de provision/bootstrap | 5–8 | 220–360 |
| Instalación, runbook y contratos de bootstrap | 4–6 | 160–250 |
| **Total mínimo creíble** | **17–26** | **800–1,270** |

**Veredicto:** no cabe responsablemente en 400 líneas como un único cambio revisable. La causa no es añadir comandos sino cerrar el límite de confianza, hacer viable el runtime config y conectar bootstrap seguro. Bajo `ask-on-risk`, una fase apply debe detenerse para que el usuario elija slices/chain strategy; `size:exception` no se infiere.

La división más segura es: (1) artefacto host/provenance+instalación, (2) runtime adapter+CLI y rollback, (3) Compose config/one-shots+bootstrap, (4) contratos/runbook integral. La primera slice por sí sola no autoriza despliegue.

## Gates que realmente requieren confirmación humana

1. **Confianza de host:** aprobar el mecanismo concreto para descargar/verificar artifacts/attestations GitHub y el custodio/alcance de la credencial de lectura/verificación, si no se realiza transferencia LAN verificada sin token persistente.
2. **Privilegio operativo:** confirmar que el operador LAN usa `sudo` acotado para Docker y el layout `/etc`/`/srv`, sin incorporar al usuario de aplicación al grupo `docker`.
3. **Bootstrap de identidad:** autorizar el procedimiento de primer admin, custodiar su secreto temporal y confirmar el borrado/recuperación posterior; no es seguro inventar esa identidad o reutilizar un secreto de desarrollo.
4. **Habilitación real:** antes de usuarios reales, aportar/aceptar la evidencia ya requerida de tunnel/dominio/DNS, backup externo con restore probado, secretos e identidades separadas y aceptación escrita de Wi-Fi/sin UPS. No se confirma ni implementa aquí un proveedor Cloudflare o backup.
5. **Riesgo de tamaño:** escoger una estrategia de entrega encadenada para las slices anteriores o aceptar explícitamente una excepción de tamaño; la preferencia actual `ask-on-risk` exige pausar en este punto.

No requieren una nueva decisión de producto: la imagen universal amd64, GHCR por digest, promoción manual pull-based, cuatro entornos, staging temporal, aislamiento de estado y la prohibición de port-forwarding ya están establecidos por `establish-delivery-environments`.

## Siguiente fase recomendada

Redactar propuesta limitada a **host deployment bundle y bootstrap adapter** con los límites anteriores. Antes de tasks/apply, solicitar decisión sobre el riesgo de revisión y las cinco confirmaciones humanas; no desplegar ni usar el host durante las fases de repositorio.

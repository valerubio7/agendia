# Diseño técnico: entornos de entrega de agendIA

## 1. Propósito, alcance y hechos de partida

Este diseño convierte el monorepo actual en una ruta de entrega de cuatro entornos sin cambiar el comportamiento funcional del producto. La opción preferida es una imagen OCI universal e inmutable para los cuatro procesos, pero queda condicionada a una prueba temprana de viabilidad. Si esa prueba falla sin una refactorización amplia, la unidad promovible será un manifiesto OCI inmutable que fija un conjunto pequeño de imágenes por proceso. En ambos casos CI construye una sola vez fuera del servidor, staging valida una identidad por digest y producción promociona exactamente esa misma identidad sin reconstrucción.

El diseño parte de hechos comprobados en el repositorio:

- Bun 1.4.0 y TypeScript gobiernan el workspace; `bun run build` hoy solo comprueba tipos y ejecuta `next build`.
- Los cuatro procesos son `web` (Next 16), `api` (Fastify), `whatsapp-manager` (Baileys) y `message-worker` (pg-boss/DeepSeek).
- Manager y worker arrancan hoy TypeScript mediante `tsx`; esto no es aceptable como runtime de release.
- La web llama a `/api`, Next reescribe al origen interno y la API exige coincidencia exacta de `Origin`.
- PostgreSQL 16 es registro y cola; las pruebas ya usan Testcontainers y dobles deterministas.
- Los roles de capacidad PostgreSQL son `NOLOGIN`; faltan logins segregados, ledger de migraciones y un proceso operativo de migración.
- `.github/workflows` está actualmente vacío: no existe todavía ningún workflow de CI o release.
- El host confirmado es Ubuntu Server 26.04.1 LTS x86_64, Celeron N4020/2 CPU, 7.1 GiB RAM, 4 GiB swap, SSD de 447 GiB, LV raíz de 100 GiB con capacidad libre en LVM, Wi-Fi únicamente, SSH por LAN, sin Docker y sin UPS.
- Las IP WAN distintas impiden suponer port forwarding; el ingreso deberá salir desde el host.

Los scripts raíz actuales son exactamente `dev`, `bootstrap:admin`, `typecheck`, `test:scaffolding`, `test:unit`, `test:integration`, `test:contracts`, `test:tenant-isolation`, `test:harness`, `test:e2e`, `test`, `db:generate`, `db:migrate`, `db:check`, `backup:drill`, `security:scan`, `scope:check` y `build`. No existe hoy un script raíz `lint`. `openspec/config.yaml` sí declara `bun run lint` como gate: el cambio deberá añadir y configurar ese script, demostrar primero su RED por ausencia y solo después convertirlo en check obligatorio. Los comandos actuales de proceso son `next dev`/`next build` en web, ningún script en API, y `AGENDIA_RUN_WHATSAPP_MANAGER=1 node --import tsx src/index.ts` / `AGENDIA_RUN_MESSAGE_WORKER=1 node --import tsx src/index.ts` en manager y worker. El diseño no presenta ninguno de ellos como comando de release existente.

No se ejecutan desde este cambio instalaciones, cambios de firewall, operaciones LVM, compras, alta de dominio, alta de proveedor de backup ni vinculación de cuentas reales. Los pasos de host serán runbooks revisables, no efectos laterales de build, test o deploy.

## 2. Decisiones arquitectónicas

| ID | Decisión | Razón | Alternativas rechazadas |
| --- | --- | --- | --- |
| ADR-01 | Usar Docker Engine y Docker Compose v2 en el host. | Es el supervisor más pequeño compatible con Testcontainers, imágenes OCI, límites, healthchecks y reinicio tras reboot. | Kubernetes/k3s añade consumo y operación desproporcionados; Podman no aporta una ventaja que compense divergir de Testcontainers y del soporte operativo disponible. |
| ADR-02 | Preferir una sola imagen universal `linux/amd64` por commit en GHCR, condicionada al gate de viabilidad P0. Si P0 falla sin refactorización amplia, publicar un manifiesto OCI por digest que fija un conjunto pequeño de imágenes OCI por proceso, cada una también por digest. | La opción universal minimiza mezcla; el fallback conserva una identidad coherente e inmutable de release sin hacer depender todo el plan de una hipótesis de bundling aún no probada. | Un contenedor con los cuatro procesos impediría reinicios, probes y límites independientes; imágenes seleccionadas por tags o reconstruidas por entorno romperían la promoción. |
| ADR-03 | Construir artefactos JavaScript de release con toolchain fijado y ejecutar solo salida generada; la vía preferida usa `bun build --target=bun` para API/manager/worker y Next `output: "standalone"`. Ninguna vía permite `tsx`, fuentes TypeScript ni `next dev` en producción. | El gate P0 debe probar resolución de workspaces, dependencias dinámicas/nativas y assets antes de comprometer la arquitectura universal; el fallback puede elegir empaquetado soportado por proceso sin debilitar el contrato de runtime. | Copiar el workspace y ejecutar fuentes con `tsx`, o usar un servidor de desarrollo, no constituye una release. |
| ADR-04 | Usar GHCR por digest, attestation de procedencia GitHub y SBOM OCI. | Se integra con GitHub Actions y permite al host una credencial de solo lectura. | Un registry en el servidor aumenta superficie y mantenimiento; archivos tar copiados por SSH pierden promoción y procedencia. |
| ADR-05 | CI, build, scan y pruebas se ejecutan en runners GitHub-hosted x86_64. El host no tendrá un runner general. | Evita que código de PR o builds compitan con producción o obtengan acceso al host. | Un runner GitHub self-hosted en producción es una frontera de ejecución remota demasiado amplia. |
| ADR-06 | Usar Cloudflare Tunnel (`cloudflared`) como dirección concreta de ingreso saliente, con dos identidades de túnel y un solo tipo de agente. | Un único producto cubre producción pública y staging privado mediante Access, sin port forwarding ni una segunda VPN. | Túnel más Tailscale obliga a operar dos herramientas; publicar puertos no funciona de forma fiable bajo CGNAT/doble NAT. La cuenta, zona DNS, hostnames y políticas Access siguen siendo aprovisionamiento externo. |
| ADR-07 | Ejecutar PostgreSQL en contenedores separados para staging y producción, con directorios, bases y credenciales independientes. | Una instancia compartida ampliaría el blast radius de borrado, configuración, mantenimiento y consumo. | Dos bases en el mismo clúster no aíslan reinicios, superusuario, volumen ni errores de teardown. |
| ADR-08 | Usar migrador one-shot con advisory lock, ledger de nombre/checksum y marcador de entorno; nunca migrar al arrancar una app. | Hace las migraciones seriales, auditables y resistentes a referencias cruzadas. | Reejecutar SQL ordenado sin ledger no detecta cambios históricos; migrar en cada réplica crea carreras y acopla disponibilidad a DDL. |
| ADR-09 | Medir manager/worker mediante endpoint HTTP solo en loopback del contenedor y heartbeat durable en PostgreSQL. | Un proceso idle puede estar sano sin trabajos ni sesiones; el heartbeat prueba event loop, scheduler y escritura DB sin publicar puertos. | Inferir salud por logs o backlog confunde inactividad con fallo; un endpoint en la red sería una superficie innecesaria. |
| ADR-10 | Usar restic con destino configurable y un bundle de claves cifrado adicionalmente con `age`. | Es provider-agnostic, económico, incremental, verificable y separa la custodia de claves de la credencial del repositorio. | Copias locales o `rsync` sin cifrado no cumplen salida del PC; seleccionar ahora una cuenta concreta excede el alcance. |
| ADR-11 | Hacer la promoción pull-based y operada por LAN durante el piloto. GitHub registra CI y la solicitud manual; el operador aplica por SSH LAN la identidad de release por digest. GitHub nunca despliega automáticamente al servidor doméstico. | Mantiene un acto humano explícito y auditable sin abrir SSH a Internet, instalar un runner en producción ni exigir una segunda persona inexistente. | Push desde GitHub requeriría un camino administrativo remoto adicional; Watchtower depende de tags y elimina el gate humano. |

## 3. Arquitectura de runtime y fronteras de seguridad

```text
Internet
   |
   | outbound tunnel ya establecido desde el host
   v
cloudflared-prod ----> web-prod:3000 ----> api-prod:3001 ----> postgres-prod:5432
                           (same origin /api)        ^             ^
                                                    |             |
                                      manager-prod--+-------------+
                                      worker-prod-----------------+

cloudflared-stg ----> web-stg:3000 ----> api-stg:3001 ----> postgres-stg:5432
   ^ Access deny-by-default; conector y pila solo durante ventana
```

### Fronteras

1. **Internet → túnel:** solo el hostname HTTPS canónico de producción es público. `cloudflared` origina una conexión saliente; no se abren 80/443 entrantes.
2. **Túnel → web:** cada credencial de túnel solo puede enrutar al alias `web:3000` de su propia red Compose. Una regla final responde 404.
3. **Web → API:** el navegador usa `/api`; la imagen compila el rewrite común `http://api:3001`, válido en ambas redes aisladas. `APP_ORIGIN` sí es runtime y debe coincidir exactamente con el HTTPS canónico del entorno.
4. **Datos:** PostgreSQL no publica puertos al host. API, manager y worker tampoco publican puertos. Solo servicios dentro de la red `data` correspondiente llegan a su PostgreSQL.
5. **Proveedores:** manager y worker obtienen salida a Internet en una red `egress`, pero no tienen puertos publicados. API no necesita salida general salvo que una futura dependencia la justifique.
6. **Administración:** SSH sigue limitado a la LAN inicialmente. Cloudflare Access protege staging web, no concede shell. Exponer SSH mediante Access será otro cambio con threat model y aprobación propios.
7. **Docker:** acceso al socket equivale a root. El usuario de servicio no pertenece al grupo `docker`; los operadores usan `sudo` y comandos acotados del runbook.

## 4. Gobierno GitHub y control de entrega

### 4.1 Trunk-based development y modos de gobierno

`main` es el único trunk y la única rama permanente. Las ramas `feature/*`, `fix/*` y `chore/*` son cortas y se eliminan tras squash merge. Staging y producción nunca se representan con ramas; tags y ramas tampoco seleccionan bytes.

El repositorio empieza en **SOLO PILOT** porque la persona operadora y desarrolladora confirmada es una sola. Este modo evita una aprobación imposible y separa controles exigibles de hardening futuro:

| Control | SOLO PILOT inicial | MULTI-MAINTAINER futuro |
| --- | --- | --- |
| Entrada a `main` | PR obligatoria con descripción, commit candidato, CI y conversación/evidencia conservada; no se exige aprobación independiente ni autoaprobación ficticia. | La misma PR más al menos una aprobación independiente no obsoleta y aprobación del push más reciente. |
| Integración | Solo squash merge e historial lineal; merge directo prohibido por política y por ruleset cuando esté disponible. | Igual, sin bypass administrativo salvo break-glass documentado. |
| Integridad de `main` | Force-push y borrado prohibidos; protección/ruleset se habilita cuando el plan lo permite y el verificador de release rechaza commits sin PR+checks. | Igual, aplicado como protección obligatoria. |
| CI | Checks requeridos de calidad, suites, build y contrato de release para el SHA exacto; el operador no hace squash hasta que estén verdes y `release.yml` rechaza cualquier incumplimiento. | Los mismos checks. |
| `CODEOWNERS` | Archivo versionado para declarar superficies sensibles y solicitar atención, pero su aprobación **no** es requerida. | Aprobación CODEOWNERS requerida para `.github/`, `deploy/`, migraciones y runbooks. |
| Environments GitHub | Registran staging/producción y el acto manual si están disponibles, sin required reviewers ni prevención de self-review. | Required reviewers independientes y prevención de self-review si el plan lo soporta. |
| Promoción | Dos actos manuales por la persona operadora: autorizar por digest tras CI y aplicar por LAN; producción además requiere evidencia del mismo digest en staging. | Autorización independiente de Environment antes de la aplicación manual por LAN. |

La transición a **MULTI-MAINTAINER** es un cambio de política separado: solo se activa cuando existe una segunda persona mantenedora de confianza, acepta responsabilidad operativa y el plan de GitHub soporta los controles requeridos. Hasta entonces no se marcan como obligatorios reviewers, CODEOWNERS approval, prevención de autoaprobación ni aprobación ajena.

Las capacidades de protección para repositorios privados y los reviewers de GitHub Environments varían por plan. El runbook mantiene una matriz `control deseado / disponible / configuración efectiva / evidencia` y no afirma que un control inexistente esté activo. Fallback documentado cuando una protección no está disponible:

1. conservar toda modificación como PR y habilitar en GitHub todas las restricciones realmente disponibles;
2. prohibir por política merge directo, force-push y borrado de `main`, y conservar el audit log/evento GitHub aplicable;
3. ejecutar CI sobre el SHA exacto del head de la PR; el workflow de release consulta la API de GitHub y falla si ese SHA no está asociado a una PR fusionada por squash o si falta cualquier check exigido;
4. generar evidencia inmutable con repositorio, PR, actor, SHA, checks, timestamp e identidad de release por digest;
5. exigir `workflow_dispatch` manual para autorizar staging y, después de evidencia staging, otro `workflow_dispatch` manual para producción;
6. aplicar siempre desde SSH en LAN con verificación local del digest. Ningún workflow, webhook, runner ni GitHub Environment tiene credenciales o conectividad para desplegar al host.

Este fallback conserva evidencia de CI y autorización manual por digest sin fingir enforcement del plan. Una desviación de la política (por ejemplo, force-push detectado) invalida releases aún no promovidas y exige reconciliar/auditar `main` antes de volver a construir.

### 4.2 CI en GitHub-hosted runners

`ci.yml` corre en PR y `main`, con permisos mínimos (`contents: read`), `bun install --frozen-lockfile` y caché no autoritativa. Los stages/checks serán:

1. **quality:** `bun run lint`, `bun run typecheck`, `bun run security:scan` y `bun run scope:check`. El repositorio deberá añadir el script/configuración de lint que hoy falta antes de hacer este check obligatorio.
2. **unit:** `bun run test:unit`.
3. **postgres:** en runner con Docker, de forma secuencial para evitar presión innecesaria: `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation` y `bun run db:check`.
4. **browser:** instalar Chromium de Playwright y ejecutar `bun run test:harness` y `bun run test:e2e`.
5. **aggregate-contract:** ejecutar `bun run test` en `main` y en schedule para comprobar que el agregador canónico sigue incluyendo las suites declaradas; no hace falta duplicarlo en cada iteración de PR cuando los checks enfocados ya son requeridos.
6. **source-build:** `bun run build` después de los gates anteriores.

Las suites Testcontainers usan Docker del runner, PostgreSQL descartable, puertos dinámicos y los dobles actuales de Baileys/DeepSeek. La imagen `postgres:16-alpine` se centralizará y fijará también por digest. Ningún job recibe secretos de staging/producción y una prueba de no-egress falla si un double intenta contactar proveedores reales.

### 4.3 Build, procedencia y promoción

`release.yml`, solo después de CI verde para el SHA exacto de una PR integrada en `main`, hará en runner GitHub-hosted x86_64:

1. verificar el resultado del gate P0 y seleccionar explícitamente `universal-image` o `release-set`; no existe selección implícita por entorno;
2. buildx para `--platform linux/amd64`, dependencias fijadas por `bun.lock` y bases fijadas en `deploy/images.lock` por digest;
3. publicar una imagen universal por digest o el conjunto pequeño de imágenes por proceso y su manifiesto OCI de release por digest;
4. ejecutar el contrato sobre los cuatro comandos reales con PostgreSQL efímero, red sin egress de proveedores, filesystem raíz read-only y solo los mounts escribibles declarados; no se usa `next dev`, `tsx` ni TypeScript fuente;
5. escanear filesystem/imágenes con Trivy: `CRITICAL` bloquea; `HIGH` bloquea salvo excepción versionada con propietario, razón y caducidad;
6. publicar SBOM SPDX y provenance SLSA mediante attestations de buildx/GitHub (`id-token: write`, `attestations: write`, `packages: write` solo en este workflow);
7. publicar `release-manifest.json` y evidencia con commit, modo de empaquetado, identidad coherente de release, digests de imagen, plataforma, comandos, SBOM, checks y compatibilidad de esquema.

Las imágenes tendrán labels OCI `org.opencontainers.image.revision`, `source`, `created` y metadata embebida antes de calcular sus digests. Las etiquetas del commit son solo índices. Compose/deployctl aceptan exclusivamente referencias `@sha256`; en modo fallback resuelven primero el manifiesto OCI por digest y verifican todos sus digests enlazados.

`authorize-promotion.yml` recibe una **identidad de release por digest**, nunca una tag:

- en SOLO PILOT, `authorize-staging` es un `workflow_dispatch` explícito del operador y no exige reviewer independiente; si GitHub Environment está disponible se usa sin required reviewers;
- después de adjuntar evidencia de staging, `authorize-production` es otro acto manual separado para exactamente el mismo digest;
- en MULTI-MAINTAINER, ambos jobs añaden reviewer independiente, prevención de self-review y CODEOWNERS conforme a la matriz de gobierno;
- valida provenance del repositorio, CI verde, plataforma `linux/amd64`, PR asociada y modo de empaquetado aprobado;
- producción además exige `staging_evidence_id` asociado a la misma identidad y una declaración de compatibilidad DB;
- registra GitHub Deployment cuando la API/plan lo permita y siempre entrega un manifiesto de autorización verificable. No contiene secretos, no conecta al host y no dispara despliegue alguno.

El operador en LAN descarga y verifica autorización, manifest/provenance y digests, autentica GHCR con token fine-grained de solo `read:packages`, hace pull por digest y aplica la release. GitHub nunca recibe SSH, credenciales Docker del host, credenciales de túnel ni un runner conectado al servidor; no hay despliegue automático ni copia del checkout al host.

## 5. Representación inmutable de release y gate temprano de viabilidad

### 5.0 Gate P0 antes de dependencias downstream

La primera slice implementable es una prueba de contrato reproducible, no un supuesto arquitectónico. En checkout limpio y runner `linux/amd64`, con Bun 1.4.0 y lockfile congelado, P0 debe:

1. ejecutar `bun build --target=bun` sobre entrypoints de API, manager y worker y demostrar que resuelve todos los paquetes `workspace:*` sin importar archivos TypeScript externos en runtime;
2. cargar y usar `@node-rs/argon2` dentro de la imagen amd64, comprobando ABI y artefacto nativo;
3. arrancar API contra PostgreSQL efímero y ejecutar una operación real de repositorio;
4. arrancar manager y worker contra PostgreSQL, inicializar/validar pg-boss, publicar y consumir un job con los dobles deterministas existentes;
5. importar e instanciar Baileys con socket double y comprobar que sus módulos dinámicos, protobufs, datos MIME/browser y demás assets runtime quedan incluidos sin acceso al checkout ni descarga de red;
6. construir Next con `output: "standalone"`, `outputFileTracingRoot` del monorepo, estáticos y `public` si existe; arrancar `server.js`, servir página/asset y comprobar el rewrite interno `/api`;
7. arrancar consecutivamente los cuatro comandos desde el layout final, sin `tsx`, `next dev`, fuentes del checkout ni dependencias instaladas fuera de la imagen;
8. repetir el arranque con root filesystem read-only y los mounts de §7.1, incluyendo un caso adverso que niegue escritura fuera de ellos.

P0 produce evidencia con comandos, hashes y lista de dependencias/assets. Solo pasa si los cuatro procesos realizan una operación significativa; que el bundle termine sin error no basta. Debe fallar primero (RED) ante un fixture/asset nativo o dinámico ausente, pasar con el empaquetado mínimo (GREEN), repetir con al menos manager+worker y web+API (TRIANGULATE), y extraer helpers sin ampliar el runtime (REFACTOR).

**Decisión del gate:**

- **P0 verde:** continúa la arquitectura `universal-image` de §5.1.
- **P0 rojo tras ajustes localizados de entrypoint, tracing o copia explícita de assets:** se detiene cualquier trabajo downstream que dependa de imagen universal y se registra la causa. Si resolverlo exige refactorización amplia de módulos de aplicación, se activa el fallback `release-set` de §5.2 mediante PR de decisión; no se oculta el fallo con fuentes, `tsx` o `next dev`.

### 5.1 Opción preferida: imagen universal

El `Dockerfile` multi-stage tendrá builder Bun 1.4.0 fijado por digest, `bun install --frozen-lockfile`, Next standalone y bundles `api.js`, `whatsapp-manager.js` y `message-worker.js` producidos por `bun build --target=bun`. Copiará solo salida generada, assets probados por P0, migraciones, scripts one-shot y `release.json`. El runtime Bun Debian slim estará fijado por digest, usará UID/GID `10001`, root filesystem read-only y no contendrá toolchain, tests, `.git`, `.env`, `tsx` ni fuentes innecesarias.

Un dispatcher mínimo `/opt/agendia/bin/agendia` acepta exclusivamente:

```text
web | api | whatsapp-manager | message-worker | migrate | queue-init | bootstrap-admin | verify-config
```

Compose crea cuatro contenedores de app desde la misma referencia exacta y cambia solo `command`. Los one-shot usan esa misma imagen. Compatibilidad x86_64 requiere manifest OCI `linux/amd64`, smoke amd64 y carga real de dependencias nativas.

### 5.2 Fallback acotado: release-set por manifiesto OCI

Si P0 no valida la imagen universal sin refactorización amplia, CI construye una vez por commit un máximo inicial de cuatro imágenes (`web`, `api`, `whatsapp-manager`, `message-worker`; los one-shot se asignan a la imagen API o a una quinta imagen solo con justificación). Cada referencia queda fijada por digest. Una imagen de proceso puede usar Bun bundle, salida `tsc` compatible o el empaquetado soportado por Next, pero siempre ejecuta JavaScript generado en modo release: quedan prohibidos `tsx`, `next dev` y montar/copy-run del checkout.

CI publica `release-manifest.json` como artefacto OCI inmutable y captura su propio digest. Ese **digest del manifiesto** es la identidad coherente de release y vincula, de forma ordenada, plataforma, comandos, SBOM/provenance y todos los digests de proceso. Staging resuelve y valida el manifiesto; producción recibe exactamente el mismo digest de manifiesto y, por transitividad, los mismos digests de imagen. No se permite sustituir una imagen, reconstruir por entorno ni editar el manifiesto después de staging.

Compose recibe las referencias resueltas en un archivo generado y atómico; `deployctl` compara su hash con el manifiesto antes y después del pull. Rollback selecciona un digest histórico de manifiesto completo, nunca una mezcla manual.

### 5.3 Contrato de release

El esquema discriminado contiene al menos:

```json
{
  "schemaVersion": 1,
  "artifactKind": "universal-image|release-set",
  "commit": "<40-hex>",
  "releaseDigest": "sha256:<64-hex>",
  "platform": "linux/amd64",
  "images": {
    "web": "ghcr.io/<owner>/agendia-web@sha256:<64-hex>",
    "api": "ghcr.io/<owner>/agendia-api@sha256:<64-hex>",
    "whatsapp-manager": "ghcr.io/<owner>/agendia-manager@sha256:<64-hex>",
    "message-worker": "ghcr.io/<owner>/agendia-worker@sha256:<64-hex>"
  },
  "database": {
    "compatibility": "expand-compatible|contract-maintenance",
    "previousReleaseDigest": "sha256:<64-hex>",
    "minimumLedger": "<migration-name>"
  }
}
```

Para `universal-image`, las cuatro claves de `images` contienen la misma referencia y `releaseDigest` es su digest OCI. Para `release-set`, son referencias distintas y `releaseDigest` es el digest del manifiesto OCI que contiene este JSON. Cambiar una migración, bundle, asset, comando o digest enlazado cambia la identidad coherente. Validadores rechazan claves ausentes, tags, plataforma distinta, procesos extra y desacuerdo entre descriptor, attestations y Compose.

## 6. Los cuatro entornos

| Entorno | Ubicación y ciclo | Datos/proveedores | Release |
| --- | --- | --- | --- |
| `development` | Workstation; conserva `bun run dev`, `$HOME/.config/agendia/dev.env` y el Compose PostgreSQL existente. | Solo datos y credenciales locales. | Fuentes; no es promocionable. |
| `test` | Workstation o runner; se crea y destruye por ejecución. | Testcontainers, puertos dinámicos y dobles; sin secretos/proveedores reales. | Fuentes para suites y digest real para smoke. |
| `staging` | Host; ventana aprobada, privada y temporal. No reinicia tras reboot. | DB, volumen, secrets, tunnel, número WhatsApp de ensayo y provider key exclusivos. | Digest candidato autorizado. |
| `production` | Host; persistente y prioritario. | Estado real y credenciales exclusivas. | El mismo digest validado en staging. |

### 6.1 Nombres y recursos aislados

Solo se aceptan dos project names literales:

- `agendia-prod`
- `agendia-stg`

El wrapper `deployctl` rechaza otros valores y nunca deriva nombres de ramas. Los nombres concretos son:

| Recurso | Producción | Staging |
| --- | --- | --- |
| DB | `agendia_prod` | `agendia_stg` |
| directorio estado | `/srv/agendia/production` | `/srv/agendia/staging` |
| networks | `agendia-prod-edge`, `agendia-prod-app`, `agendia-prod-data` | `agendia-stg-edge`, `agendia-stg-app`, `agendia-stg-data` |
| volumen/bind PostgreSQL | `/srv/agendia/production/postgres` | `/srv/agendia/staging/postgres` |
| evidencia | `/srv/agendia/production/evidence` | `/srv/agendia/staging/evidence` |
| configuración | `/etc/agendia/production/config` | `/etc/agendia/staging/config` |
| secrets | `/etc/agendia/production/secrets` | `/etc/agendia/staging/secrets` |

`edge` permite salida y conecta tunnel/web y los procesos que necesitan proveedores; `app` es `internal: true` y conecta web/API; `data` es `internal: true` y conecta API/manager/worker/PostgreSQL. No hay `ports:` en las pilas de servidor. Puertos internos: web `3000`, API `3001`, PostgreSQL `5432`, health loopback de manager/worker `9090`. Los mismos puertos son seguros porque cada proyecto tiene redes distintas.

Cada recurso Compose lleva labels `com.agendia.environment`, `com.agendia.project` y `com.agendia.managed=true`. El teardown de staging:

1. exige el literal `--environment staging` y project `agendia-stg`;
2. compara las labels de cada recurso candidato;
3. rechaza cualquier nombre que contenga `prod` o label distinta;
4. ejecuta `down --volumes --remove-orphans` sin `--rmi` solo para staging;
5. conserva evidencia y secrets fuera de los volúmenes Compose.

Producción no ofrece un comando `destroy`; `down` nunca incluye `--volumes`. La prueba de aislamiento toma IDs/checksums de volumen prod antes y después de destruir staging.

### 6.2 Ingreso Cloudflare

Habrá dos tunnels y dos credenciales, aunque se use una sola herramienta:

- `agendia-production`: ruta pública del hostname canónico provisionado → `http://web:3000`;
- `agendia-staging`: hostname distinto → `http://web:3000`, protegido por Cloudflare Access deny-by-default y allowlist de revisores. El connector existe solo mientras staging está activo.

Los ficheros `config.yml` terminan con `service: http_status:404`. No hay reglas hacia API, PostgreSQL, manager, worker ni SSH. `cloudflared` usa credencial por archivo, nunca token en argumentos o logs, `--no-autoupdate`, imagen fijada por digest y log JSON. Actualizar el agente es una actualización de manifiesto revisada.

Elegir/crear cuenta Cloudflare, dominio, zona DNS, hostnames y política Access es un gate externo. Hasta completarlo, no hay producción pública; staging solo puede recibir smoke interno desde el host. Esta decisión no autoriza comprar ningún recurso.

## 7. Compose, supervisión y capacidad

### 7.1 Topología y hardening

Cada pila contiene `postgres`, `api`, `web`, `whatsapp-manager`, `message-worker` y `cloudflared`. En modo universal las cuatro apps usan el mismo `AGENDIA_IMAGE` por digest; en modo fallback usan las cuatro referencias resueltas desde `AGENDIA_RELEASE_MANIFEST`, cuyo valor es una referencia GHCR con `@sha256`. Postgres y cloudflared usan sus propios digests fijados.

Para apps: `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, usuario `10001:10001`, `init: true` y `pids_limit`. No se monta Docker socket ni checkout. PostgreSQL tiene únicamente su bind de datos. Secrets y keyrings se montan read-only.

La raíz permanece read-only y toda escritura de aplicación queda enumerada; no existen volúmenes persistentes de app:

| Proceso | Paths escribibles exactos | Tipo/propiedad | Uso permitido |
| --- | --- | --- | --- |
| web | `/tmp`, `/run/agendia/web`, `/opt/agendia/web/.next/cache` | `tmpfs`, UID/GID `10001`, modos `1777`, `0750`, `0750` | temporales de librería, estado efímero de proceso y caché/optimización de Next. |
| API | `/tmp`, `/run/agendia/api` | `tmpfs`, UID/GID `10001`, modos `1777`, `0750` | temporales y estado efímero de probe/PID si llegara a requerirse. |
| whatsapp-manager | `/tmp`, `/run/agendia/whatsapp-manager` | `tmpfs`, UID/GID `10001`, modos `1777`, `0750` | temporales de Baileys y estado efímero de control; auth/sesiones siguen en PostgreSQL cifrado. |
| message-worker | `/tmp`, `/run/agendia/message-worker` | `tmpfs`, UID/GID `10001`, modos `1777`, `0750` | temporales y estado efímero del worker; jobs siguen en PostgreSQL. |

Cada contenedor define `HOME` bajo su propio `/run/agendia/<proceso>/home`; el entrypoint lo crea al iniciar. Web define además `NEXT_TELEMETRY_DISABLED=1`. Los tmpfs usan `nosuid,nodev` y `noexec` salvo evidencia P0 de que una dependencia requiere ejecución temporal; cualquier excepción requiere threat model y test. Ningún upload, mensaje, QR, sesión, credencial, keyring, backup, evidencia de promoción ni dato de usuario puede almacenarse allí. Si una futura caché u optimización necesita otra ruta, el proceso debe fallar cerrado hasta que una PR la declare, limite y cubra con contrato; no se habilita una raíz escribible como workaround.

El contrato `release-image-readonly` inspecciona la configuración efectiva y, para **cada uno de los cuatro comandos**, arranca el artefacto con `ReadonlyRootfs=true`, PostgreSQL efímero y solo los tmpfs de su fila. Debe demostrar readiness y una operación significativa, escritura exitosa en cada path declarado, fallo de escritura en `/opt/agendia`, `/etc` y un path hermano no declarado, ausencia de mounts adicionales, y reinicio sin depender del contenido tmpfs. La prueba se ejecuta tanto para la imagen universal como para cada imagen aplicable del fallback y bloquea la release.

Política inicial:

| Servicio | prod CPU / memoria máxima | stg CPU / memoria máxima | pids | stop grace |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | `0.80` / `1400m` | `0.20` / `512m` | 256 | 120 s |
| web | `0.40` / `600m` | `0.15` / `384m` | 128 | 20 s |
| API | `0.25` / `400m` | `0.10` / `256m` | 128 | 30 s |
| manager | `0.30` / `600m` | `0.15` / `384m` | 128 | 90 s |
| worker | `0.25` / `500m` | `0.15` / `320m` | 128 | 90 s |
| cloudflared | `0.05` / `128m` | `0.05` / `96m` | 64 | 20 s |

Son **límites piloto**, no una afirmación de capacidad. Se implementan con `cpus`/`mem_limit` de Compose, no solo `deploy.resources`. Producción usa `restart: unless-stopped`; staging usa `restart: on-failure:3`, que no la reactiva automáticamente tras reiniciar el daemon.

Docker usa `json-file` con `max-size: 10m`, `max-file: 3` por contenedor. Imágenes no referenciadas se podan solo por runbook, nunca durante deploy y nunca antes de conservar los dos últimos digests de producción.

### 7.2 Gates medidos para staging

Antes del primer piloto se registra baseline de 24 horas de producción sin staging. Los umbrales iniciales, deliberadamente conservadores, son gates ajustables mediante PR con evidencia:

- memoria `MemAvailable >= 2.5 GiB`, swap usado `< 256 MiB` y sin crecimiento sostenido;
- load average de 15 minutos `< 1.0` en el host de 2 CPU;
- al menos 25% y 30 GiB libres en filesystem de Docker/datos;
- SMART sin fallo, temperatura por debajo del umbral de fabricante y, provisionalmente, `< 75 °C`;
- p95 API y edad de backlog dentro del baseline aceptado; no se abre ventana si la edad del job más antiguo supera 60 s;
- cero backup, prune/check completo, migración, restore, actualización de host o mantenimiento activo.

Se aborta staging si durante 5 minutos `MemAvailable < 1 GiB`, el swap crece más de 512 MiB, load de 15 minutos supera 1.8, I/O wait supera 20%, p95 de producción duplica su baseline o el backlog más antiguo supera 2 minutos. Estos valores protegen el piloto; una prueba de carga fuera del host y observación real deberán demostrar cuántos tenants/sesiones soporta el equipo.

Builds, suites completas, scans y Playwright nunca se ejecutan en el host. Restore drill y migración sensible exigen staging apagado. El backup diario puede coexistir con producción porque debe tomar un snapshot consistente, pero corre con `nice`/`ionice`, sin staging, y se difiere si los gates de carga fallan. Swap es amortiguación de incidente, no presupuesto operativo.

### 7.3 Orden de arranque y parada

Arranque normal:

1. Docker monta el almacenamiento y arranca PostgreSQL.
2. `pg_isready` y la consulta del marcador de entorno quedan verdes.
3. El operador ya ejecutó `migrate` y `queue-init`; las apps solo comprueban ledger/compatibilidad.
4. API, manager y worker arrancan. Manager y worker no quedan ready hasta registrar heartbeat DB.
5. Web arranca tras readiness de API.
6. Tunnel arranca tras readiness de web.

Parada controlada: retirar/pausar ingreso, detener web/API para no admitir trabajo nuevo, pausar automatización, drenar worker y manager dentro de 90 s, parar tunnel y finalmente PostgreSQL. Manager mantiene una sola réplica por entorno y libera leases/advisory locks. Worker mantiene concurrencia explícita `1` para `ai-generate` y `1` para `conversation-summary`; cualquier aumento requiere benchmark y revisión. Jobs no terminados vuelven a la semántica de reintento pg-boss.

## 8. Configuración y secretos

### 8.1 Validador central

Se añadirá un paquete central `@agendia/runtime-config` con schemas Zod por proceso. Toda entrada llama a `loadRuntimeConfig(processName)` antes de escuchar, recuperar sesiones o registrar workers.

Variables comunes:

- `AGENDIA_ENVIRONMENT=development|test|staging|production`;
- `AGENDIA_ENVIRONMENT_ID=<uuid>` estable y distinto por entorno;
- `AGENDIA_SECRET_SET_ID=<uuid>` estable para el conjunto activo;
- `AGENDIA_RELEASE_DIGEST=sha256:<64-hex>` y `AGENDIA_PROCESS`;
- `APP_ORIGIN` HTTPS obligatorio en staging/production y hostname exacto autorizado.

En release se rechaza `DATABASE_URL` genérica para eliminar fallbacks ambiguos. Se usan:

- API: `API_DATABASE_URL_FILE`, `APP_ORIGIN`, `WHATSAPP_LINK_CODE_KEY_FILE`;
- manager: `MANAGER_DATABASE_URL_FILE`, `QUEUE_PUBLISHER_DATABASE_URL_FILE`, `BAILEYS_KMS_CURRENT_VERSION`, `BAILEYS_KMS_KEYRING_DIR`, `WHATSAPP_LINK_CODE_KEYRING_DIR`, `WHATSAPP_MANAGER_ID`, `WHATSAPP_COMMAND_POLL_MS`;
- worker: `WORKER_DATABASE_URL_FILE`, `DEEPSEEK_API_KEY_FILE`, `DEEPSEEK_MODEL`, `WORKER_CONCURRENCY=1`;
- migrator/queue-init: credenciales one-shot propias y manifest de compatibilidad.

El validador comprueba formato sin imprimir valores, hostname DB `postgres`, nombre DB esperado, prefijo de login esperado, origen, digest, proceso, directorio de claves y rangos numéricos. Después conecta y exige que `agendia_environment` contenga el mismo `environment`, `environment_id` y `secret_set_id`; una referencia a la otra DB falla antes de actividad operativa.

El preflight de host compara hashes de secretos críticos entre staging/producción y rechaza igualdad de contraseñas DB, provider keys, tunnel credentials, KEK y QR keys sin revelarlos. También exige manifests de identidad WhatsApp distintos. Staging declara un número de ensayo y allowlist E.164 propia; su adapter bloquea salida fuera de esa allowlist. Ningún número de producción puede aparecer en el manifest de staging.

### 8.2 Almacenamiento

Solo se versionan `deploy/config/*.example.env` con valores no utilizables, nombres reservados `.invalid`, IDs cero y referencias `_FILE`; nunca URLs DB completas.

En el host:

- `/etc/agendia/<environment>/config`: directorio `root:agendia-ops 0750`, archivos `0640`;
- `/etc/agendia/<environment>/secrets`: directorio `root:agendia 0750`, secrets de app `root:agendia 0440`; el usuario/grupo no-login `agendia` usa UID/GID 10001, igual al runtime;
- secrets exclusivos del entrypoint PostgreSQL y backup: `root:root 0400`;
- `/etc/agendia/<environment>/release.env`: `root:agendia-ops 0640`, contiene la identidad GHCR por digest y metadata no secreta; en fallback, un archivo hermano generado contiene las imágenes resueltas y su hash, nunca tags;
- credencial GHCR read-only en `/root/.docker/config.json` `0600`, no en Compose.

Compose secrets son mounts de archivos host, no un vault: root/dockerd siguen siendo una frontera confiable. Ningún secret entra como build arg, label, argumento de proceso o valor versionado. El loader admite `_FILE`, borra buffers cuando es posible y los errores mencionan el nombre de variable, nunca su contenido.

### 8.3 Bootstrap y claves históricas

`bootstrap-admin` se ejecuta una vez tras migración, con email/password en archivos temporales `0400`. Mantiene el advisory lock actual y rechaza reemplazar un admin. Tras éxito:

1. obliga a verificar login y cambiar la contraseña inicial desde el flujo autorizado;
2. elimina el archivo de password bootstrap y registra solo resultado/fecha;
3. conserva únicamente la identidad hash en DB;
4. una recuperación futura usa un procedimiento explícito distinto, no vuelve a habilitar bootstrap.

La custodia Baileys cambia de clave única a keyring versionado: un archivo por versión en `baileys-kek.d/`, manifest con `currentVersion` y todas las versiones requeridas. Rotación:

1. añadir nueva KEK sin retirar anteriores, hacer backup y verificar disponibilidad;
2. marcarla current y ejecutar rewrap one-shot bajo lock por conexión;
3. comprobar que sesiones activas descifran y registrar cuántas referencias quedan por versión;
4. retener la KEK vieja mientras cualquier DB o snapshot retenido la pueda necesitar, más 30 días, y retirarla solo tras restore drill.

Las claves QR también se guardan en keyring histórico. Su rotación pausa linking, espera/purga links efímeros, cambia API y manager coordinadamente y conserva las versiones incluidas en backups. Staging y producción nunca comparten keyrings.

## 9. PostgreSQL, migraciones y pg-boss

### 9.1 Instancias y roles

Cada entorno tiene un contenedor PostgreSQL 16 Alpine fijado por digest, DB y volumen propios. En cada clúster se provisionan:

- `<env>_cluster_admin`: bootstrap del contenedor y provisión inicial de roles, no entregado a apps;
- `agendia_<env>_migrator`: propietario de DB/schema de aplicación, DDL y ledger, solo one-shot y sin `CREATEROLE` permanente;
- `agendia_<env>_api_login`: miembro de `agendia_runtime` y `agendia_admin_runtime`, porque un único proceso API ejerce ambos contextos mediante `SET ROLE`;
- `agendia_<env>_manager_login`: miembro únicamente de `agendia_whatsapp_runtime`;
- `agendia_<env>_queue_publisher_login`: usado por manager, miembro del nuevo rol mínimo `agendia_queue_publisher_runtime`, sin grants tenant del worker;
- `agendia_<env>_worker_login`: miembro de `agendia_worker_runtime` y del rol mínimo consumidor pg-boss;
- `agendia_<env>_queue_owner`: one-shot que posee y crea/actualiza internals pg-boss, no está presente en runtime;
- `agendia_<env>_backup`: login host-only con `CONNECT`, `pg_read_all_data` y `BYPASSRLS`, sin escritura ni ownership, para que `pg_dump` pueda incluir tablas con `FORCE ROW LEVEL SECURITY`.

Cada login usa una contraseña aleatoria distinta. La capacidad amplia `BYPASSRLS` del backup queda confinada al timer root, nunca se monta en apps y toda conexión se registra; es necesaria para un dump completo y se compensa con ausencia de escritura, filesystem `0400` y sin exposición de PostgreSQL.

Un paso inicial `provision-roles`, ejecutado explícitamente con `<env>_cluster_admin`, crea de forma idempotente roles `NOLOGIN` y logins; después su credencial se desmonta de Compose y queda bajo custodia root/offline para recuperación, no en runtime. Así las migraciones actuales que crean roles se separan/refactorizan y el migrador no necesita administrar roles. Los grants internos de pg-boss se generan y prueban tras `queue-init`; manager no recibe el rol general del worker. `queue-init` crea `ai-generate` y `conversation-summary` una vez y registra la versión pg-boss esperada. Runtime no posee DDL sobre `public` ni `pgboss`; cualquier DDL implícito de pg-boss se satisface previamente con `queue-init` o se detecta en tests como fallo.

### 9.2 Ledger y ejecución one-shot

La migración crea:

- `agendia_environment(environment, environment_id, secret_set_id, created_at)` con una sola fila inmutable salvo rotación explícita de `secret_set_id`;
- `agendia_schema_migrations(filename, sha256, applied_at, release_digest, execution)`;
- `agendia_service_heartbeats(service, instance_id, release_digest, state, started_at, last_seen_at)`.

Algoritmo de `migrate`:

1. validar entorno, digest, credencial y manifest de compatibilidad;
2. tomar `pg_advisory_lock(hashtextextended('agendia:migrations',0))` con timeout; nunca esperar indefinidamente;
3. verificar marker de entorno, conectividad, espacio, staging apagado para producción sensible, automatización pausada y backup externo exitoso con antigüedad menor a 24 h;
4. comparar cada fichero con el checksum del ledger; un nombre existente con checksum distinto aborta;
5. aplicar cada migration pendiente en transacción cuando PostgreSQL lo permita y registrar ledger en la misma transacción;
6. ejecutar `db:check`/fingerprint compatible, liberar lock y emitir evidencia JSON.

**Bootstrap de esquemas existentes:** si no existe ledger pero sí tablas, no se reejecuta SQL. Se construye una DB limpia desde las migraciones, se compara el fingerprint con la DB objetivo y solo si coincide exactamente se insertan entradas `execution=baseline` con checksums revisados. Cualquier drift aborta y requiere una migración correctiva revisada.

Toda release declara `expand-compatible` o `contract-maintenance`:

- `expand-compatible` conserva compatibilidad con el digest anterior y permite rollback de imagen;
- `contract-maintenance` exige ventana, apps/workers detenidos, backup/restore verificado y no promete rollback de imagen.

No hay migración down automática. Ante incompatibilidad se prefiere roll-forward; restaurar datos se hace a volumen aislado y es un procedimiento separado.

## 10. Health, readiness y observabilidad

### 10.1 Probes

| Proceso | Liveness | Readiness |
| --- | --- | --- |
| web | `GET /_health/live`: event loop responde 200. | `GET /_health/ready`: assets cargados y API interna ready; 200/503, sin secrets. |
| API | `GET /internal/live`: proceso responde. | `/internal/ready`: `select 1`, marker de entorno, ledger mínimo y secret set correctos. Solo red interna. |
| manager | `127.0.0.1:9090/live`: event loop/control loop reciente. | `/ready`: DB válida, scheduler iniciado, queue publisher listo y heartbeat DB menor a 60 s. No exige que todas las cuentas WhatsApp estén conectadas. |
| worker | `127.0.0.1:9090/live`: event loop y timers. | `/ready`: DB válida, pg-boss iniciado, handlers registrados y heartbeat menor a 60 s. Un worker idle sigue healthy. |
| postgres | `pg_isready`. | Consulta marker/ledger desde un check interno de privilegio mínimo. |
| cloudflared | endpoint `/ready` del agente en red interna. | Túnel conectado; reachability externa se mide aparte. |

Los endpoints loopback de manager/worker se consultan mediante `HEALTHCHECK` ejecutado dentro del mismo contenedor; no aparecen en redes ni ingress. Los heartbeats cada 30 s permiten al runbook detectar procesos idle bloqueados. Liveness no depende de un proveedor externo para evitar restart storms; readiness puede degradarse con razón codificada.

El único probe externo es una interfaz provider-agnostic: `HTTPS GET <APP_ORIGIN>/_health/live`, timeout 5 s, cada 5 minutos, espera 200 y un JSON versionado sin commit completo, tenant ni secret. La elección/alta del monitor externo es manual.

### 10.2 Logs y métricas operativas

Los cuatro procesos emiten JSON line-delimited con `timestamp`, `level`, `service`, `environment`, `release_digest`, `event`/`code`, `instance_id` y, cuando aplica, `request_id` o `job_id`. Correlación propaga `request_id` API y IDs opacos de job; `business_id` solo se registra cuando es imprescindible y preferentemente como hash estable por entorno.

Nunca se registran cookies, headers Authorization, passwords, DB URLs, query strings sensibles, bodies, texto de mensajes, JID/números, QR, tokens, provider prompts/responses, ciphertext, DEK/KEK ni contenido de secret files. La redacción ocurre antes del logger, complementando `redactBaileysDetails`. PostgreSQL y cloudflared usan salida JSON cuando la herramienta lo soporta; toda salida queda bajo rotación Docker.

El runbook `host-health` devuelve JSON y exit code para:

- filesystem/inodos de root y `/srv/agendia`;
- RAM disponible, swap usado, load e I/O wait;
- temperatura CPU/SSD frente a umbral conocido;
- `smartctl` health, errores y desgaste;
- estado Docker/containers, restarts y OOM;
- edad de heartbeats, backlog/edad pg-boss y último backup válido;
- reachability HTTPS desde un monitor fuera de la LAN.

No se introduce una plataforma de métricas completa. Los checks son una interfaz consumible por systemd timer, un monitor externo futuro o revisión humana.

## 11. Backup y recuperación

### 11.1 Backup diario

El host instala restic y age mediante runbook. `backup-production` corre por systemd timer a las 03:30 con `RandomizedDelaySec=30m`, solo si staging está apagado y los gates de carga permiten continuar:

1. crear directorio temporal `0700` en `/srv/agendia/production/backup-staging`;
2. ejecutar desde una imagen PostgreSQL fijada `pg_dump --format=custom --no-owner --no-acl --serializable-deferrable` con login backup; el dump es consistente sin parar producción;
3. crear inventario de versiones KEK/QR requeridas y cifrar el key bundle con recipient público `age`; la private identity `age` no reside en el host;
4. ejecutar restic sobre dump, `keys.tar.age`, manifest de release/schema y evidencia; `RESTIC_REPOSITORY` acepta SFTP/S3/B2/Azure u otro backend soportado y **debe** apuntar fuera del PC;
5. verificar que el snapshot existe, borrar temporales de forma segura y emitir evidencia sin secrets.

Separación de custodia:

- credencial del proveedor/destino: `/etc/agendia/backup/repository.env`, `root:root 0400`;
- password restic: `/etc/agendia/backup/restic-password`, `root:root 0400`, con copia de recuperación offline separada;
- recipient público age en el host; private identity age custodiada offline por el responsable de recuperación;
- KEK/QR en keyrings de app, nunca dentro de los ficheros de credencial restic.

La retención inicial es 7 daily, 5 weekly y 12 monthly. `forget` se ejecuta semanalmente y `prune` solo en ventana de baja carga con staging apagado. `restic check` de metadata es diario, `--read-data-subset=5%` semanal y lectura completa trimestral en una máquina de recuperación o ventana aprobada, no mientras staging/migración compiten.

Objetivos: RPO máximo 24 horas; si el último snapshot verificable supera 24 h, producción queda en estado operativo degradado y no se hace migración. RTO objetivo del runbook: 6 horas desde disponibilidad de host/destino/credenciales; es un objetivo medido, no HA.

### 11.2 Restore drill y evidencia

Al menos trimestralmente y antes de usuarios reales se ejecuta un drill con project único `agendia-restore-YYYYMMDD`, network interna y volumen que no comparte mounts con staging/producción. Preferentemente corre en otra máquina x86_64; si debe correr en el host, staging está apagado, producción se mantiene dentro de gates y el drill tiene límites estrictos. Un restore completo que exceda capacidad requiere ventana de mantenimiento de producción.

El drill:

1. restaura un snapshot restic elegido;
2. descifra el bundle con la private identity age proporcionada temporalmente;
3. crea PostgreSQL aislado, aplica schema compatible y restaura dump con `pg_restore --exit-on-error`;
4. verifica fingerprint, conteos agregados, RLS, jobs pendientes y ciphertexts;
5. compara versiones KEK referenciadas con keyring y descifra una muestra controlada por versión sin emitir plaintext; verifica clave QR;
6. destruye solo recursos `agendia-restore-*` tras conservar evidencia.

Formato JSON de evidencia:

```json
{
  "schemaVersion": 1,
  "operation": "backup|restore-drill",
  "environment": "production",
  "releaseDigest": "sha256:...",
  "snapshotId": "...",
  "recoveredAsOf": "ISO-8601",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "durationMinutes": 0,
  "rpoHours": 0,
  "database": "verified",
  "historicalKekVersions": ["version-identifiers-only"],
  "qrKeyAvailable": true,
  "result": "pass|fail"
}
```

No contiene nombres de tenant, teléfonos ni claves. Se guarda localmente, dentro del siguiente backup y en el registro de gate aprobado. Seleccionar/crear el destino externo y designar custodios sigue siendo externo al repositorio.

## 12. Runbook de aprovisionamiento Ubuntu

El runbook será declarativo, con bloques “precheck → comando propuesto → verificación → rollback”, y nunca se invocará desde CI/deploy.

1. **Acceso y evidencia:** confirmar consola física disponible, hostname, versión Ubuntu, arquitectura x86_64, interfaz `wlo2`, IP LAN, segunda sesión SSH y backup de configuración antes de red/disco.
2. **Usuario/directorios:** crear usuario/grupo system `agendia` UID/GID 10001, shell nologin, sin grupo docker; crear `/etc/agendia`, `/srv/agendia`, permisos anteriores y grupo operador `agendia-ops`.
3. **Docker:** añadir repositorio APT oficial mediante keyring, comprobar que soporta el codename real de Ubuntu 26.04 y revisar versiones; instalar paquetes concretos Docker Engine/CLI/containerd/buildx/Compose plugin. Si el repositorio no soporta la versión, abortar y documentar alternativa, no ejecutar scripts `curl | sh`. Configurar `data-root` en `/srv/agendia/docker`, log defaults y `live-restore` si es compatible; habilitar Docker y verificar con imagen inocua.
4. **LVM:** ejecutar solo comandos de inspección (`lsblk`, `pvs`, `vgs`, `lvs`, filesystem, mounts), SMART y backup. Estrategia preferida: LV dedicado ext4 de hasta 200 GiB para `/srv/agendia`, dejando al menos 25% del VG libre. El tamaño se reduce o se aborta si los hechos no coinciden. Crear LV/filesystem, editar `fstab`, mover Docker data o ampliar root son pasos destructivos/semidestructivos que requieren dispositivo/LV exacto, backup, prueba de mount, consola y confirmación humana explícita; el documento no los ejecuta ni ofrece un comando copiable sin placeholders validados.
5. **Cifrado:** comprobar si el host ya usa LUKS. Añadir cifrado a un sistema existente puede requerir migración/reinstalación y no se automatiza. Si no existe, registrar y aceptar el riesgo de robo físico antes de usuarios; secrets siguen con permisos y backup cifrado.
6. **Firewall:** UFW default deny incoming/allow outgoing; permitir SSH solo desde `192.168.18.0/24` sobre LAN/Wi-Fi, sin reglas 80/443/5432/3000/3001. Verificar segunda sesión antes de activar. Tunnel usa salida 443/7844 según documentación vigente.
7. **SSH:** claves verificadas antes de deshabilitar password, `PermitRootLogin no`, usuarios allowlist, límites de intentos y logs. Sigue LAN-only; no modificar Wi-Fi/SSH remotamente sin consola.
8. **Wi-Fi:** revisar Netplan/NetworkManager aplicable, desactivar power saving si está causando cortes, configurar reconexión y medir pérdida/latencia. Un cambio de SSID/credencial requiere consola y rollback.
9. **Tiempo:** habilitar `systemd-timesyncd` o chrony, verificar sincronía antes de TLS, logs y backups.
10. **Disco/temperatura:** instalar/configurar `smartmontools` y `lm-sensors` si son compatibles; timers diarios SMART corto, semanal largo en baja carga y alertas por temperatura/desgaste. No lanzar test SMART largo durante backup/migración/staging.
11. **Updates:** seguridad automática sin reboot automático; actualización Docker/kernel en ventana con backup, staging apagado y prueba de rollback/reboot.
12. **Reboot:** mounts antes de Docker; servicios prod `unless-stopped` recuperan el digest ya fijado; staging no vuelve. Tras boot verificar SMART, reloj, DB marker, ledger, heartbeats, backlog y túnel antes de declarar ready.
13. **Sin UPS:** documentar que cortes pueden causar horas de caída. Antes de apagado previsto drenar y apagar; después de corte no asumir consistencia: revisar filesystem/SMART/PostgreSQL y backup. La aceptación explícita de este riesgo es gate humano.

## 13. Flujos de control y datos

### 13.1 PR a release

```text
short branch -> PR -> required GitHub-hosted checks -> SOLO: no impossible reviewer gate
-> squash main -> verify merged PR + exact-SHA checks -> P0 packaging decision
-> build once: universal image OR bounded process-image set + OCI manifest
-> read-only four-command contract -> scan/SBOM/provenance -> release digest
```

En MULTI-MAINTAINER se inserta aprobación independiente/CODEOWNERS antes del squash. En ambos modos una release sin PR y checks verificables se rechaza.

### 13.2 Staging a producción

```text
release digest -> explicit manual staging authorization -> LAN operator preflight
-> pull/verify digest and all bound image digests -> staging migrate/queue-init
-> four processes -> private smoke -> staging evidence -> teardown staging
-> separate manual production authorization for exact same release digest
-> prod preflight + external backup -> migrate if declared
-> atomic release.env/resolved-images switch -> Compose convergence
-> readiness + external reachability -> promotion evidence
```

El operador escribe archivos temporales, valida todas las referencias `@sha256`, verifica que el manifiesto resuelto coincide con la autorización, ejecuta `docker compose config`, guarda la identidad anterior y renombra atómicamente. Nunca cambia una tag mutable. GitHub termina en la autorización: no ejecuta ninguno de estos pasos sobre el host.

### 13.3 Datos de aplicación

El navegador solo ve el origen HTTPS web. Next proxifica `/api` internamente. API autentica/autoriza y accede mediante roles con RLS. Manager conserva sesiones cifradas y publica jobs; worker consume con concurrencia uno y llama DeepSeek. PostgreSQL de cada entorno contiene únicamente su estado y heartbeats. Logs reciben metadata redactada, no payloads.

## 14. Modos de fallo y respuesta

| Fallo | Detección | Comportamiento/recuperación |
| --- | --- | --- |
| P0 no demuestra bundling universal | fixtures native/dynamic/assets o arranque real | Detener dependencias downstream; activar `release-set` si la alternativa exige refactorización amplia, sin introducir `tsx`/`next dev`. |
| Digest/provenance inválido, set mezclado o plataforma incorrecta | workflow, schema y `deployctl` | Bloqueo antes de pull/up; conservar release actual. |
| Protección GitHub no disponible por plan | matriz de controles/preflight de gobierno | Usar fallback PR+exact-SHA+checks+autorización manual; no afirmar enforcement inexistente ni desplegar desde GitHub. |
| Config/secret cruzado o ausente | validador + marker DB + hash preflight | Proceso no sirve ni consume; error solo con nombre/código. |
| PostgreSQL no ready | health/dependency | Apps permanecen unready; no migran. Reinicio acotado, investigar disco/DB. |
| Checksum de migration cambiado o lock ocupado | migrador | Abort sin DDL adicional; no arrancar digest nuevo. |
| Migration incompatible | manifest `contract-maintenance` | Ventana, backup y apps detenidas; roll-forward o restore aislado, no falso rollback de imagen. |
| API/web falla tras deploy compatible | readiness/external monitor | Retirar tunnel y volver al digest anterior; no rebuild. |
| Manager/worker bloqueado idle | heartbeat >60 s | Unready y restart controlado; leases/jobs durables permiten recuperación. |
| Proveedor externo falla | códigos seguros y backlog | Liveness sigue verde; readiness/operación se degrada sin restart storm; reintentos acotados. |
| Tunnel/ISP/Wi-Fi falla | cloudflared + monitor externo | Servicio no accesible; datos siguen locales. No abrir puertos como workaround. |
| Presión RAM/CPU/I/O | host-health/OOM/restarts | Destruir staging primero, pausar trabajo no esencial; swap no amplía capacidad aceptada. |
| Disco bajo/SMART/temperatura | timer host | Bloquear staging, backup pesado y deploy; apagar controladamente si hay riesgo físico. |
| Backup falla o >24 h | timer/evidencia | Alertar, bloquear migración/usuarios nuevos; reparar destino y verificar antes de continuar. |
| Corte eléctrico | ausencia de heartbeats/boot checks | Aceptar downtime; verificar storage, DB, ledger y backlog antes de reabrir ingreso. |
| Teardown recibe proyecto incorrecto | assertions/labels | Fallo cerrado; nunca ejecuta eliminación. |

## 15. Rollout y rollback

### Rollout piloto

1. Ejecutar P0 sin tocar el host y registrar `universal-image` o `release-set`; ninguna slice de Compose/promoción depende antes de una imagen universal no probada.
2. Implementar packaging, contrato read-only de cuatro comandos, config y health en CI amd64.
3. Incorporar Compose, aislamiento y tests de teardown.
4. Incorporar migrador/roles/queue-init y probar fresh DB, baseline y checksums alterados.
5. Incorporar backup/restic interface y drill con repositorio temporal de test.
6. Configurar gobierno SOLO PILOT con matriz de controles realmente disponibles; probar PR/check evidence y autorizaciones manuales sin acceso al host.
7. Revisar runbooks; aprovisionar host manualmente con consola y sin datos reales.
8. Medir baseline, levantar staging privado con identidades de ensayo y validar la identidad de release.
9. Crear producción vacía, ejecutar backup y restore drill externo.
10. Aprovisionar y verificar túnel/dominio/DNS/monitor; obtener aceptación Wi-Fi/sin UPS.
11. Solo entonces admitir usuarios reales mediante decisión humana registrada.

### Rollback

- **Aplicación:** pausar ingreso, restaurar atómicamente la identidad anterior por digest —imagen universal o manifiesto OCI completo—, converger Compose y comprobar readiness. Solo es válido si el manifest declara compatibilidad con el esquema actual.
- **Configuración:** restaurar la versión host anterior; nunca copiar config/secrets de otro entorno.
- **DB:** no se revierte cambiando imagen. Para migración incompatible, roll-forward o restore del snapshot a volumen nuevo aislado; validar y después hacer un switch controlado.
- **Host:** cada paso de instalación/red/mount conserva backup y reversión propia. No se deshace LVM automáticamente.
- Se conservan al menos digest actual y anterior; staging puede destruirse y recrearse desde cero.

## 16. Superficies de implementación previstas

| Área | Archivos probables | Specs cubiertas |
| --- | --- | --- |
| CI/gobierno | `.github/workflows/ci.yml`, `release.yml`, `authorize-promotion.yml`, `.github/CODEOWNERS`, matriz SOLO/MULTI y fallback por plan | `immutable-release-promotion`, `delivery-environments` |
| Imagen | prueba P0, `Dockerfile` universal o Dockerfiles acotados por proceso, `.dockerignore`, `deploy/images.lock`, schema/manifiesto OCI, entrypoints release en `apps/*`, `apps/web/next.config.ts`, contrato read-only | `immutable-release-promotion`, `persistence-and-operations` |
| Config | nuevo `packages/runtime-config/**`, integración en API/manager/worker/web tools, `deploy/config/*.example.env` | `environment-isolation`, `delivery-environments` |
| Runtime/health/logs | health modules por app, heartbeat DB, logger/redaction, signal handling | `home-server-deployment`, `persistence-and-operations` |
| Compose/deploy | `deploy/compose.yml`, overrides/profiles, `scripts/deployctl.ts`, tests de manifests/teardown | `delivery-environments`, `environment-isolation`, `home-server-deployment` |
| DB | nueva migration para marker/ledger/heartbeat/roles, migrador y queue-init one-shot, pruebas de grants/checksum/baseline | `persistence-and-operations`, `environment-isolation` |
| Backup | scripts provider-agnostic restic/age, systemd examples, extensión del restore drill y schemas de evidencia | `backup-and-restore` |
| Runbooks | `docs/runbooks/host-provisioning.md`, `deploy.md`, `staging-window.md`, `backup-restore.md`, `rollback.md`, `disaster-recovery.md` | las seis specs |
| Tests | `tests/unit/runtime-config*`, `tests/integration/migration-ledger*`, `tests/contracts/release-manifest*`, `tests/e2e/release-image*`, aislamiento/backup/drill | las seis specs |

El alcance explícito se expande más allá de `packages/coding-agent`: ese paquete no existe en este repositorio y el cambio afecta necesariamente apps, DB, workflows, deploy y runbooks.

## 17. Mapeo de verificación a las seis specs

| Requirement | Evidencia automatizada principal | Evidencia operativa |
| --- | --- | --- |
| Desarrollo local preservado | tests de `dev-stack`; `bun run dev` no acepta URLs remotas | revisión del example dev |
| Test efímero/determinista | suites Testcontainers, no-egress, doubles; comandos de `openspec/config.yaml` | logs CI sin secrets |
| Staging temporal/prod persistente | contract tests Compose/restart/profiles | ventana y teardown con IDs prod intactos |
| Artefacto único | P0 + schema discriminado: imagen universal o manifiesto OCI que vincula los cuatro comandos/digests | digest y attestations GHCR de la identidad coherente |
| Puertas/procedencia | workflows + contrato read-only de cuatro comandos + scan | checks exact-SHA; autorización manual SOLO o aprobación independiente MULTI |
| Promoción sin ramas/rebuild | workflow/schema rechaza tags, mezcla de imágenes y selección por rama | mismo digest de imagen/manifiesto en staging y producción |
| Datos/volúmenes/roles separados | tests Compose + dos DB + grants | checksums/labels antes/después teardown |
| Secrets/WhatsApp separados | unit config/redaction/secret-scan + hash-crosscheck | manifests de identidad y custodios |
| Fail-fast config | tabla de casos por proceso y cross-env DB | fallo antes de readiness |
| Tunnel/origen/superficie | tests de config cloudflared y ausencia `ports` | scan externo: solo hostname web |
| Prioridad/capacidad | tests `deployctl` de exclusiones | baseline y evidencia host-health |
| Operación observable | probe/heartbeat/restart/signal y `release-image-readonly` para cada proceso | Docker health, mounts efectivos, log rotation y runbook |
| Gates externos | policy test de checklist incompleto | evidencias aceptadas antes de usuarios |
| Migraciones/bootstrap | fresh/baseline/checksum/lock/grants/bootstrap tests | backup + manifest compatibilidad |
| Runbooks separados | lint/enlaces y contract test de secciones | simulación de incidente |
| Backup diario cifrado | repositorio restic local efímero en CI, manifest sin secrets | snapshot externo <24 h |
| KEK histórica recuperable | test de keyring/rewrap y missing-key fail | drill por versión |
| Restore aislado RPO/RTO | Testcontainers project aislado y evidence schema | drill externo, RPO <=24 h, RTO <=6 h |

Antes de cerrar cada slice quedan verdes, según aplique: `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, `bun run test:contracts`, `bun run test:tenant-isolation`, `bun run test:e2e`, `bun run test`, `bun run db:check` y `bun run build`. `bun run lint` es un comando objetivo exigido por `openspec/config.yaml`, no un hecho actual: su primera slice añade script/configuración y prueba su ausencia/configuración inválida antes de hacerlo gate. “Según aplique” permite checks enfocados durante RED/GREEN, pero el cierre integral exige todos los comandos ya implementados y el contrato de release seleccionado.

## 18. Estrategia TDD estricta y slices revisables

Cada incremento usa y conserva evidencia explícita:

1. **RED:** añadir primero una prueba que falle por el requisito nuevo; registrar comando, nombre de test y fallo esperado. Un error de compilación accidental no cuenta como RED útil.
2. **GREEN:** implementar el mínimo para que esa prueba pase; registrar el mismo comando verde.
3. **TRIANGULATE:** añadir al menos un caso adverso o segunda dimensión —otro proceso/entorno, secret cruzado, digest/tag, lock concurrente, idle worker, teardown prod— y demostrar que evita una implementación hardcoded.
4. **REFACTOR:** eliminar duplicación y mejorar límites manteniendo verdes test enfocado, lint y typecheck; al cerrar el slice ejecutar los gates afectados.

Slices de implementación, no un archivo de tasks:

0. **P0 bloqueante:** fixtures RED de native/dynamic/assets/workspaces, bundles Bun, Next standalone y arranque read-only de los cuatro procesos; registrar decisión universal/fallback;
1. script/configuración de lint, reconciliando el comando OpenSpec hoy ausente;
2. schema de release discriminado y validadores de digest/plataforma/conjunto;
3. packaging elegido, entrypoints con señales y ausencia verificable de `tsx`/`next dev`;
4. contrato `release-image-readonly` de cuatro procesos y smoke por identidad de release;
5. config central por proceso y secrets `_FILE`;
6. marker de entorno y rechazo cross-environment;
7. probes, heartbeats, logs/redacción;
8. Compose prod/stg, tmpfs exactos, networks, límites y teardown seguro;
9. roles login, segregación pg-boss y `queue-init`;
10. ledger/checksum/lock/baseline y compatibilidad;
11. workflows CI/release/provenance/SBOM/scan y verificador PR+exact-SHA;
12. autorización SOLO PILOT, fallback por plan y `deployctl` pull-based; hardening MULTI queda preparado pero no activado;
13. restic/age backup, retención y evidencia;
14. restore drill aislado y KEK/QR históricas;
15. runbooks de host, ventanas, deploy, rollback y recovery;
16. triangulación integral en staging sin usuarios.

El presupuesto interactivo de 400 líneas cambiadas **será excedido ampliamente por el cambio completo**. Estimación revisada: 35–50 archivos y aproximadamente 2.800–4.500 líneas entre código, workflows, Compose, pruebas y runbooks; el fallback puede sumar 4–8 archivos de Docker/manifest pero evita una refactorización de aplicación abierta. Cada slice debe intentar mantenerse por debajo de 400 líneas y tener una decisión principal. P0, packaging+readonly smoke, DB roles+migrator y backup+drill probablemente requieren subdivisión adicional. Antes de aplicar una slice que exceda el presupuesto se pedirá aprobación de riesgo/revisión; no se ocultarán documentación ni tests en un diff masivo.

## 19. Gates externos y criterio de habilitación real

Este SDD implementará contratos, imagen, automatización, tests, Compose y runbooks. Permanecen manuales y bloqueantes:

- crear cuenta/zona/tunnels Cloudflare, disponer de dominio y DNS, definir reviewers de Access y comprobar HTTPS;
- seleccionar/crear un destino restic fuera del PC, credenciales, custodios del password restic y private identity age;
- aprovisionar físicamente el host, Docker, filesystem/LVM, firewall, SSH, Wi-Fi, reloj y monitorización SMART/temperatura;
- crear secrets reales, números/cuentas WhatsApp distintos y credenciales DeepSeek por entorno;
- ejecutar y aceptar un restore drill externo;
- aceptar por escrito Wi-Fi como única red, ausencia de UPS, posible falta de cifrado de disco y RTO de varias horas;
- validar términos/operación de Baileys y proveedores y autorizar el inicio de usuarios.

Un placeholder, un hostname local, una copia en el mismo SSD o un check sin evidencia no satisface estos gates. Producción puede levantarse vacía para validación, pero no admitir usuarios reales hasta que todos figuren aceptados.

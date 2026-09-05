# Propuesta: establecer los entornos de entrega de agendIA

## Resumen ejecutivo

Este cambio establecerá una única ruta de entrega para agendIA que conecte cuatro entornos con funciones distintas: desarrollo en la estación del desarrollador, test efímero y determinista, staging privado y temporal en el servidor doméstico, y producción persistente en ese mismo servidor.

La regla central será construir una sola vez un artefacto inmutable identificado por digest, probarlo, desplegar ese mismo digest en staging y promocionarlo sin reconstrucción a producción. Entre entornos solo podrán variar la configuración y los secretos. El cambio conservará el flujo local actual y no alterará el comportamiento del producto, la interfaz, el modelo multitenant, los flujos de WhatsApp ni el comportamiento de IA.

La entrega se diseñará para las restricciones reales del servidor doméstico y separará explícitamente lo que se implementa en el repositorio, lo que un operador debe aprovisionar una sola vez en el host y lo que seguirá siendo un gate externo antes de admitir usuarios reales.

## Why

agendIA ya implementa el flujo funcional de la V1, pero el repositorio no ofrece una ruta reproducible para convertir el código probado en una release operable. El `build` raíz comprueba TypeScript y construye la web, pero API, manager y worker todavía arrancan desde TypeScript; no existe una imagen de aplicación, una definición de staging/producción ni un pipeline que demuestre la promoción del mismo artefacto.

Esta brecha hace que un despliegue dependa de pasos ad hoc, dificulta explicar qué versión está ejecutándose y permite divergencias entre lo probado y lo publicado. También deja sin contrato operativo la separación de datos y secretos, la recuperación, los probes, los reinicios y los límites de recursos necesarios para operar en un único host modesto.

El cambio es necesario ahora para que la V1 implementada pueda llegar a usuarios reales con una ruta de entrega comprensible, repetible y recuperable, sin convertir el servidor doméstico en un entorno de desarrollo ni aceptar que staging y producción compartan estado sensible.

## Intención y resultado esperado

Al finalizar el cambio deberá ser posible:

1. continuar desarrollando en la workstation con el flujo local existente;
2. ejecutar pruebas deterministas y efímeras, sin proveedores ni secretos reales, tanto localmente como en un futuro runner de CI;
3. producir una sola imagen o artefacto de release por commit y referenciarlo por digest;
4. validar temporalmente ese digest en un staging privado, aislado y limitado;
5. promocionar el digest validado, sin reconstruirlo, a una producción persistente;
6. operar, respaldar y restaurar producción sin mezclar datos, credenciales, sesiones ni material criptográfico entre entornos.

“Persistente” y “siempre encendida” describen la modalidad normal de producción, no una promesa de alta disponibilidad ni un SLA. Se aceptan interrupciones de varias horas por energía, Wi-Fi, ISP o mantenimiento mientras no exista UPS.

## Proposal question round

La ronda previa de producto y operación quedó resuelta en el handoff confirmado; no se abre una nueva entrevista para esta propuesta. Se toman como decisiones confirmadas los cuatro entornos, la promoción por digest sin reconstrucción, el aislamiento total entre entornos, staging por ventanas controladas, el túnel saliente y el backup externo como gates, y la ausencia de cambios funcionales.

Las selecciones de proveedor de túnel, dominio/DNS, destino de backup y herramientas concretas permanecen deliberadamente abiertas para diseño o seguimiento. Esta reserva no permite omitir los contratos ni los gates descritos en esta propuesta.

## What Changes

### Sistema coherente de cuatro entornos

| Entorno | Resultado requerido | Límite principal |
| --- | --- | --- |
| Desarrollo | Preservar `bun run dev`, el archivo local de entorno, PostgreSQL local y la experiencia actual de iteración. | Permanece en la workstation y nunca usa datos, secretos, sesiones ni servicios de staging o producción. |
| Test | Ejecutar una pila determinista y descartable con PostgreSQL efímero y dobles de Baileys y DeepSeek. | No necesita proveedores ni secretos reales y debe ser portable a un futuro CI. |
| Staging | Validar una release candidata en el servidor doméstico usando exactamente el digest candidato. | Es privado, temporal, aislado, sujeto a cuotas y apagado fuera de ventanas controladas. |
| Producción | Mantener la release aprobada y el estado real de usuarios de manera persistente. | Es la única pila normalmente activa de forma continua y concentra la prioridad de recursos del host. |

Staging no será una réplica permanentemente coexistente con producción. Solo podrá activarse cuando la capacidad medida del host, la ventana operativa y los límites de recursos lo permitan; no se ejecutará durante picos, migraciones sensibles, restauraciones, mantenimiento, backlog relevante ni cargas intensivas de build o test.

### Promoción de artefacto inmutable

- La ruta de release construirá una vez el artefacto de los cuatro procesos a partir de dependencias bloqueadas.
- El artefacto tendrá una identidad inmutable por digest; las etiquetas mutables no serán evidencia suficiente de promoción.
- Las puertas de test se ejecutarán antes de la construcción y se añadirán comprobaciones sobre la imagen arrancada en modo de release, sin `next dev` ni `tsx` como mecanismo de producción.
- Staging desplegará el digest candidato con su propia configuración y secretos.
- Producción solo recibirá el mismo digest ya validado; no habrá rebuild por entorno ni copia de árboles de trabajo al host.
- La release hará explícitos los cuatro procesos, sus comandos, dependencias operativas, cierre ordenado y estados de health/readiness.

### Aislamiento de configuración, estado y credenciales

Desarrollo, test, staging y producción no compartirán:

- datos ni bases PostgreSQL;
- credenciales o roles login de PostgreSQL;
- secretos de aplicación o proveedores;
- volúmenes persistentes;
- sesiones, números ni material de vinculación de WhatsApp;
- KEK de Baileys ni claves de cifrado de QR;
- credenciales de bootstrap del administrador.

La configuración de cada proceso será validada al inicio y fallará de forma segura ante variables ausentes, combinaciones inseguras o referencias cruzadas entre entornos. Las URL de base de datos se tratarán como secretos. Los ejemplos versionados no contendrán credenciales utilizables y los secretos no se incorporarán a imágenes, logs ni historial de Git.

### Operación, migración y recuperación

- Staging y producción tendrán definiciones parametrizadas, pero identidades, redes, volúmenes, roles y secretos independientes.
- La producción declarará políticas de reinicio, límites de recursos, rotación de logs y probes sin secretos.
- Las migraciones serán un paso operativo único y controlado, con preflight, backup y compatibilidad de release explícita; no se ejecutarán de forma implícita por cada réplica al arrancar.
- El backup diario externo y cifrado cubrirá PostgreSQL y la custodia necesaria de todas las KEK históricas de Baileys y de la clave QR.
- La recuperación incluirá una verificación operable de restauración; conservar ciphertext sin sus claves históricas no contará como backup recuperable.
- Los runbooks deberán distinguir actualización, rollback de aplicación, recuperación de datos y restauración completa.

## Capabilities

### New Capabilities

- `delivery-environments`: define el propósito, la topología y los límites verificables de desarrollo, test, staging y producción como partes de una sola ruta de entrega.
- `immutable-release-promotion`: exige construir una vez, identificar por digest, probar y promocionar sin reconstrucción el mismo artefacto desde test hasta staging y producción.
- `environment-isolation`: impide compartir datos, roles, credenciales, secretos, volúmenes, sesiones de WhatsApp, números o credenciales bootstrap entre entornos.
- `home-server-deployment`: establece la operación de staging temporal y producción persistente en un único host doméstico, con ingreso basado en túnel saliente, prioridad de producción y límites de coexistencia.
- `backup-and-restore`: establece backup externo diario cifrado y restauración verificable de PostgreSQL junto con la custodia de material criptográfico histórico necesario para recuperar sesiones.

### Modified Capabilities

- `persistence-and-operations`: amplía la operación existente con health/readiness de los procesos de release, reinicios controlados, logs seguros y rotados, migraciones gobernadas, backup y recuperación verificable.

### Capabilities de producto sin cambio

- `administration-and-isolation`, `configuration-and-whatsapp` y `messaging-and-ai` mantienen sus requisitos funcionales actuales.
- El cambio de entrega no modifica autenticación, autorización, aislamiento entre tenants, cardinalidad de usuarios o conexiones, reglas de admisibilidad de mensajes, comportamiento de DeepSeek/Baileys ni experiencia web.

## Alcance y separación de responsabilidades

### 1. Artefactos de implementación en el repositorio

Queda dentro del cambio implementar y versionar:

- empaquetado reproducible para web, API, manager y worker como una release coherente;
- comandos de ejecución de release que no dependan de servidores de desarrollo;
- definición parametrizada de las pilas staging y producción;
- esquema y validación fail-fast de configuración por proceso y entorno;
- ejemplos de configuración seguros y documentación de inyección de secretos;
- health/liveness/readiness, cierre ordenado, políticas de reinicio, límites de recursos y logging operativo seguro;
- automatización de pruebas deterministas, pruebas de imagen y puertas de promoción por digest;
- automatización y documentación de migración, backup cifrado, verificación y restore drill;
- runbooks de despliegue, promoción, rollback, recuperación y operación por ventanas de staging.

Estos artefactos podrán expresar prerrequisitos y comandos, pero no ejecutarán aprovisionamiento irreversible del host como efecto implícito de una build o un test.

### 2. Aprovisionamiento único del host y trabajo de runbook

Queda dentro del alcance documental, pero fuera de la ejecución de este cambio, preparar un runbook para que un operador pueda:

- crear el usuario de servicio, propietarios y directorios persistentes;
- instalar y configurar el motor de contenedores/Compose y las dependencias de backup seleccionadas;
- configurar SSH, firewall, actualizaciones, reloj, DNS local y supervisión del servicio;
- revisar el SSD, SMART, LVM, ampliación del LV raíz, capacidad efectiva y cifrado en reposo;
- preparar almacenamiento de secretos, límites del host y rotación de logs;
- medir CPU, RAM, swap, I/O, conexiones y backlog antes de autorizar ventanas de staging.

La propuesta no instala Docker, no amplía LVM, no cambia el firewall y no aprovisiona el servidor.

### 3. Gates externos de producción

Antes de admitir usuarios reales deberán estar resueltos y verificados fuera del repositorio:

- **Ingreso:** mecanismo/proveedor de túnel saliente, dominio, control DNS y política de acceso administrativo; no se dependerá de port forwarding entrante bajo CGNAT/doble NAT.
- **Backup:** destino externo al PC, credenciales, cifrado, retención y responsable; deberá existir al menos una restauración probada que recupere PostgreSQL y demuestre acceso a KEK históricas y clave QR.
- **Riesgo doméstico:** aceptación explícita de Wi-Fi como única red y de la operación sin UPS, incluidos posibles cortes de varias horas y el procedimiento de retorno seguro.

Ningún placeholder local, backup en el mismo SSD ni exposición directa de puertos internos satisfará estos gates.

## Evidencia y estado actual del repositorio

- El monorepo usa Bun/TypeScript y contiene cuatro procesos: Next.js web, API Fastify, manager Baileys y worker pg-boss/DeepSeek.
- El `build` raíz actual no produce ejecutables de release para API, manager y worker.
- No existen `Dockerfile`, manifiesto de imagen, Compose de aplicación ni workflows de CI; el `docker-compose.yml` existente solo ofrece PostgreSQL para desarrollo con credenciales y volumen locales.
- `scripts/dev-stack.ts` fija orígenes, API y PostgreSQL a loopback, arranca `next dev` y hace bootstrap local; se conservará como herramienta de desarrollo, no se promoverá a supervisor de producción.
- Las pruebas ya usan `postgres:16-alpine` mediante Testcontainers y dobles deterministas de Baileys y DeepSeek, incluida una E2E que arranca los cuatro procesos.
- `scripts/restore-drill.ts` demuestra un contrato inicial de dump/restauración con datos sintéticos, pero no constituye todavía un backup diario externo de la pila real.
- La web consume `/api`, Next reescribe al origen interno y la API aplica comparación exacta de `Origin`; la publicación deberá conservar un único origen HTTPS y no exponer API, PostgreSQL, manager ni worker directamente.
- PostgreSQL sostiene tanto el registro como pg-boss. Los roles runtime existentes son NOLOGIN y producción requerirá logins separados por función y por entorno.
- El estado Baileys está cifrado con DEK envuelta por KEK versionada, y el QR usa otra clave; una restauración sin las claves históricas correspondientes dejaría sesiones irrecuperables.

## Host objetivo y restricciones operativas

El host confirmado es un Ubuntu Server 26.04.1 LTS x86_64 dedicado, con Celeron N4020 de 2 CPU, 7.1 GiB de RAM, 4 GiB de swap y SSD de 447 GiB. El LV raíz actual es de 100 GiB y existe capacidad LVM libre que el runbook deberá evaluar. SSH está activo, Docker no está instalado y la conectividad es exclusivamente Wi-Fi.

Estas restricciones implican una sola réplica de manager por entorno, prioridad de recursos para producción, cuotas explícitas para staging y exclusión de cargas intensivas simultáneas. El swap no se considerará capacidad normal de PostgreSQL o de los workers. El host, el ISP, el Wi-Fi y la energía siguen siendo puntos únicos de fallo aceptados.

## Impacto y áreas afectadas

| Área | Impacto previsto |
| --- | --- |
| Desarrollo local | Conserva el flujo actual; Docker/Testcontainers solo es requisito para quien ejecute suites que lo necesiten. |
| Pruebas | Añade puertas de imagen y release sin sustituir las suites unitarias, integración, contratos, aislamiento, E2E, migraciones y build existentes. |
| Empaquetado | Introduce una unidad de release reproducible para los cuatro procesos y comandos de runtime explícitos. |
| Configuración y secretos | Se formalizan inventario, validación, segregación e inyección por entorno. |
| Base de datos | Se separan roles y estado por entorno y se gobiernan migraciones, backup y restauración. |
| Operación del servidor | Se documentan aprovisionamiento, límites, staging por ventanas, promoción, rollback y recuperación. |
| Red y acceso | La publicación usa un único origen HTTPS mediante túnel saliente; los servicios internos no se publican directamente. |
| Soporte | Los probes, logs seguros, identidad por digest y runbooks reducen el diagnóstico ad hoc. |
| Producto | No cambia el comportamiento visible ni los contratos multitenant, WhatsApp o IA. |

## Riesgos y mitigaciones requeridas

| Riesgo | Consecuencia | Dirección de tratamiento |
| --- | --- | --- |
| Reconstruir o usar etiquetas mutables por entorno | Producción ejecuta bytes distintos de los probados. | Promoción y verificación obligatorias por digest. |
| Compartir estado o secretos entre entornos | Corrupción, fuga de datos, pérdida de sesiones o contacto con usuarios reales desde staging. | Identidades, roles, volúmenes, números y secretos exclusivos con validaciones fail-fast. |
| Agotamiento de CPU, RAM o I/O | Producción se degrada al ejecutar staging, build, tests o restore. | Medición, cuotas, ventanas y reglas de exclusión; producción conserva prioridad. |
| Migración incompatible | Un rollback de imagen no restaura el esquema anterior. | Preflight, backup, compatibilidad explícita y paso único separado del arranque. |
| Backup incompleto de Baileys | Los datos restauran, pero las sesiones cifradas quedan ilegibles. | Custodia cifrada de KEK históricas y clave QR, más restore drill verificable. |
| Fallo del PC, SSD, Wi-Fi, ISP o energía | Caída de varias horas o pérdida local. | Backup fuera del PC, runbook de retorno y aceptación explícita; sin promesa de HA. |
| Exposición accidental de servicios | Acceso externo a API, PostgreSQL o procesos internos. | Único origen HTTPS, túnel saliente y red privada; sin port forwarding como supuesto. |
| Secretos en imagen, Git o logs | Compromiso de proveedores, base de datos o sesiones. | Inyección externa, ejemplos no utilizables, redacción y pruebas de ausencia de secretos. |
| Dependencias nativas o runtime no reproducibles | La imagen funciona distinto del desarrollo/test. | Build bloqueado y pruebas sobre la imagen real antes de staging. |
| Proveedor externo aún no elegido | La publicación o el backup real no pueden habilitarse. | Mantener interfaces provider-agnostic y bloquear producción hasta resolver sus gates. |

## Dirección de rollback y recuperación

El rollback de aplicación consistirá en detener la release fallida y volver a desplegar un digest anterior conocido, sin reconstruirlo y conservando la configuración y los secretos del entorno. Staging podrá destruirse por completo y recrearse desde su estado aislado.

Los cambios de base de datos tendrán un plan separado. Antes de migrar producción se exigirá backup verificable y una declaración de compatibilidad con el digest anterior; cuando una migración no sea reversible, se preferirá roll-forward o restauración controlada en lugar de fingir que revertir la imagen revierte SQL.

La recuperación ante pérdida de host o datos partirá del backup externo cifrado y deberá restaurar PostgreSQL junto con la custodia de KEK históricas y clave QR. Tras una interrupción se validarán almacenamiento, base, migraciones, readiness y backlog antes de reabrir el ingreso. Ningún rollback mezclará volúmenes, secretos o sesiones entre staging y producción.

Los cambios de aprovisionamiento del host tendrán pasos de comprobación y reversión en el runbook; esta propuesta no prescribe comandos destructivos ni una modificación automática de disco, red o firewall.

## Dirección de aceptación y criterios de éxito

La propuesta se considerará realizada cuando exista evidencia verificable de que:

- [ ] El desarrollo cotidiano conserva el flujo local actual y no requiere conectarse a staging o producción.
- [ ] Test crea dependencias efímeras, usa dobles deterministas y no necesita secretos ni proveedores reales.
- [ ] Las suites existentes permanecen como gates y las comprobaciones de release arrancan la imagen, no servidores de desarrollo.
- [ ] Una release produce un único artefacto identificable por digest para los cuatro procesos.
- [ ] El digest probado es exactamente el desplegado en staging y, tras aprobación, el promocionado a producción.
- [ ] Staging es privado, temporal, limitado y puede eliminarse sin afectar producción.
- [ ] Producción es persistente, tiene prioridad de recursos y puede reiniciar los procesos de forma controlada.
- [ ] Ningún entorno comparte datos, roles PostgreSQL, credenciales, secretos, volúmenes, sesiones/números de WhatsApp, KEK/clave QR o bootstrap de administrador.
- [ ] La configuración inválida o insegura falla antes de servir tráfico y no revela secretos.
- [ ] Solo el ingreso HTTPS previsto queda accesible; API, PostgreSQL, manager y worker no se exponen directamente.
- [ ] Health/readiness, logs seguros, rotación, límites y políticas de reinicio permiten diagnosticar y operar la release.
- [ ] Las migraciones se ejecutan como paso único controlado con preflight, backup y regla de compatibilidad/rollback.
- [ ] Un backup externo diario cifrado y un restore drill recuperan PostgreSQL y demuestran la disponibilidad del material criptográfico histórico requerido.
- [ ] Los gates de túnel/dominio/DNS, destino de backup y aceptación de riesgos Wi-Fi/energía impiden habilitar usuarios reales mientras estén pendientes.
- [ ] Los requisitos actuales de producto y aislamiento multitenant siguen pasando sin cambios funcionales, visuales, de WhatsApp o de IA.

## No objetivos

Quedan fuera de este cambio:

- cambiar comportamiento de producto, interfaz, tenancy, autenticación funcional, flujos de WhatsApp o comportamiento de IA;
- añadir una bandeja de conversaciones, nuevos tipos de mensajes, múltiples conexiones por negocio o nuevas capacidades de V1;
- seleccionar en la propuesta un proveedor de túnel, dominio, DNS, destino de backup o gestor concreto de secretos;
- provisionar el host, instalar Docker, modificar LVM, firewall, SSH, red o energía;
- convertir staging en un entorno permanentemente encendido o permitir que comparta estado con producción;
- ofrecer alta disponibilidad, failover, cero downtime o un SLA ante fallos del PC, ISP, Wi-Fi o energía;
- exponer PostgreSQL o procesos internos a Internet;
- resolver observabilidad externa completa, autoscaling o una plataforma multi-host;
- inferir mercado, modelo comercial o alcance posterior a la V1.

## Decisiones reservadas para diseño o seguimiento

Sin debilitar los requisitos anteriores, las fases posteriores deberán resolver:

- formato de imagen, runtime final de cada proceso, motor de contenedores y supervisor del host;
- proveedor de túnel saliente, dominio/DNS y mecanismo de acceso privado temporal a staging;
- destino, cifrado, retención, RPO/RTO y responsable del backup;
- modelo de inyección y rotación de secretos, incluida la retención de KEK históricas;
- logins PostgreSQL por rol, política concreta de migración y ciclo de la credencial bootstrap;
- cuotas, ventanas, concurrencia y umbrales operativos basados en mediciones del host;
- ampliación/cifrado del almacenamiento, SMART y política de actualizaciones.

Estas decisiones no autorizan a reconstruir por entorno, compartir estado, publicar mediante forwarding entrante ni admitir usuarios reales antes de satisfacer los gates externos.

## Continuidad del SDD

La siguiente fase recomendada es redactar las especificaciones verificables para las capacidades nuevas y la modificación de `persistence-and-operations`. Después, el diseño podrá seleccionar mecanismos concretos y resolver las decisiones técnicas reservadas antes de descomponer la implementación en tareas.

# Home Server Deployment Specification

## Purpose

Operar staging temporal y producción persistente de forma segura en un único host doméstico con recursos restringidos.

## Requirements

### Requirement: Ingreso público mediante túnel saliente

La publicación de producción SHALL usar un mecanismo de túnel saliente compatible con CGNAT o doble NAT y SHALL presentar un único origen HTTPS canónico. PostgreSQL, API, manager y worker MUST NOT exponerse directamente a Internet. Staging MUST permanecer privado y su acceso temporal MUST estar controlado; el port forwarding entrante MUST NOT ser un supuesto de publicación.

#### Scenario: Superficie pública restringida

- GIVEN una producción preparada para recibir tráfico externo
- WHEN se verifica su superficie de red pública
- THEN solo está disponible el origen HTTPS canónico previsto mediante ingreso saliente
- AND los servicios internos no aceptan conexiones directas desde Internet.

### Requirement: Prioridad y exclusiones de capacidad

Producción SHALL tener prioridad de recursos del host. Staging MUST tener cuotas explícitas y solo MAY coexistir cuando la capacidad medida, la ventana operativa y dichos límites lo permitan. Staging MUST NOT ejecutarse durante picos, migraciones sensibles, restauraciones, mantenimiento, backlog relevante ni cargas intensivas de build o test. El swap MUST NOT considerarse capacidad normal para PostgreSQL ni workers.

#### Scenario: Staging bloqueado por operación sensible

- GIVEN una restauración o una migración sensible en producción
- WHEN se solicita activar staging
- THEN la solicitud se rechaza o se difiere
- AND producción conserva su prioridad de recursos.

### Requirement: Operación observable y reiniciable

La producción MUST declarar estados de health y readiness para sus procesos de release, cierre ordenado, políticas de reinicio, límites de recursos y rotación de logs. Los probes y logs MUST permitir diagnóstico sin revelar secretos.

#### Scenario: Reinicio controlado de un proceso

- GIVEN un proceso de producción que debe reiniciarse
- WHEN se aplica su política de reinicio
- THEN el proceso realiza cierre ordenado y vuelve a publicar su estado de readiness
- AND los registros disponibles no exponen secretos.

### Requirement: Gates externos antes de usuarios reales

El sistema MUST bloquear la admisión de usuarios reales hasta que exista evidencia aceptada de: túnel, dominio y DNS operables; destino de backup externo y restauración probada; y aceptación explícita de los riesgos de Wi-Fi como única red y ausencia de UPS. Un placeholder local o un backup en el mismo SSD MUST NOT satisfacer estos gates.

#### Scenario: Gate externo pendiente

- GIVEN que falta la evidencia de restauración externa o la aceptación del riesgo doméstico
- WHEN se intenta habilitar usuarios reales
- THEN la habilitación permanece bloqueada.

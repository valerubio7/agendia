# Propuesta: AgendIA v1 completa

## Resumen ejecutivo

Construir AgendIA como una plataforma SaaS multiempresa que permita a cada negocio operar un asistente de inteligencia artificial configurable conectado a una única cuenta de WhatsApp. La versión propuesta cubre el alcance completo del PRD actualizado: administración de negocios y accesos, configuración desde paneles web, vinculación con WhatsApp mediante Baileys, respuestas con DeepSeek, historial conversacional para contexto, seguridad, aislamiento, auditoría y manejo de fallos.

La propuesta resuelve el problema de negocios que quieren automatizar la atención por WhatsApp sin desarrollar ni mantener infraestructura propia. El resultado esperado es un flujo administrable sin modificar código, seguro entre tenants y operativo las 24 horas cuando el asistente esté activo.

## Intención y problema de negocio

Los negocios reciben consultas repetitivas por WhatsApp, pero crear y operar una automatización contextual exige conocimientos técnicos, integración con proveedores, custodia de credenciales y supervisión continua. Esto eleva el costo de adopción y dificulta ofrecer respuestas consistentes fuera del horario de atención.

AgendIA debe concentrar esas responsabilidades en una plataforma administrada que:

- permita al administrador general dar de alta y supervisar negocios;
- permita al único usuario de cada negocio configurar su información y asistente desde una interfaz web;
- conecte una cuenta de WhatsApp por negocio sin cambios de código;
- responda automáticamente con contexto propio del negocio y del chat;
- mantenga aislamiento, seguridad y trazabilidad desde el backend.

## Resultado deseado

Al finalizar el cambio, el administrador general podrá crear las credenciales del usuario de un negocio, administrar el estado del tenant y supervisar sus estados operativos. El usuario del negocio podrá iniciar sesión, configurar su negocio y asistente, vincular WhatsApp y controlar la automatización. Cuando el negocio y el asistente estén activos y la conexión sea válida, los mensajes de texto recibidos en chats individuales se responderán durante las 24 horas mediante DeepSeek y la misma sesión de WhatsApp.

La experiencia deberá mantener límites claros: cada negocio tendrá un solo usuario y una sola cuenta/sesión de WhatsApp; los clientes finales no usarán AgendIA; y las conversaciones se consultarán únicamente en WhatsApp, no en un visor dentro de la plataforma.

## Alcance funcional

### 1. Plataforma multiempresa

- Una instalación administrará múltiples negocios independientes y cada negocio será un tenant.
- Cada tenant tendrá aislados su información, configuración, cuenta de acceso, sesión de WhatsApp, historial conversacional, estados, registros técnicos y auditoría.
- Ningún usuario de negocio podrá leer o modificar datos de otro tenant, incluso mediante solicitudes manipuladas fuera de la interfaz.
- Las comprobaciones de identidad, rol, tenant y permiso se ejecutarán siempre en el backend.

### 2. Administración general

El administrador general, como actor separado de los usuarios de negocio, podrá:

- iniciar y cerrar sesión en el panel administrativo;
- crear y editar negocios;
- activar, suspender y reactivar negocios;
- crear directamente las credenciales del único usuario asociado a cada negocio y administrar esa cuenta;
- consultar por negocio el nombre, estado, fecha de creación, estado del asistente, estado de WhatsApp y última actividad técnica;
- supervisar el funcionamiento general de la plataforma.

La suspensión bloqueará el acceso del usuario del negocio y toda automatización de respuestas. La información protegida, las credenciales, la sesión y el historial se conservarán para permitir la reactivación posterior.

### 3. Acceso del usuario del negocio

- Existirá exactamente un usuario de negocio por tenant.
- El usuario podrá iniciar y cerrar sesión y operar únicamente dentro de su negocio.
- El panel permitirá consultar y editar la información permitida del negocio, configurar el asistente, vincular WhatsApp, consultar su estado y activar o desactivar la automatización.
- Las contraseñas deberán almacenarse de forma segura y las sesiones deberán gestionarse y protegerse desde el backend.
- El administrador general será quien cree directamente las credenciales iniciales; no habrá invitación ni autoservicio de registro.

### 4. Configuración del negocio

Desde la interfaz web se podrá guardar, al menos:

- nombre comercial y descripción;
- dirección e información de contacto;
- horarios de atención;
- servicios o productos;
- preguntas frecuentes y políticas;
- información adicional relevante.

Los horarios serán información contextual para las respuestas, no una restricción de operación. Un asistente activo podrá responder las 24 horas.

### 5. Configuración y control del asistente

El usuario podrá definir y editar:

- personalidad y tono de comunicación;
- instrucciones generales;
- información que debe conocer;
- reglas de comportamiento y restricciones;
- estado activo o inactivo.

La activación no impondrá una lista obligatoria de completitud de contenidos. Se permitirá activar con cualquier configuración que cumpla el esquema, la validez de datos y las condiciones operativas necesarias. Cuando esté inactivo, no se procesarán ni enviarán respuestas automáticas.

Las respuestas usarán principalmente la información configurada por el negocio, pero podrán complementarla con conocimiento general. No estarán limitadas a plantillas predeterminadas. El refinamiento de límites, precisión y estilo más allá de esta regla pertenece a evoluciones futuras.

### 6. Vinculación y estado de WhatsApp

- Baileys será la integración inicial con WhatsApp.
- El usuario iniciará la vinculación desde su panel y verá el mecanismo necesario para completarla.
- Cada negocio tendrá exactamente una cuenta y una sesión de WhatsApp asociadas.
- La sesión y sus credenciales se almacenarán de forma segura y sobrevivirán las condiciones operativas previstas.
- Se mantendrán el identificador de sesión, negocio asociado, número conectado, fecha de vinculación, última conexión y estado.
- El panel reflejará los estados conectado, desconectado, requiere vinculación y error de conexión.

### 7. Recepción, contexto y respuesta

Para cada evento entrante admisible, AgendIA deberá:

1. identificar la sesión de WhatsApp y el negocio antes de acceder a su información;
2. confirmar que el negocio no esté suspendido y que el asistente esté activo;
3. aceptar únicamente mensajes de texto en chats individuales;
4. ignorar mensajes de grupos, mensajes enviados por el propio número y contenido multimedia;
5. recuperar la configuración del negocio y del asistente;
6. recuperar el historial completo del chat de ese cliente final como contexto conversacional;
7. solicitar a DeepSeek una respuesta desde el backend;
8. enviar la respuesta por la misma conexión de WhatsApp;
9. actualizar la actividad técnica y registrar los fallos relevantes.

El historial será independiente por chat de cliente final, permanecerá aislado por tenant y se conservará mientras exista el negocio. AgendIA no ofrecerá bandeja, búsqueda ni visor de conversaciones; la consulta humana seguirá realizándose en WhatsApp.

Si DeepSeek falla o no está disponible, el cliente final no recibirá una respuesta y el fallo técnico quedará registrado. Los errores de conexión o envío también deberán registrarse y reflejar el estado operativo que corresponda, sin exponer secretos.

### 8. Inteligencia artificial

- DeepSeek será el proveedor inicial para interpretar mensajes y generar respuestas.
- La integración se realizará exclusivamente desde el backend; sus credenciales nunca se expondrán al navegador.
- La configuración del tenant y el historial del chat formarán el contexto autorizado.
- Secretos operativos y datos de otros tenants no podrán formar parte del contexto.
- La comunicación con DeepSeek deberá permanecer detrás de un límite reemplazable para facilitar mantenimiento y futuros cambios de proveedor.

### 9. Seguridad, validación y auditoría

La solución deberá contemplar:

- autenticación, cierre de sesión, roles, permisos y asociación inequívoca entre usuario y negocio;
- validación de datos y autorización en endpoints privados;
- protección de contraseñas, sesiones de usuario, credenciales de DeepSeek y material de sesión de Baileys;
- aislamiento de información, historial y registros por tenant;
- tratamiento seguro de negocios o sesiones inexistentes, usuarios sin permiso y negocios suspendidos;
- registro de errores relevantes sin filtrar secretos ni datos de otros negocios.

La auditoría registrará como mínimo:

- accesos a la plataforma;
- cambios de configuración del negocio o del asistente;
- vinculación y cambios relevantes de la conexión de WhatsApp;
- activación y desactivación del asistente;
- suspensión y reactivación de negocios;
- fallos técnicos relevantes, incluidos los de DeepSeek, WhatsApp y envío de respuestas.

El formato, granularidad, acceso técnico y almacenamiento concreto de estos registros se decidirán en diseño sin reducir esta cobertura.

### 10. Persistencia y observabilidad operativa

- PostgreSQL será la base de datos principal.
- Se persistirán cuentas, relaciones con negocios, configuraciones, estados, metadatos de conexión, historial conversacional, actividad técnica y auditoría según corresponda.
- El administrador dispondrá de los estados y de la última actividad técnica necesarios para supervisar cada negocio.
- La solución deberá representar y tratar, como mínimo, desconexiones de WhatsApp, necesidad de nueva vinculación, errores de conexión, indisponibilidad de DeepSeek, fallos de envío, datos inválidos, falta de permisos y negocios inexistentes o suspendidos.

## Actores y reglas de acceso

| Actor | Capacidades | Límites |
|---|---|---|
| Administrador general | Gestiona negocios y sus cuentas; suspende, reactiva y supervisa estados globales. | Es una identidad de plataforma separada y sus operaciones críticas quedan auditadas. |
| Usuario del negocio | Configura su negocio y asistente, vincula WhatsApp y controla la automatización. | Pertenece a un solo tenant y no puede acceder a otro. |
| Cliente final | Envía mensajes al WhatsApp del negocio y recibe respuestas automáticas. | No tiene cuenta ni acceso a AgendIA; solo se procesan sus textos en chats individuales. |
| WhatsApp/Baileys | Entrega eventos y transporta respuestas de la sesión vinculada. | Cada sesión se valida y asocia a un único negocio antes del procesamiento. |
| DeepSeek | Genera respuestas a partir del contexto autorizado. | Solo se invoca desde backend y no recibe secretos ni datos de otros tenants. |

## Reglas de producto confirmadas

1. La cardinalidad es un negocio, un usuario de negocio y una cuenta/sesión de WhatsApp; el administrador general es independiente.
2. El administrador crea directamente las credenciales del usuario del negocio.
3. Suspender un negocio bloquea el acceso del usuario y la automatización, pero conserva datos protegidos, credenciales, sesión e historial para reactivación.
4. La activación admite cualquier configuración válida y no exige una lista adicional de campos completos.
5. Solo se procesan textos de chats individuales; grupos, mensajes propios y multimedia se ignoran.
6. El historial completo de cada chat se utiliza como contexto y se conserva mientras exista el negocio.
7. Un asistente activo responde las 24 horas; los horarios configurados son informativos.
8. Las respuestas se basan principalmente en datos del negocio, pueden usar información general y no se restringen a plantillas.
9. Ante un fallo de DeepSeek no se envía respuesta al cliente y se registra el fallo técnico.
10. AgendIA no incluye un visor de conversaciones; estas se consultan directamente en WhatsApp.

## Áreas afectadas e impacto

| Área | Impacto previsto |
|---|---|
| Operación de plataforma | Alta de negocios y credenciales, suspensión/reactivación y supervisión de estados y fallos. |
| Experiencia del negocio | Autogestión web de información, asistente, conexión y activación sin modificar código. |
| Atención al cliente final | Respuestas automáticas 24/7 para textos individuales, con silencios explícitos ante casos ignorados o fallo de IA. |
| Seguridad | Controles de backend, custodia de secretos y aislamiento integral entre tenants. |
| Datos | Persistencia de configuración, estados, auditoría e historial completo por chat durante la vida del negocio. |
| Integraciones | Operación y recuperación de Baileys y DeepSeek detrás de límites desacoplados. |
| Soporte | Diagnóstico basado en estados, última actividad, auditoría y fallos técnicos relevantes. |

## Restricciones y decisiones reservadas para diseño

Esta propuesta fija los resultados de producto, pero no selecciona todavía:

- el stack de frontend, backend o procesos auxiliares;
- el mecanismo concreto de aislamiento entre tenants;
- el mecanismo concreto de autenticación y gestión de sesiones;
- los límites de ejecución, despliegue, escalado o comunicación entre componentes;
- el modelo de datos detallado, esquema de historial, migraciones o almacenamiento de secretos;
- la estrategia de recuperación, reintentos, idempotencia y reconexión;
- las herramientas, niveles y comandos de prueba.

El diseño posterior deberá resolver estas decisiones preservando PostgreSQL como base principal, Baileys y DeepSeek como integraciones iniciales, y límites reemplazables para ambos proveedores.

## Riesgos y mitigaciones esperadas

| Riesgo | Consecuencia | Tratamiento requerido en diseño |
|---|---|---|
| Fuga o cruce de datos entre tenants | Exposición de configuración, historial, sesiones o auditoría. | Definir aislamiento verificable y autorización obligatoria en cada acceso de backend. |
| Pérdida o exposición de credenciales y sesiones | Acceso indebido a cuentas o interrupción de WhatsApp. | Definir custodia, cifrado, acceso mínimo, rotación y recuperación sin registrar secretos. |
| Inestabilidad o cambios de Baileys/WhatsApp | Desconexiones, necesidad de revinculación o respuestas fallidas. | Diseñar estados observables, recuperación y límites de integración sustituibles. |
| Indisponibilidad o latencia de DeepSeek | Clientes sin respuesta y degradación 24/7. | Aplicar la regla de no respuesta, registrar el fallo y definir tiempos de espera y operación segura. |
| Crecimiento ilimitado del historial completo | Mayor costo, latencia y volumen de almacenamiento/contexto. | Diseñar una estrategia que conserve y use el historial completo sin cambiar silenciosamente la regla de producto. |
| Uso de conocimiento general | Respuestas incorrectas o inconsistentes con el negocio. | Mantener prioridad de información del negocio y reservar controles adicionales para refinamiento aprobado. |
| Eventos duplicados, tardíos o propios | Bucles o respuestas repetidas. | Definir procesamiento seguro e idempotente respetando los tipos de evento admitidos. |
| Auditoría insuficiente o excesivamente sensible | Diagnóstico incompleto o filtración de información. | Definir eventos, acceso y contenido mínimo sin almacenar secretos innecesarios. |

No se han especificado requisitos legales, de consentimiento, residencia de datos o eliminación adicionales al PRD actualizado y al ciclo de conservación aprobado. Cualquier requisito nuevo de ese tipo deberá evaluarse como cambio explícito de alcance.

## Estrategia de reversión

Durante la operación, el administrador podrá contener una incidencia desactivando el asistente de un negocio o suspendiendo el tenant. Ambas acciones detendrán la automatización; la suspensión también bloqueará el acceso del usuario. Ninguna medida de contención eliminará credenciales, sesiones, configuración ni historial protegidos necesarios para reactivar el servicio.

La estrategia técnica de reversión de despliegues y cambios de persistencia se definirá en diseño. Deberá permitir volver a una versión estable sin mezclar tenants, perder datos protegidos ni reactivar automatizaciones suspendidas de forma accidental.

## Criterios de éxito

La propuesta se considerará cumplida cuando pueda verificarse que:

- [ ] El administrador general inicia y cierra sesión y puede crear, editar, suspender y reactivar negocios.
- [ ] El administrador crea directamente las credenciales del único usuario de cada negocio y puede administrar esa cuenta.
- [ ] El panel administrativo muestra nombre, estado, fecha de creación, asistente, WhatsApp y última actividad técnica por negocio.
- [ ] El usuario del negocio inicia y cierra sesión y solo puede acceder a su tenant.
- [ ] La autorización y el aislamiento se validan desde el backend para datos, historial, sesiones y registros.
- [ ] El negocio configura desde la web su información comercial y el comportamiento del asistente sin modificar código.
- [ ] Una configuración válida puede activarse sin una lista de completitud adicional y el estado se refleja correctamente.
- [ ] El negocio vincula una única cuenta de WhatsApp mediante Baileys y consulta su estado y metadatos requeridos.
- [ ] Los secretos de autenticación, DeepSeek y Baileys permanecen protegidos y fuera del navegador y de registros inseguros.
- [ ] Cada texto de chat individual se atribuye al negocio correcto antes de construir contexto o responder.
- [ ] Grupos, mensajes propios y multimedia se ignoran sin activar la automatización.
- [ ] DeepSeek recibe contexto autorizado del negocio y el historial completo del chat, sin datos de otros tenants.
- [ ] Un asistente activo puede responder las 24 horas y uno inactivo o perteneciente a un negocio suspendido no responde.
- [ ] Las respuestas se envían por la misma conexión de WhatsApp y pueden complementar la información del negocio con conocimiento general.
- [ ] Un fallo de DeepSeek produce silencio para el cliente y un registro técnico útil; también se registran fallos relevantes de conexión y envío.
- [ ] Suspender bloquea acceso y automatización, y reactivar recupera la operación con los datos, credenciales e historial preservados.
- [ ] Los accesos y demás eventos críticos definidos quedan auditados y aislados por tenant.
- [ ] El historial se conserva por chat mientras exista el negocio, pero no existe bandeja ni visor de conversaciones en AgendIA.
- [ ] PostgreSQL funciona como base de datos principal y Baileys y DeepSeek permanecen desacoplados de la lógica central.

## No objetivos explícitos

Quedan fuera de este cambio:

- recuperación o restablecimiento de contraseña;
- autoservicio de registro, invitaciones o creación de cuentas por el usuario del negocio;
- múltiples usuarios, roles internos o múltiples cuentas/sesiones de WhatsApp para un mismo negocio;
- procesamiento de grupos, mensajes propios, audio, imágenes, video, documentos u otro contenido multimedia;
- bandeja de entrada, visor, búsqueda o gestión de conversaciones desde AgendIA;
- limitar todas las respuestas a plantillas predeterminadas o exclusivamente a contenido configurado;
- refinamientos adicionales de precisión, estilo, moderación o uso de conocimiento general;
- integraciones distintas de Baileys y DeepSeek en la versión inicial;
- requisitos legales, de consentimiento, residencia o eliminación no incluidos en el PRD actualizado;
- fijar en esta fase el stack, tenancy, autenticación, topología de ejecución/despliegue, modelo detallado de datos o herramientas de pruebas.

## Continuidad del SDD

La siguiente fase recomendada es redactar la especificación verificable del alcance completo. Después, el diseño deberá resolver las decisiones arquitectónicas reservadas antes de descomponer la implementación en tareas.

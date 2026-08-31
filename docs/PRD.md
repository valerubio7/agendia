# agendIA

**Tu asistente inteligente para WhatsApp.**

## 1. Descripción general

**agendIA** es una plataforma SaaS multiempresa que permite a distintos negocios conectar una cuenta de WhatsApp con un asistente de inteligencia artificial configurable.

Cada negocio podrá:

- Configar la información de su negocio.
- Definir el comportamiento de su asistente.
- Conectar su cuenta de WhatsApp.
- Activar o desactivar las respuestas automáticas.

La comunicación con WhatsApp se realizará inicialmente mediante **Baileys** y la generación de respuestas mediante **DeepSeek**.

El flujo principal será:

**Cliente → WhatsApp → Baileys → agendIA → DeepSeek → agendIA → Baileys → WhatsApp**

agendIA administrará los negocios, sus configuraciones, las conexiones de WhatsApp y la comunicación con el modelo de inteligencia artificial.

---

## 2. Objetivo del producto

El objetivo de agendIA es permitir que un negocio configure y utilice un asistente de inteligencia artificial en WhatsApp sin tener que desarrollar ni mantener su propia infraestructura tecnológica.

El negocio deberá poder:

- Acceder a su cuenta de agendIA.
- Configurar la información de su negocio.
- Configurar el comportamiento de su asistente.
- Conectar su cuenta de WhatsApp.
- Activar o desactivar el asistente.
- Automatizar las respuestas a los mensajes que reciba en WhatsApp.

La configuración y administración deberán realizarse desde una interfaz web, sin necesidad de modificar código.

---

## 3. Concepto central

agendIA es una:

**Plataforma SaaS multiempresa de asistentes de inteligencia artificial conectados a WhatsApp.**

Cada negocio tendrá un entorno independiente dentro de la plataforma, con:

- Información del negocio.
- Configuración del asistente.
- Conexión de WhatsApp.
- Estado del asistente.

agendIA utilizará la información configurada por cada negocio para generar respuestas personalizadas mediante inteligencia artificial.

---

## 4. Arquitectura multi-tenant

agendIA deberá diseñarse como una plataforma **multi-tenant desde el inicio**.

Una misma instalación administrará múltiples negocios independientes. Cada negocio representará un tenant.

Los datos de cada negocio deberán permanecer aislados. Esto incluye:

- Información del negocio.
- Configuración del asistente.
- Sesiones de WhatsApp.
- Usuarios con acceso al panel.
- Registros técnicos y de auditoría.

Un negocio nunca deberá poder acceder ni modificar información perteneciente a otro.

---

## 5. Tipos de usuarios

### 5.1 Administrador general

El administrador general será el propietario de la plataforma.

Podrá:

- Iniciar sesión en el panel administrativo.
- Crear y editar negocios.
- Activar o suspender negocios.
- Crear o administrar las cuentas de acceso de cada negocio.
- Consultar el estado de WhatsApp de cada negocio.
- Consultar si el asistente está activo.
- Supervisar el funcionamiento general de la plataforma.

### 5.2 Usuario del negocio

El usuario del negocio podrá acceder únicamente al entorno de su empresa.

Podrá:

- Consultar y editar la información permitida de su negocio.
- Configurar el asistente.
- Conectar WhatsApp.
- Consultar el estado de la conexión.
- Activar o desactivar el asistente.

No podrá consultar ni modificar información de otros negocios.

### 5.3 Cliente final

El cliente final se comunicará con el negocio mediante WhatsApp.

No necesitará:

- Crear una cuenta en agendIA.
- Registrarse en la plataforma.
- Instalar otra aplicación.

---

## 6. Autenticación y permisos

agendIA contará con un sistema de autenticación para proteger el acceso a los paneles.

Deberá contemplar:

- Inicio y cierre de sesión.
- Contraseñas almacenadas de forma segura.
- Gestión de sesiones.
- Roles y permisos.
- Asociación entre cada usuario y su negocio.

El backend deberá validar siempre:

- Que el usuario esté autenticado.
- Su rol.
- El negocio al que pertenece.
- Los permisos sobre la operación solicitada.

La seguridad no deberá depender únicamente de la interfaz web.

---

## 7. Panel del administrador

El panel del administrador deberá permitir gestionar los negocios registrados.

Como mínimo deberá mostrar:

- Nombre del negocio.
- Estado del negocio.
- Estado del asistente.
- Estado de WhatsApp.
- Fecha de creación.
- Última actividad técnica.

Desde este panel se podrá crear un nuevo negocio y configurar la información necesaria para habilitar su acceso.

---

## 8. Panel del negocio

El panel del negocio estará enfocado en configurar y administrar el asistente.

Deberá permitir:

### Estado del asistente

- Activo.
- Inactivo.

### Estado de WhatsApp

- Conectado.
- Desconectado.
- Requiere vinculación.
- Error de conexión.

### Configuración

- Información del negocio.
- Personalidad y tono.
- Instrucciones.
- Información que el asistente debe utilizar.

---

## 9. Configuración del negocio

Cada negocio podrá configurar información para contextualizar las respuestas del asistente.

Por ejemplo:

- Nombre comercial.
- Descripción.
- Dirección.
- Información de contacto.
- Horarios de atención.
- Servicios o productos.
- Preguntas frecuentes.
- Políticas.
- Información adicional.

Esta información deberá estar asociada al negocio correspondiente y no podrá mezclarse con la de otros tenants.

---

## 10. Configuración del asistente

Cada negocio podrá definir el comportamiento de su asistente.

La configuración podrá incluir:

- Personalidad.
- Tono de comunicación.
- Instrucciones generales.
- Información que debe conocer.
- Reglas de comportamiento.
- Restricciones.
- Estado activo o inactivo.

Ejemplo:

**Instrucciones:**

> Sos la asistente virtual de Estética Bella. Respondé de manera amable y breve. Utilizá únicamente la información proporcionada por el negocio. Si no conocés una respuesta, indicá que un miembro del equipo podrá continuar la conversación.

Esta configuración se enviará a DeepSeek como parte del contexto necesario para generar cada respuesta.

---

## 11. Integración con WhatsApp

agendIA utilizará inicialmente **Baileys** para conectar la cuenta de WhatsApp de cada negocio.

El proceso será:

1. El usuario ingresa al panel.
2. Selecciona la opción para conectar WhatsApp.
3. agendIA inicia una sesión de Baileys.
4. Se muestra el mecanismo de vinculación correspondiente.
5. El usuario vincula su cuenta.
6. agendIA almacena la sesión de forma segura.
7. La conexión queda asociada al negocio.

El sistema deberá mantener como mínimo:

- Negocio asociado.
- Identificador de sesión.
- Estado de conexión.
- Número conectado.
- Fecha de vinculación.
- Última conexión.

Las credenciales y archivos de sesión deberán almacenarse de forma segura.

---

## 12. Identificación del negocio

Cuando Baileys reciba un mensaje, agendIA deberá identificar mediante qué conexión de WhatsApp fue recibido.

La relación será:

**Sesión de WhatsApp → Negocio**

A partir de esa relación, agendIA podrá recuperar:

- La información del negocio.
- La configuración del asistente.
- Las instrucciones correspondientes.

Esta identificación deberá realizarse antes de solicitar una respuesta a DeepSeek.

---

## 13. Inteligencia artificial

agendIA utilizará inicialmente **DeepSeek** como proveedor de inteligencia artificial.

DeepSeek será utilizado para:

- Interpretar los mensajes recibidos.
- Utilizar la información configurada por el negocio.
- Generar respuestas.
- Mantener el contexto necesario de la interacción.

La integración se realizará exclusivamente desde el backend. Las credenciales de DeepSeek nunca deberán exponerse al navegador.

La comunicación con el proveedor deberá centralizarse en una capa independiente para facilitar el mantenimiento y futuros cambios de proveedor.

---

## 14. Flujo principal

El flujo principal será:

1. Un cliente envía un mensaje por WhatsApp.
2. Baileys recibe el mensaje.
3. agendIA identifica la conexión y el negocio correspondiente.
4. agendIA recupera la información y configuración del asistente.
5. agendIA construye el contexto necesario.
6. DeepSeek genera una respuesta.
7. Baileys envía la respuesta por WhatsApp.

---

## 15. Control del asistente

Cada negocio podrá activar o desactivar su asistente.

### Asistente activo

agendIA procesará los mensajes recibidos y enviará respuestas automáticas.

### Asistente inactivo

agendIA no enviará respuestas automáticas.

El estado deberá almacenarse por negocio y reflejarse en el panel.

---

## 16. Base de datos

La base de datos principal será **PostgreSQL**.

---

## 17. Seguridad y manejo de errores

agendIA deberá garantizar:

- Aislamiento entre negocios.
- Contraseñas y sesiones protegidas.
- Validación de permisos en el backend.
- Protección de las credenciales de DeepSeek.
- Protección de las sesiones de Baileys.
- Validación de los datos recibidos.
- Protección de endpoints privados.
- Registro de errores relevantes.

También deberá contemplar errores como:

- WhatsApp desconectado.
- DeepSeek no disponible.
- Fallos durante el envío de respuestas.
- Usuario sin permisos.
- Negocio inexistente o suspendido.

---

## 18. Alcance de la primera versión

La primera versión deberá permitir completar este flujo:

1. El administrador inicia sesión.
2. Crea un negocio.
3. Crea o asocia una cuenta de acceso.
4. El usuario del negocio inicia sesión.
5. Configura la información del negocio.
6. Configura el asistente.
7. Conecta WhatsApp.
8. Activa el asistente.
9. Un cliente envía un mensaje.
10. Baileys recibe el mensaje.
11. agendIA identifica el negocio.
12. DeepSeek genera una respuesta utilizando la configuración correspondiente.
13. agendIA envía la respuesta por WhatsApp.

La consulta de conversaciones se realizará directamente desde WhatsApp.

---

## 19. Criterios mínimos de aceptación

La primera versión se considerará funcional cuando:

- El administrador pueda autenticarse.
- El administrador pueda crear y administrar negocios.
- Un usuario de negocio pueda autenticarse.
- Cada usuario pueda acceder únicamente a su negocio.
- El negocio pueda configurar su información.
- El negocio pueda configurar su asistente.
- El negocio pueda conectar WhatsApp.
- El estado de WhatsApp pueda visualizarse.
- Baileys pueda recibir mensajes.
- Cada mensaje pueda asociarse al negocio correcto.
- DeepSeek pueda generar respuestas utilizando la configuración del negocio.
- Las respuestas puedan enviarse por WhatsApp.
- El asistente pueda activarse y desactivarse.
- Los datos de diferentes negocios permanezcan aislados.
- No sea necesario consultar conversaciones desde el panel de agendIA.

---

## 20. Principios de diseño

### Multi-tenant desde el inicio

Todos los negocios utilizarán la misma plataforma, pero sus datos y configuraciones permanecerán aislados.

### Simplicidad

La primera versión deberá concentrarse en conectar WhatsApp con un asistente configurable.

### Configuración mediante interfaz

La administración de negocios y asistentes deberá realizarse desde el panel, sin modificar código.

### IA como componente controlado

DeepSeek generará respuestas, pero agendIA controlará la configuración, el contexto, la seguridad y el envío mediante WhatsApp.

### Integraciones desacopladas

La conexión con WhatsApp y la comunicación con DeepSeek deberán mantenerse separadas de la lógica principal.

### Seguridad por backend

La autenticación, los permisos y el aislamiento entre negocios deberán validarse siempre desde el servidor.

---

# agendIA

**Tu asistente inteligente para WhatsApp.**

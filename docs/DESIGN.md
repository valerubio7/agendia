---
name: agendIA
description: Sistema visual operativo para configurar asistentes y vincular WhatsApp con claridad humana.
colors:
  ink: "#172620"
  ink-secondary: "#213b31"
  paper: "#f1eee3"
  surface: "#faf8f1"
  surface-secondary: "#f7f3e8"
  coral: "#ff6b49"
  coral-hover: "#ff8064"
  coral-soft: "#ffe1d8"
  pine: "#2f6e52"
  pine-soft: "#ddebdf"
  sand: "#d9d2be"
  mid: "#7d887f"
  danger: "#c24b3a"
  danger-soft: "#f6e2de"
  white: "#ffffff"
  assistant-ink: "#18231f"
  assistant-night: "#111c19"
  assistant-violet: "#37314d"
  assistant-lilac: "#bcb4df"
  whatsapp-night: "#0b2725"
  whatsapp-deep: "#123c37"
  whatsapp-green: "#25d366"
  whatsapp-mint: "#bcebd2"
  whatsapp-aqua: "#78d5d0"
  admin-navy: "#15263a"
  admin-blue: "#315d78"
  admin-muted: "#627079"
  warning: "#a66b19"
  warning-soft: "#f5e8cc"
typography:
  hero:
    fontFamily: "Space Grotesk, Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "5.25rem"
    fontWeight: 640
    lineHeight: 0.94
    letterSpacing: "-0.067em"
  page-title:
    fontFamily: "Space Grotesk, Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "3rem"
    letterSpacing: "-0.045em"
  brand-word:
    fontFamily: "Space Grotesk, Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 600
    letterSpacing: "-0.045em"
  section-title:
    fontFamily: "Space Grotesk, Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.68
  label:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  metadata:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.65rem"
    fontWeight: 750
    lineHeight: 1.5
    letterSpacing: "0.07em"
  status:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.65rem"
    fontWeight: 850
    lineHeight: 1.2
    letterSpacing: "0.04em"
rounded:
  compact: "0.68rem"
  control: "0.75rem"
  whatsapp-action: "0.8rem"
  notice: "0.85rem"
  panel: "1.25rem"
  hero: "1.75rem"
  pill: "2rem"
spacing:
  field-gap: "0.45rem"
  control-y: "0.75rem"
  content: "1rem"
  panel: "1.25rem"
  section: "2rem"
  spacious: "2.5rem"
components:
  brand-lockup:
    textColor: "{colors.ink}"
    typography: "{typography.brand-word}"
    height: "2.75rem"
  button-primary:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.75rem 1rem"
    height: "3rem"
  button-primary-hover:
    backgroundColor: "{colors.coral-hover}"
  button-operational:
    backgroundColor: "{colors.pine}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1rem"
    height: "2.9rem"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.8rem 0.9rem"
    height: "3.25rem"
  navigation-item:
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0.7rem 0.85rem"
    height: "2.9rem"
  navigation-item-active:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.ink}"
  notice-success:
    backgroundColor: "{colors.pine-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.notice}"
    padding: "1rem 1.15rem"
  notice-error:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.notice}"
    padding: "1rem 1.15rem"
  status-badge:
    typography: "{typography.status}"
    rounded: "{rounded.pill}"
    padding: "0.42rem 0.65rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  whatsapp-action:
    backgroundColor: "{colors.whatsapp-deep}"
    textColor: "{colors.white}"
    rounded: "{rounded.whatsapp-action}"
    padding: "0.85rem 1rem"
    height: "3.35rem"
---

# Sistema de diseño de agendIA

## Overview

**Norte creativo: “La Sala de Control Humana”**

La Sala de Control Humana traduce una operación técnica y multitenant en una interfaz cálida, comprensible y deliberadamente serena. El papel crema, la tinta vegetal y el pino construyen una base editorial; el coral señala marca, selección y acción sin convertir cada pantalla en una alarma.

La interfaz se siente operativa, no corporativa ni futurista: títulos compactos, etiquetas monoespaciadas, paneles amplios y estados escritos con lenguaje directo. La profundidad es suave y funcional; los detalles gráficos —órbitas, mapas, puentes y líneas— explican relaciones sin competir con formularios, inventarios o decisiones críticas.

Cada área conserva una identidad reconocible dentro del mismo producto. Asistente, WhatsApp y administración reciben acentos propios y acotados, mientras el armazón, la tipografía, el foco, los mensajes y la jerarquía mantienen continuidad.

**Características clave:**

- Base editorial cálida de papel, tinta, pino y coral.
- Jerarquía de sala de control: contexto visible, tarea principal clara y estado siempre legible.
- Acentos por ámbito que distinguen funciones sin fragmentar la marca.
- Formularios explícitos, información persistente y retroalimentación accesible.
- Adaptación móvil que conserva rutas, acciones y significado.

## Colors

La paleta principal combina neutrales cálidos con contraste vegetal y un coral enérgico; los colores de ámbito aportan orientación local, no una segunda marca.

### Identidad principal

- **Tinta vegetal** (`{colors.ink}`): texto principal, fondos profundos y contraste de marca.
- **Tinta secundaria** (`{colors.ink-secondary}`): variación de fondos oscuros en acceso y navegación.
- **Papel cálido** (`{colors.paper}`): lienzo de marca y texto sobre superficies oscuras.
- **Superficie marfil** (`{colors.surface}`): tarjetas, formularios y contenido elevado.
- **Superficie secundaria** (`{colors.surface-secondary}`): fondo silencioso del espacio de trabajo.
- **Coral de acción** (`{colors.coral}`): “IA” en la marca, navegación activa, acciones prioritarias y puntos de énfasis.
- **Pino operativo** (`{colors.pine}`): controles de operación, foco y estados positivos.

### Neutrales y semánticos

- **Arena estructural** (`{colors.sand}`): bordes y divisores de bajo contraste.
- **Texto medio** (`{colors.mid}`): apoyo, metadatos y contexto secundario.
- **Peligro controlado** (`{colors.danger}`) y **fondo de peligro** (`{colors.danger-soft}`): errores y acciones de suspensión; el coral no sustituye este significado.
- **Atención** (`{colors.warning}`) y **fondo de atención** (`{colors.warning-soft}`): vinculación requerida.
- **Blanco de campo** (`{colors.white}`): campos y detalles de máximo contraste.

### Acentos de ámbito

- **Asistente:** noche, violeta y lila (`{colors.assistant-night}`, `{colors.assistant-violet}`, `{colors.assistant-lilac}`) convierten la configuración de voz en un estudio de dirección. El violeta conduce foco, límites y recuperación de conflictos solo dentro de esta pantalla.
- **WhatsApp:** noche, verde, menta y aqua (`{colors.whatsapp-night}`, `{colors.whatsapp-green}`, `{colors.whatsapp-mint}`, `{colors.whatsapp-aqua}`) describen el puente y la disponibilidad del canal. El verde de WhatsApp no reemplaza al pino semántico global.
- **Administración:** azul marino y azul (`{colors.admin-navy}`, `{colors.admin-blue}`) separan el registro de plataforma del espacio de negocio. El azul se reserva para campos, tablas y gestión administrativa.

**Regla de los acentos con jurisdicción.** El coral pertenece a la identidad común; violeta, verde/aqua de WhatsApp y azul administrativo solo actúan dentro de su ámbito y nunca son intercambiables como acentos globales.

**Regla de estado pronunciable.** Todo estado combina texto explícito con forma, indicador o estructura; el color nunca carga el significado por sí solo.

## Typography

**Tipografía de exhibición:** Space Grotesk, con Inter como respaldo.

**Tipografía de cuerpo:** Inter, con la pila de sistema implementada.

**Tipografía técnica:** JetBrains Mono, con respaldos monoespaciados.

El contraste tipográfico separa tres voces: Space Grotesk aporta títulos compactos y humanos; Inter sostiene formularios y explicación; JetBrains Mono identifica etapas, fechas, índices y cejas operativas sin invadir párrafos.

### Jerarquía

- **Hero** (`{typography.hero}`): una única declaración principal por pantalla, breve y balanceada.
- **Título de página** (`{typography.page-title}`): estados terminales y jerarquía general del armazón.
- **Título de sección** (`{typography.section-title}`): agrupa tareas y paneles sin competir con el hero.
- **Cuerpo** (`{typography.body}`): introducciones y explicaciones; las ayudas de campo se limitan a unas 65 letras por línea cuando el código lo establece.
- **Etiqueta** (`{typography.label}`): nombre claro del control, siempre visible.
- **Metadato** (`{typography.metadata}`): mayúsculas, índices, fechas y estados compactos; no se usa para lectura prolongada.

**Regla de las tres voces.** Space Grotesk presenta, Inter permite operar y JetBrains Mono orienta; mezclar sus funciones debilita la jerarquía.

## Layout

El acceso prioriza el formulario en el orden del documento y usa una composición de una columna hasta `64rem`; en escritorio, el relato oscuro ocupa la izquierda y el formulario queda centrado a la derecha. Por debajo de `30rem`, la tarjeta reduce relleno y radio sin perder el control mínimo de `3rem`.

El armazón autenticado usa una barra lateral fija de `17rem`, reducida a `14rem` en el tramo compacto. A `47.5rem` o menos, la barra lateral desaparece y se reemplaza por una cabecera con marca, sección actual y un menú nativo desplegable que conserva navegación y cierre de sesión. El contenido central se limita a `82rem`; no se elimina información para hacerlo caber.

Las pantallas de perfil y asistente abren columnas de campos a partir de `48rem` y agregan un riel de guía y guardado a partir de `70rem`. WhatsApp divide resumen y vinculación a partir de `62rem`. Administración compacta el formulario de alta por debajo de `68rem` y, en móvil, transforma cada fila de tabla en una tarjeta etiquetada en lugar de ocultar columnas o acciones.

Los espacios recurrentes del frontmatter gobiernan la densidad de controles y paneles. Los grupos relacionados permanecen próximos; cada cambio de intención recibe separación visible, borde o fondo tonal.

**Regla de la tarea primero.** En flujo estrecho, formulario, estado o acción principal aparecen antes que relato auxiliar, mapas y guías; la adaptación nunca bloquea la operación.

**Regla de navegación por rol.** El negocio solo muestra Perfil, Asistente y WhatsApp; administración solo muestra Negocios. No se sugieren paneles de inicio, detalles administrativos ni bandejas de conversaciones inexistentes.

## Elevation & Depth

El sistema mezcla capas tonales, bordes finos y sombras ambientales. Las superficies permanecen mayormente planas; las sombras más profundas se reservan para tarjetas de acceso y estados terminales (`0 1.25rem 3.5rem rgba(23, 38, 32, 0.09)`), menús flotantes (`0 1rem 2.5rem rgba(23, 38, 32, 0.18)`) y heroes de perfil, asistente, WhatsApp o administración. Los paneles translúcidos dentro de heroes usan una línea interior clara y desenfoque de fondo, no brillo decorativo.

### Vocabulario de sombras

- **Tarjeta elevada:** sombra ambiental suave para acceso y recuperación terminal.
- **Hero editorial:** profundidad amplia y de bajo contraste, teñida por el ámbito.
- **Superposición temporal:** sombra más marcada para el menú móvil.
- **Control elevado:** sombra corta que desaparece al deshabilitarse.
- **Campo interior:** una línea interior mínima que separa el blanco del fondo cálido.

**Regla de elevación con motivo.** Una sombra debe explicar jerarquía, flotación temporal o capacidad de acción; no se agrega para decorar superficies ordinarias.

## Shapes

La forma común es suavemente redondeada: campos y botones usan `{rounded.control}`, avisos `{rounded.notice}` y tarjetas `{rounded.panel}`. Los heroes amplían el radio de manera fluida con `{rounded.hero}`; badges e indicadores usan cápsulas o círculos completos.

La geometría cambia con intención. Perfil combina círculos numerados y una esquina operativa recortada; Asistente alterna borde coral, esquina asimétrica, panel cuadrado de límites y marcadores de señal; WhatsApp usa nodos con silueta de burbuja y una zona QR claramente delimitada; Administración mantiene tarjetas y controles compactos de registro. Los bordes suelen ser de un píxel, con arena o una transparencia del color de ámbito.

**Regla de esquinas con intención.** La redondez comunica contención y cercanía; una esquina recta, un borde discontinuo o una rotación solo aparecen para expresar límite, proceso o cambio de categoría.

## Components

### Marca

La marca combina el nombre **agendIA** en Space Grotesk —con “IA” coral— y un SVG en línea de calendario con verificación. El símbolo usa un rectángulo redondeado de calendario, cuadrícula, bloque coral superior y un check coral con contorno de papel; su `viewBox` es `0 0 100 100`. `apps/web/src/ui/brand.tsx` sigue siendo el activo y la fuente de ejecución: este documento y el sidecar solo registran su uso, no lo reemplazan.

### Botones

- **Primario de marca:** fondo coral, tinta y peso alto; sube un píxel al pasar el puntero y muestra anillo de pino o papel según el fondo.
- **Operativo:** pino sobre blanco para acciones comunes dentro del armazón.
- **De ámbito:** WhatsApp usa verde profundo y Administración usa azul marino/azul únicamente en sus propias tareas.
- **Deshabilitado o pendiente:** conserva la etiqueta de progreso, evita duplicados, cambia el cursor según el flujo, reduce opacidad y elimina la sombra. Nunca se presenta como una acción disponible.

### Campos

Los campos mantienen etiqueta real, ayuda asociada, fondo blanco, borde arena y texto oscuro. El foco visible cambia el borde y agrega un halo de pino; Asistente usa violeta o lila dentro de su panel oscuro y Administración usa azul. Las áreas de texto crecen verticalmente. Horarios de negocio y tono del asistente siguen siendo texto libre, no selectores inventados.

### Navegación

La navegación de escritorio vive sobre tinta y conserva una altura mínima cómoda. El enlace activo usa coral, tinta y `aria-current="page"`; el foco mantiene un contorno coral independiente del estado activo. En móvil, `<details>` ofrece el mismo conjunto de rutas y cierre de sesión, con el contexto actual siempre visible.

### Tarjetas y paneles

Las tarjetas usan superficie marfil, borde fino y radios amplios. Heroes y paneles de guía pueden introducir degradados, transparencias y gráficos explicativos. Las guías se apilan después de la tarea en móvil y los paneles de guardado permanecen separados para que el compromiso sea explícito.

### Avisos y badges de estado

Errores usan peligro y `role="alert"`; éxito y progreso usan pino y `role="status"`. Los avisos conservan el contenido que puede corregirse. Los badges incluyen texto e indicador, y distinguen activo, inactivo, suspendido, conectado, desconectado, vinculación requerida y error sin fusionar significados.

### Conflicto del asistente

Un conflicto de revisión se muestra junto al aviso con una acción violeta “Recargar configuración”. No se sobrescriben cambios más nuevos ni se disfraza el conflicto como validación ordinaria. En móvil, aviso y acción pasan a una sola columna.

### Vinculación por QR

El panel de WhatsApp diferencia QR no solicitado, preparación, QR disponible, conexión confirmada, expiración y fallo. El QR real tiene texto alternativo e instrucciones equivalentes; la acción se deshabilita durante la espera y cuando ya existe conexión. La salida de la ruta cancela el monitoreo sin presentar un error. No existe control para desvincular.

### Estados terminales, vacíos y carga

Carga, sesión no disponible, rol denegado y error de carga reemplazan el contenido de trabajo con un estado terminal claro. La sesión recuperable ofrece volver al inicio de sesión; el error de carga permite reintentar. El inventario vacío no inventa filas ni métricas. Toda mutación mantiene el contexto visible y expresa “Guardando…”, “Creando…”, “Actualizando…” o la acción equivalente.

**Regla de compromiso explícito.** Perfil, asistente, altas y cambios administrativos solo se aplican mediante una acción visible; el estado pendiente conserva contexto y nombre de la operación.

## Do's and Don'ts

### Hacer

- **Hacé** que papel, tinta, pino y coral mantengan la continuidad entre acceso, armazón y tareas.
- **Hacé** que cada foco sea visible, cada estado sea legible por texto y cada aviso use la semántica accesible correspondiente.
- **Hacé** que la navegación móvil y por rol preserve todas las rutas y el cierre de sesión realmente disponibles.
- **Hacé** que la adaptación estrecha reordene, etiquete o apile contenido antes de ocultarlo.
- **Hacé** que conflictos, carga, espera de QR, expiración, errores y estados deshabilitados expliquen qué ocurre y cuál es el siguiente paso posible.

### Evitar

- **No uses** violeta, verde/aqua de WhatsApp o azul administrativo fuera de su ámbito como si fueran acentos globales intercambiables.
- **No agregues** rutas, métricas, bandejas de conversación, recuperación de contraseña, ayuda, desvinculación de WhatsApp ni detalles administrativos que la interfaz actual no soporta.
- **No conviertas** horarios o tono en controles estructurados: ambos son campos de texto libre en el producto vigente.
- **No ocultes** columnas administrativas, acciones inline, etiquetas o significado de estado para resolver el móvil.
- **No reemplaces** `apps/web/src/ui/brand.tsx` con una copia documental del símbolo; esa implementación continúa siendo la fuente de ejecución.

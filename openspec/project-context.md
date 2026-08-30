# Contexto del proyecto AgendIA

## Resultado de la inicialización

El objetivo del SDD es cumplir completamente todos los requisitos de `docs/PRD.md`. El
producto final no debe limitarse a una primera porción del PRD ni aplazar o excluir
silenciosamente ningún requisito.

## Propósito

AgendIA es una plataforma SaaS multiempresa que permite a los negocios configurar un
asistente de inteligencia artificial y conectarlo con WhatsApp sin mantener su propia
infraestructura tecnológica.

## Requisitos y restricciones del producto

- La plataforma debe ser multiempresa, con aislamiento estricto entre negocios.
- El PRD define Baileys como integración inicial con WhatsApp.
- El PRD define DeepSeek como proveedor inicial de inteligencia artificial.
- El PRD indica PostgreSQL como base de datos principal.
- La autenticación, autorización, protección de credenciales, protección de sesiones,
  validación y manejo de errores deben imponerse desde el backend.
- El alcance completo incluye administración de la plataforma y de negocios, usuarios,
  configuración del negocio y del asistente, conexión de WhatsApp, activación del
  asistente, enrutamiento de mensajes, generación de respuestas y envío de respuestas,
  además de los demás requisitos establecidos en el PRD.

## Estado actual del repositorio

El repositorio contiene únicamente documentación. Los requisitos están en
`docs/PRD.md` y `README.md` contiene solo el título del proyecto. No existe todavía
código de aplicación ni herramientas de pruebas.

## Decisiones de arquitectura pendientes

Las siguientes decisiones permanecen intencionalmente sin resolver y deberán tomarse en
fases posteriores del SDD:

- stack de la aplicación;
- implementación del aislamiento entre tenants;
- mecanismo de autenticación;
- límites de despliegue y de ejecución;
- modelo de persistencia;
- herramientas y estrategia de pruebas.

La inicialización no debe inferir ni fijar estas decisiones. Las referencias del PRD a
Baileys, DeepSeek y PostgreSQL son requisitos o elecciones iniciales del producto, no
una autorización para cerrar las decisiones arquitectónicas pendientes.

## Pruebas

Todavía no se puede identificar un ejecutor ni comandos de pruebas porque no se ha
seleccionado el stack de implementación.

## Preflight de sesión

- Modo: interactivo.
- Almacenamiento de artefactos: OpenSpec.
- Política de riesgo: preguntar ante riesgo.
- Límite: 400 líneas modificadas.

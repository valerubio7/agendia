# Contexto del proyecto agendIA

## Autoridad de producto

`PRODUCT.md` es el registro canónico de la verdad durable del producto y de los límites
confirmados de V1. No es una especificación detallada de implementación. Los artefactos de
OpenSpec, el código y las pruebas conservan el detalle verificable de cada incremento.

## Propósito

agendIA es una plataforma SaaS multiempresa que permite a los negocios configurar un
asistente de inteligencia artificial y conectarlo con WhatsApp sin mantener su propia
infraestructura tecnológica.

## Requisitos y restricciones del producto

- La plataforma es multiempresa, con aislamiento estricto entre negocios impuesto desde el
  backend.
- La superficie humana principal es el panel web; la API, los workers y el administrador de
  WhatsApp son servicios de soporte.
- La implementación actual usa Baileys para WhatsApp, DeepSeek para respuestas de IA y
  PostgreSQL como sistema de registro.
- V1 admite una conexión de WhatsApp por negocio y automatiza únicamente texto entrante en
  chats individuales.
- Los duplicados se deduplican; los grupos, mensajes propios y mensajes no textuales o con
  medios se ignoran.
- El negocio y el asistente deben estar activos para automatizar una respuesta.
- Las conversaciones se consultan en WhatsApp; V1 no incluye una bandeja de conversaciones
  en el panel.
- La autenticación, autorización, protección de credenciales y sesiones, validación, manejo
  de errores y aislamiento de tenants se imponen desde el backend.

## Estado actual del repositorio

El repositorio contiene una implementación monorepo: `apps/web` proporciona la interfaz
Next.js, `apps/api` la API Fastify, `apps/message-worker` y `apps/whatsapp-manager` procesan
la automatización, y los paquetes compartidos encapsulan dominio, PostgreSQL/Drizzle,
DeepSeek y Baileys. Las pruebas cubren contratos, integración, aislamiento de tenants, E2E
y unidades. `PRODUCT.md` conserva la verdad de producto; OpenSpec, código y pruebas
conservan el detalle de implementación.

## Decisiones abiertas de producto

El mercado o vertical principal, el modelo comercial y el alcance posterior a V1 permanecen
intencionalmente sin confirmar. No deben inferirse en propuestas o especificaciones futuras.
Las elecciones técnicas actuales son evidencia de la implementación, no compromisos
comerciales ni una ampliación implícita del alcance.

## Pruebas

El repositorio usa Vitest para pruebas unitarias, de integración, contratos y aislamiento, y
Playwright para E2E. Las suites que requieren PostgreSQL o navegador se ejecutan con la
infraestructura definida por el repositorio.

## Preflight de sesión

- Modo: interactivo.
- Almacenamiento de artefactos: OpenSpec.
- Política de riesgo: preguntar ante riesgo.
- Límite: 400 líneas modificadas.

[Portada](../README.md) / [Índice de documentación](README.md) / Cómo funciona

# Cómo funciona agendIA

La agenda parte de lo que el negocio ofrece y de su capacidad de atención. **WhatsApp y la web trabajan sobre los mismos turnos:** el cliente conversa con el agente y el negocio los administra desde el panel.

[Negocio](#qué-configura-el-negocio) · [Agente](#qué-hace-el-agente-por-whatsapp) · [Web](#qué-permite-la-web)

## Qué configura el negocio

- **Servicios:** qué ofrecés, con su descripción, duración y precio.
- **Recursos:** quién o qué puede atender, como una persona, un profesional o un puesto de atención. A cada recurso le asignás servicios y un horario propio.
- **Horarios:** cuándo abre el negocio y qué días o franjas cierra por excepción.

La disponibilidad combina esa configuración con los turnos ya ocupados. Que el negocio esté abierto no significa que haya lugar para cualquier servicio.

### Abierto no significa disponible

**Ejemplo ficticio:** un negocio abre de 09:00 a 18:00. Un recurso atiende de 10:00 a 16:00 y presta un servicio de 40 minutos. Tiene un turno confirmado de 11:00 a 11:40. No hay lugar a las 09:30 (el recurso todavía no atiende), a las 11:30 (ya tiene un turno) ni a las 15:30 (el servicio terminaría fuera de su horario). Las 12:00 son una opción, no una promesa: también importan los cierres, la vigencia del servicio y la asociación con el recurso, y que falte al menos una hora para un inicio nuevo.

El calendario usa `America/Argentina/Buenos_Aires`. Los inicios siguen una grilla de 15 minutos, pero la duración del servicio es positiva y múltiplo de 5 minutos.

## Qué hace el agente por WhatsApp

Responde consultas con la información del negocio, como los servicios, precios y horarios. Consulta lugares disponibles y ayuda al cliente que escribe a reservar, reprogramar o cancelar sus propios turnos.

Para una reserva, presenta una propuesta y pide la aceptación del cliente. **Ofrecer un horario no es reservarlo:** la disponibilidad se vuelve a comprobar antes de guardar el turno.

## Qué permite la web

Desde el panel podés visualizar la agenda, crear turnos manuales y modificar o cancelar reservas. También administrás los servicios, recursos y horarios que usa el agente.

Ahí configurás su estilo de atención y las indicaciones del negocio, y podés activar o pausar las respuestas automáticas. No hace falta copiar reservas entre canales: **el panel y el agente gestionan la misma agenda.**

> **Ejemplo ficticio · Peluquería Brisa**
>
> Brisa ofrece cortes de 30 minutos y los asigna a una profesional con su horario. Una clienta reserva por WhatsApp y el turno queda visible en la web. Si Brisa carga otro turno desde el panel, ese espacio también cuenta como ocupado para el agente.

---

[Volver al índice](README.md) · [Cómo se procesa un mensaje de WhatsApp](architecture.md#el-camino-de-un-mensaje)

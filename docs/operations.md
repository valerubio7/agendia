# Operación, backup y recuperación

## Backups protegidos

PostgreSQL es la persistencia primaria. El servicio administrado debe mantener WAL continuo para **PITR de 14 días** y snapshots diarios cifrados por **30 días** en otra zona. El tránsito y los volúmenes permanecen cifrados. El inventario de recuperación conserva las **KEK históricas** fuera de PostgreSQL durante toda la retención de cualquier backup que pueda referenciarlas.

Las credenciales de Baileys siguen cifradas en el dump; nunca se exportan DEK abiertas, QR, cookies, prompts, mensajes a logs ni claves de proveedores. Una copia no reemplaza la conservación primaria mientras exista el negocio.

## restore trimestral

Operaciones ejecuta `bun run backup:drill` como **restore trimestral** y ante cambios del mecanismo de backup. El ensayo crea origen y destino PostgreSQL 16 aislados, aplica migraciones limpias, restaura un dump y bloquea si no coinciden:

1. conteos de mensajes por tenant;
2. aislamiento RLS del tenant A frente al B;
3. jobs/outbox pendientes;
4. auth Baileys cifrada y versiones de KEK históricas;
5. ausencia de credenciales en texto plano.

El resultado, fecha, snapshot/WAL origen y responsable se guardan en el sistema operacional externo. Un fallo activa la alerta `backup.overdue`/backup fallido y bloquea despliegues.

## Incidentes y contención

El kill switch global detiene automatización sin borrar datos. Suspender un tenant o desactivar su asistente mantiene sus estados; volver a habilitar el switch nunca activa por sí mismo asistentes inactivos ni tenants suspendidos. Los exportadores OpenTelemetry pueden desactivarse sin eliminar la auditoría primaria.

## Despliegue, rollback y migraciones

El **despliegue gradual** empieza con dobles, continúa con tenants controlados y observa cola, heartbeat, conexión, IA, envíos desconocidos y backups. Las migraciones son compatibles hacia atrás. El rollback binario solo se permite si el esquema sigue compatible; si no, se avanza con una **migración correctiva** que conserve historial, auditoría, comandos salientes y material cifrado. Nunca se revierte una migración destructiva sobre datos vivos.

Antes y después del cambio se ejecutan readiness/liveness, `bun run db:check`, aceptación y un restore aislado. No se usan credenciales reales en CI.

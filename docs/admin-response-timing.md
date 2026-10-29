# Tiempos de respuesta globales

Los administradores pueden configurar las esperas inicial y activa y el reinicio por inactividad desde el panel. Los valores son segundos enteros; los cambios afectan nuevas esperas, no las ya programadas. La API usa `GET` y `PUT /admin/response-timing`; el PUT requiere sesión de administrador, origen y CSRF, y un objeto completo `responseTiming`.

## Despliegue y migración irreversible

`0001_remove_admin_ai_guidance.sql` elimina permanentemente las indicaciones administrativas globales guardadas; conserva los tiempos y controles operativos. Respaldá los datos si necesitás conservarlos antes de aplicar la migración. Coordiná el despliegue con la migración: versiones anteriores que consultan la columna eliminada pueden dejar de funcionar después de aplicarla. No se ejecuta automáticamente como parte de este cambio; aplicala solo con autorización sobre la base de destino.

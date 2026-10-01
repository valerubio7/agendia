# Desplegar en un único servidor Ubuntu

Usá Docker Compose para PostgreSQL, la API, la web, el worker de mensajes y el manager de WhatsApp; Nginx instalado en el servidor termina las conexiones HTTPS. Solo la web publica un puerto en la interfaz local del servidor. Esta configuración es independiente del Compose de desarrollo. Ejecutá los siguientes comandos en el servidor, desde la raíz del repositorio, no en tu computadora.

## Requisitos previos

Docker y Compose deben estar disponibles. Instalá Nginx, OpenSSL y el plugin de Nginx para Certbot en Ubuntu:

```sh
sudo apt update
sudo apt install -y nginx openssl certbot python3-certbot-nginx
```

Un servidor con 2 CPU y 8 GB de RAM es un punto de partida razonable para los cuatro usuarios previstos; monitoreá el consumo y construí las imágenes en un horario de poca actividad. Conservá el acceso SSH y restringí el tráfico entrante a SSH, HTTP (80) y HTTPS (443).

El servidor debe ser accesible públicamente en los puertos 80/443. Si está detrás de NAT, configurá el reenvío de puertos del router y una IP pública; con CGNAT necesitás una alternativa de acceso público antes de seguir este procedimiento. En Cloudflare, creá un registro A en modo «Solo DNS» para tu dominio, apuntando a esa IP. Publicá un registro AAAA solo si IPv6 también funciona. Permití conexiones HTTPS salientes para WhatsApp y DeepSeek.

## 1. Configurar secretos

```sh
cp deploy/production.env.example deploy/.env.production
chmod 600 deploy/.env.production
openssl rand -hex 32   # Repetir por separado para cada una de las cinco contraseñas de la base
openssl rand -base64 32  # WHATSAPP_LINK_CODE_KEY
openssl rand -base64 32  # BAILEYS_KMS_KEY (una clave distinta)
openssl rand -hex 24   # Contraseña inicial del administrador
```

Editá `deploy/.env.production`: reemplazá todos los valores de ejemplo, configurá la clave del proveedor y el correo del administrador, y establecé `APP_ORIGIN=https://your.exact.domain` con tu dominio real (sin barra final). Las contraseñas de la base deben ser hexadecimales para que las URL de conexión no requieran escape. Mantené `BAILEYS_KMS_VERSION=v1`. Nunca incluyas el archivo real en un commit ni pases secretos como argumentos de construcción. `production.env.example` puede versionarse; `.env.production` está ignorado por Git. Compose define las variables explícitamente para cada servicio, en lugar de compartir un `env_file` con todos los secretos.

Definí esta función en la terminal para los comandos restantes:

```sh
dc() { sudo docker compose --env-file deploy/.env.production -f compose.production.yml "$@"; }
dc config --quiet
dc build
dc up -d db
dc run --rm migrate
dc run --rm provision
dc run --rm bootstrap-admin
dc up -d api worker manager web
dc ps
curl -I http://127.0.0.1:3000/
```

Frená si falla cualquiera de los comandos de inicialización. Los servicios de configuración están separados mediante perfiles y nunca ejecutan migraciones al reiniciar la aplicación. El comando de migración de producción registra sumas de verificación y aplica únicamente el SQL pendiente, dentro de una transacción. Para la primera instalación, usalo solo con una base nueva: no puede adoptar una base ya inicializada por el ejecutor de migraciones de desarrollo. No ejecutes `bun run db:migrate` contra producción: ese ejecutor vuelve a aplicar las migraciones existentes sin comprobar si ya se ejecutaron.

Después de inicializar correctamente el administrador, reemplazá `AGENDIA_ADMIN_PASSWORD` por un valor de ejemplo no secreto (Compose sigue requiriendo un valor no vacío); volvé a colocar una contraseña válida solo si necesitás repetir la inicialización. Los contenedores de la aplicación nunca reciben las credenciales del usuario de migraciones ni la contraseña inicial del administrador.

## 2. Publicar con HTTPS

Reemplazá el hostname de `deploy/nginx.conf` por el mismo que usaste en `APP_ORIGIN`. En los comandos siguientes, reemplazá también `your.exact.domain` por tu dominio:

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/agendia
sudo ln -s /etc/nginx/sites-available/agendia /etc/nginx/sites-enabled/agendia
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d your.exact.domain --redirect
sudo certbot renew --dry-run
curl -I https://your.exact.domain/
```

Resolvé cualquier conflicto con el sitio virtual predeterminado antes de emitir el certificado. HTTP se usa únicamente para la configuración inicial del certificado; iniciá sesión por HTTPS después de que Certbot agregue TLS y la redirección. Mantené Cloudflare en «Solo DNS» durante la emisión. Si después activás su proxy, seleccioná **Full (strict)**, nunca Flexible; conservá los certificados del servidor válidos y verificá su renovación. Comprobá el temporizador de renovación instalado por Certbot.

La reescritura de `/api` de Next se configura durante la construcción y envía las solicitudes a `http://api:3001`; la API y PostgreSQL no publican puertos. La vinculación por QR usa consultas HTTP periódicas, no WebSockets del navegador ni SSE; las conexiones de WhatsApp son conexiones salientes del manager. No hace falta una configuración de proxy para WebSockets. Verificá el inicio de sesión, la creación de negocios y la vinculación por QR desde la URL pública; la vinculación real con WhatsApp y las respuestas de IA requieren credenciales externas válidas.

## Permisos de los servicios

Cuatro roles LOGIN sin privilegios de superusuario heredan los permisos acotados de los roles NOLOGIN creados por las migraciones. La API usa conexiones separadas para API y administración; su `DATABASE_URL` obligatorio corresponde al usuario de la API, nunca al usuario de migraciones. El worker hereda los permisos que permiten a pg-boss crear y administrar los objetos de su esquema privado. El manager hereda los permisos de WhatsApp y del worker para sus dos RolePools, y usa el mismo LOGIN del worker para pg-boss, conservando la propiedad de los objetos de la cola. No recibe la clave del proveedor de IA. La web no recibe credenciales de base de datos ni claves de cifrado.

Los procesos esperan a que PostgreSQL esté listo; la web espera a que la API responda a su comprobación HTTP. El worker arranca antes que el manager, pero no tiene un endpoint de salud: `service_started` indica orden de arranque, no que la cola ya esté lista. Si hay errores de inicialización, los procesos no continúan y se reinician automáticamente; revisá los logs después de cada despliegue. Los logs rotan con un límite de 3 archivos de 10 MB por servicio. Mantené un único worker y un único manager.

## Actualizaciones y copias de seguridad

Antes de actualizar, respaldá PostgreSQL y las variables/claves en un almacenamiento protegido fuera del servidor. Las credenciales cifradas de WhatsApp están en PostgreSQL; una copia de la base por sí sola no permite descifrarlas sin ambas claves y la versión del KMS. No rotes las claves simplemente reemplazando los valores de las variables.

```sh
umask 077
mkdir -p "$HOME/agendia-backups"
dc exec -T db pg_dump -U agendia_migrator -d agendia -Fc > "$HOME/agendia-backups/agendia-$(date +%Y%m%d-%H%M%S).dump"
# Guardá deploy/.env.production de forma segura junto con la copia, fuera del repositorio.
# Copiá los respaldos a almacenamiento protegido fuera del servidor; la copia local no alcanza.
```

Después de obtener la versión revisada mediante tu procedimiento habitual de publicación:

```sh
dc build
dc stop web api worker manager
dc run --rm migrate
dc run --rm provision
dc up -d api worker manager web
dc ps
dc logs --tail=50 api worker manager web
```

Frená si falla la migración o la creación de usuarios; no arranques aplicaciones incompatibles con la base. La creación de usuarios se puede repetir y actualiza las contraseñas LOGIN; cambiar `POSTGRES_PASSWORD` NO cambia automáticamente la contraseña del usuario de migraciones en una base existente. Mantenela sin cambios salvo que hagas una rotación explícita de contraseña en PostgreSQL. Nunca uses `down -v` para actualizar. Conservá el volumen de datos, el respaldo y una versión compatible para poder recuperar el sistema.

Probá las restauraciones en una base separada: primero ejecutá allí las migraciones y la creación de LOGINs para recrear todos los roles; después restaurá con `pg_restore --clean --if-exists` usando el usuario de migraciones y proporcioná las claves respaldadas. Conservá la propiedad de los objetos y las ACL, especialmente los objetos de pg-boss que pertenecen al worker; no uses `--no-owner` ni `--no-acl`. Este comando de restauración reemplaza el contenido de la base de prueba: nunca lo apuntes a la base en uso.

## Comprobaciones básicas después de la instalación

```sh
dc ps
dc exec -T api bun -e 'const r = await fetch("http://127.0.0.1:3001/auth/session"); if (r.status !== 401) process.exit(1)'
dc exec -T web bun -e 'const r = await fetch("http://127.0.0.1:3000/api/auth/session"); if (r.status !== 401) process.exit(1)'
dc exec -T db psql -U agendia_migrator -d agendia -c "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname IN ('agendia_api','agendia_admin','agendia_worker','agendia_manager');"
dc logs --tail=50 worker manager
```

La API y la web deberían estar saludables, los cuatro LOGINs deberían carecer de privilegios elevados y no debería haber errores de arranque ni bucles de reinicio. Estas comprobaciones no reemplazan las pruebas de inicio de sesión por HTTPS público, aislamiento entre negocios, vinculación de WhatsApp ni una prueba de restauración verificada.

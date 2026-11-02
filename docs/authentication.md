# Autenticación

El acceso común está en `/` y `/login` y utiliza `POST /auth/login`. Los administradores deben ingresar por `/admin/login`, que utiliza `POST /auth/admin/login`; el acceso común rechaza sus credenciales.

Los clientes que autenticaban administradores mediante `POST /auth/login` deben utilizar `POST /auth/admin/login`. Ambos accesos comparten la validación de origen y el límite de intentos. Las rutas protegidas siguen verificando el rol de la sesión.

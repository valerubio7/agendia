# Documentación de agendIA

Este directorio es el mapa de la documentación. Cada documento responde una pregunta concreta y enlaza a la fuente de verdad; no la copia.

## Mapa

| Documento | Pregunta que responde | Fuente de verdad | Actualizar cuando |
| --- | --- | --- | --- |
| [`../README.md`](../README.md) | Qué es agendIA y cómo arrancarlo. | `package.json`, `docker-compose.yml` | Cambia el arranque o el mapa del repositorio. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Cómo se mueve el sistema y por qué está partido así. | `apps/`, `packages/` | Cambia un límite entre componentes o un flujo. |
| [`DATABASE.md`](DATABASE.md) | Qué datos existen, cómo se relacionan y cómo se aíslan. | `packages/db/migrations/` | Nueva migración o cambio de roles/RLS. |
| [`database/tables.md`](database/tables.md) | Qué hace cada tabla y cómo se conecta. | `0000_base.sql` | Nueva tabla o cambio de relaciones. |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Cómo trabajar, probar y depurar localmente. | `package.json`, `.env.example` | Cambia el setup, un runner o CI. |
| [`OPERATIONS.md`](OPERATIONS.md) | Cómo se despliega, se configura y se recupera. | `Dockerfile*`, `compose.production.yml`, `.github/workflows/` | Cambia infraestructura, secretos o release. |

## Reglas

1. **Un hecho vive en un solo lugar.** El hub enlaza, no repite. Si un dato aparece dos veces, una de las copias va a quedar vieja.
2. **La referencia no se escribe a mano.** Variables en `.env.example`, comandos en `package.json`, esquema en las migraciones. Los documentos explican el porqué y el flujo.
3. **Cada documento declara su fuente de verdad y su trigger** en la tabla de arriba. El PR que cambia el comportamiento actualiza el documento en el mismo commit.
4. **Se divide por pregunta, no por tamaño.** Un documento se parte cuando supera las ~200 líneas o cuando aparece un segundo lector con otro trigger. El diccionario de tablas es referencia y nace separado.
5. **Enlaces relativos al archivo, nunca a la línea.** Las líneas se mueven; el archivo queda.
6. **Un solo nivel de profundidad.** `docs/README.md` enlaza a los hubs; cada hub enlaza a sus hojas. Nunca hub → hub → hoja.

## Alcance

Esta base cubre el proyecto: arquitectura, datos, desarrollo y operaciones. La guía para el dueño del negocio y un documento de producto se agregan cuando exista ese lector; hoy no forman parte.

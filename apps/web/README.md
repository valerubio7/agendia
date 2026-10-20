# Mapa del código web

Buscá cada pantalla por capacidad en `src/features/`. `app/` conserva las rutas de Next y sus URLs; conecta cada página con `LivePanel` o con su wrapper de vista existente.

## Dónde cambiar cada cosa

| Ubicación | Responsabilidad |
| --- | --- |
| `src/shell/live-panel.tsx` | Composición de pantallas y estado compartido: sesión, permisos, generaciones de solicitudes, recuperación, cancelación, logout y coordinación de mutaciones. También conserva el login y el monitor de vinculación de WhatsApp. |
| `src/shell/authenticated-shell.tsx` | Navegación autenticada y estados terminales del panel. |
| `src/components/` | Marca y editor semanal compartido por recursos y horario del negocio. |
| `src/api/api-client.ts` | Cliente HTTP, transporte, CSRF y tipos usados por las pantallas. |
| `src/features/appointments/` | Pantalla, formulario, detalle y calendario de turnos. |
| `src/features/clients/` | Clientes e historial de turnos del cliente. |
| `src/features/services/` | Catálogo de servicios. |
| `src/features/resources/` | Catálogo de recursos y sus horarios. |
| `src/features/business-calendar/` | Horario del negocio, cierres y conversión de horas de Argentina. |
| `src/features/business-profile/` | Vista y pantalla del perfil del negocio. |
| `src/features/agent-settings/` | Vista y pantalla de configuración del agente; conserva los nombres públicos `AssistantView` y `AssistantScreen`. |
| `src/features/whatsapp/` | Vista, pantalla y renderizado local del QR. |
| `src/features/administration/` | Vista y pantalla de administración de negocios. |
| `app/styles.css`, `public/` | Estilos globales y recursos estáticos. |

Los handlers y helpers compartidos siguen siendo propiedad de `LivePanel`; las carpetas de capacidad no redistribuyen ese estado. La extracción del login a `features/auth` queda para T2: todavía no existe una carpeta vacía de autenticación.

## Pruebas

Las pruebas unitarias de WhatsApp, calendario de turnos y horas de Argentina viven junto a sus fuentes (`*.unit.test.ts`). Las pruebas entre componentes, contratos y E2E permanecen en `tests/` en la raíz del repositorio.

Desde la raíz: `bun run typecheck`, `bun run test:unit`, `bun run test:contracts` y `bun run --cwd apps/web build`.

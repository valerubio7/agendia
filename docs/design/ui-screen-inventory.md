# Current UI screen inventory

This inventory is the functional contract for production UI. It is governed by the [UI/UX foundation](./ui-ux-foundation.md): current code defines what exists, while [`agendia_screens.html`](./agendia_screens.html) contributes style and identity only.

Read each requirement at the correct layer: **supported capability** means current backend/client contract, **current web UI** means what `LivePanel` visibly renders today, and **production visual obligation** means the intended UI treatment. An obligation is not evidence that the current UI already implements it.

## Route and role map

| Web route | Audience | Purpose | On successful entry |
| --- | --- | --- | --- |
| `/` | Signed-out user | Login | Redirect by session role |
| `/businesses` | `platform_admin` | List and manage businesses | Load all business projections |
| `/profile` | `business_user` with a business | Edit business profile | Load the authenticated tenant's profile |
| `/assistant` | `business_user` with a business | Edit assistant configuration | Load the authenticated tenant's assistant and revision |
| `/whatsapp` | `business_user` with a business | View status and complete WhatsApp linking | Load the authenticated tenant's connection status |

There are exactly two user roles:

- `platform_admin`: platform-wide business administration; no business tenant is attached.
- `business_user`: access to one authenticated business tenant's profile, assistant, and WhatsApp connection.

After login, `platform_admin` goes to `/businesses`; `business_user` goes to `/profile`. Authorization contracts safely reject role mismatches. Current `LivePanel` behavior and the intended terminal denial correction are recorded below. Admin resources are deliberately hidden from non-admin API callers as not found; business resources reject non-business roles as forbidden.

## Shared behavior across authenticated routes

### Shell and navigation

- Business navigation exposes only `/profile`, `/assistant`, and `/whatsapp`.
- Admin navigation exposes the `/businesses` inventory only.
- The production shell must expose the existing logout capability as a visible action; this is an intended treatment, not current `LivePanel` behavior.
- No shell may imply a business dashboard or admin detail route.

### Verified contract-to-UI gaps

| Concern | Supported capability | Current web UI | Production visual obligation |
| --- | --- | --- | --- |
| Logout | `POST /auth/logout` revokes the session; `ApiClient.logout()` calls it and clears the client's CSRF token. | `LivePanel` has no logout control or handler and performs no logout redirect. | Add a visible authenticated-shell action that uses `ApiClient.logout()` and, after success, takes the user to the existing `/` sign-in route. |
| Role denied | Current authorization contracts reject mismatched roles safely. | `LivePanel` renders `Tu rol no permite acceder a este panel.` as an alert, but also leaves `Cargando panel…` visible indefinitely. | Render a terminal safe denial state instead of the misleading spinner; authorization semantics stay unchanged. |
| Invalid or suspended session | `UNAUTHENTICATED` maps to safe copy that says the session expired or the business is suspended and asks the user to sign in again. | `LivePanel` displays the safe copy but does not navigate automatically. | Provide an explicit action to the existing `/` sign-in route. Do not describe this as a current automatic redirect. |

### Production application-state obligations

| State | Production UI obligation |
| --- | --- |
| Initial load | Show a named panel/page loading state while session and route data load. |
| Empty business list | Show the admin table's empty state without inventing metrics or sample rows. |
| Empty profile/assistant | Show editable fields with empty values and the same validation rules as populated data. |
| Mutation pending | Keep context visible, disable the initiating action, and communicate saving/creating/updating. |
| Success | Announce the route-specific success message without replacing the task content. |
| Safe error | Render one global alert and retain recoverable user input. Never expose raw server details. |
| Session invalid or business suspended | Preserve the safe explanation and provide an explicit action to `/` so the user can sign in again. |
| Role denied | Render a terminal denial state with safe copy; replace, rather than accompany, loading content. |
| Not found | Explain that the resource is unavailable without revealing hidden admin resources. |

Current safe error meanings are:

| Code | Meaning to represent |
| --- | --- |
| `UNAUTHENTICATED` | Session expired, credentials rejected, or suspended business cannot authenticate |
| `FORBIDDEN` | Role or business state does not permit the action |
| `VALIDATION_FAILED` | One or more submitted fields are invalid |
| `CONFLICT` | Data changed or a linking request conflicts with current state |
| `NOT_FOUND` | Resource or temporary link code is unavailable |
| Other/transport failure | The operation could not be completed; do not expose internal details |

Errors use an alert announcement. Non-urgent success and progress use status announcements. API mutations retain current origin and CSRF protection; UI work must not weaken or replace that behavior.

## `/` — login

**Audience:** signed-out users of either role.

### Fields and validation

| Field | Type | Rules |
| --- | --- | --- |
| Email | Email input | Required; valid email; normalized by trimming/lowercasing on the server |
| Password | Password input | Required; minimum 16 characters |

### Actions and states

- **Sign in:** authenticate, establish the existing secure session, fetch the resulting role, then redirect to `/businesses` or `/profile`.
- Show a submitting state and prevent duplicate submission.
- On success, current feedback is `Sesión iniciada`, although navigation normally follows immediately.
- Invalid credentials, inactive identity, and suspended business use safe authentication failure; never identify which credential was wrong.
- Origin rejection is an authorization error.
- Do not show password recovery or any other unsupported account action.

## `/businesses` — platform administration

**Authorized role:** `platform_admin` only.

The screen is a list with creation above it and management actions inline. It is not a dashboard and has no business detail navigation.

### Create business

| Field | Rules |
| --- | --- |
| Name | Required after trimming; maximum 160 characters |
| User email | Required valid email |
| Initial password | Required; minimum 16 characters |

**Action:** create the business and its business user, then reload the inventory. Success message: `Negocio creado`.

### Business inventory

Each row represents these actual values:

| Value | States/format |
| --- | --- |
| Name | Current business name |
| Business status | `active` or `suspended` |
| Assistant status | `active` or `inactive` |
| WhatsApp status | `connected`, `disconnected`, `link_required`, or `error` |
| Created at | Server timestamp |
| Last technical activity | Timestamp formatted for `es-AR` in UTC, or `Sin actividad` |

The view is operational only and must not reveal conversations or secrets.

### Inline row actions

| Action | Input/state | Result |
| --- | --- | --- |
| Rename | Editable name; required after trimming; maximum 160 characters | Replace the business name, reload rows, announce `Negocio actualizado` |
| Change password | New password; minimum 16 characters | Replace the business user's password, reload rows, announce `Negocio actualizado` |
| Suspend | Available when status is `active` | Change status to `suspended`; existing business sessions are no longer valid |
| Reactivate | Available when status is `suspended` | Change status to `active` |

Each row action needs its own pending and failure treatment so users can identify which business is affected. Missing businesses produce not-found feedback; invalid fields or status produce validation feedback. The UI must present these real inline actions rather than substituting an unsupported “open details” workflow.

## `/profile` — business profile

**Authorized role:** `business_user` with an authenticated business tenant.

All values are tenant-scoped strings. Initial absence returns an empty form.

| Field | Requirement |
| --- | --- |
| `displayName` — Commercial name | Required after trimming; maximum 160 characters |
| `description` — Description | Free text; maximum 4,000 characters |
| `address` — Address | Free text; maximum 500 characters |
| `contact` — Contact | Free text; maximum 500 characters |
| `businessHours` — Business hours | **One free-text value**; maximum 2,000 characters |
| `offerings` — Services or products | Free text; maximum 8,000 characters |
| `faq` — Frequently asked questions | Free text; maximum 8,000 characters |
| `policies` — Policies | Free text; maximum 8,000 characters |
| `additionalInfo` — Additional information | Free text; maximum 8,000 characters |

**Action:** explicitly save the complete profile. Success message: `Perfil guardado`.

Represent initial loading, empty values, field validation, save pending, success, safe failure, session failure, and role denial. `additionalInfo` is a real capability absent as a distinct field in the reference and must not be merged into policies. Business hours must not be split into weekday/day/time controls.

## `/assistant` — assistant configuration

**Authorized role:** `business_user` with an authenticated business tenant.

| Field | Requirement |
| --- | --- |
| `personality` — Personality | Free text; trimmed; maximum 8,000 characters |
| `tone` — Tone | **Free text**; trimmed; maximum 8,000 characters |
| `instructions` — Instructions | Free text; trimmed; maximum 8,000 characters |
| `knowledge` — Knowledge | Free text; trimmed; maximum 8,000 characters |
| `rules` — Rules | Free text; trimmed; maximum 8,000 characters |
| `restrictions` — Restrictions | Free text; trimmed; maximum 8,000 characters |
| `active` — Automatic responses active | Boolean control |
| `revision` | Read-only concurrency value; not a user-editable configuration field |

**Action:** save all fields with the last loaded revision. Success message: `Asistente guardado`. The action label must not imply activation when `active` is off.

### Required states

- Empty configuration begins with empty text and revision `0`.
- Saving returns the new revision and current values.
- If another update changed the revision, the API returns `CONFLICT`. Show that data changed and require reload before retry; do not silently overwrite newer data.
- Validation failure is distinct from revision conflict.
- Active and inactive states require explicit labels, not color alone.
- Current business hours are informational context; assistant eligibility does not introduce a split-hours editor here.

`personality`, `knowledge`, `rules`, and revision conflict handling are real capabilities missing from the HTML reference and require first-class visual treatment. Tone remains free text; preset tone cards are excluded.

## `/whatsapp` — connection and linking

**Authorized role:** `business_user` with an authenticated business tenant.

### Connection summary

Represent all current public statuses separately:

| Status | Meaning and primary treatment |
| --- | --- |
| `connected` | Linked and available; disable link initiation |
| `link_required` | A new temporary link can be requested |
| `disconnected` | Not currently connected; show exact status and current available linking behavior |
| `error` | Connection failed; a new link can be requested |

Show available connection metadata without inventing values:

- Linked number (`linkedNumber`), when present.
- Linked timestamp (`linkedAt`), when present.
- Last connected timestamp (`lastConnectedAt`), when present.
- A clear unavailable value when metadata is null.

### Full linking lifecycle

1. **Initial load:** fetch status. If not connected, show any currently available temporary QR; unavailable QR is not itself a fatal page error.
2. **Request/resume:** `Vincular WhatsApp` starts or resumes linking. A concurrent link request conflict is treated as resumable, not as a second connection.
3. **Waiting for QR:** disable duplicate requests and show progress while polling for an available code. The current client waits up to 60 attempts at 500 ms intervals.
4. **QR ready:** render the temporary QR with textual scan instructions and descriptive alternative text. The QR response is not cached.
5. **Monitoring:** poll connection status approximately every two seconds, refresh the image when QR content rotates, and keep the displayed status current.
6. **Connected:** remove the QR, stop linking progress, update status/metadata, and announce `WhatsApp conectado correctamente.`
7. **Expired:** after the current five-minute QR lifecycle, remove the QR, stop progress, and announce that a new code is required. Offer the same supported link action to retry.
8. **Failed:** remove stale QR/progress and show safe global error feedback.
9. **Cancelled:** leaving the route stops monitoring without presenting cancellation as a connection failure.

The request notice is `Vinculación solicitada. Escaneá el QR desde WhatsApp.` While monitoring, the action communicates `Esperando conexión…`; when connected, it communicates `WhatsApp vinculado` and remains disabled.

Only one connection per business is supported. There is no WhatsApp unlink capability, so no unlink control may appear.

## Capability boundary

### Existing capabilities to preserve

- Login with role-based redirect and secure session behavior.
- Logout through the current API and `ApiClient`, with visible authenticated-shell exposure as a production obligation.
- Current global loading, safe error, and success feedback, plus the intended terminal role-denial correction.
- Business onboarding navigation across profile, assistant, and WhatsApp.
- Complete profile fields, including `additionalInfo` and free-text `businessHours`.
- Complete assistant fields, including `personality`, free-text `tone`, `knowledge`, `rules`, active state, and revision conflict recovery.
- WhatsApp status, metadata, temporary QR request/resume, rotation, monitoring, success, expiry, failure, cancellation, and retry.
- Admin business creation, operational columns, and actual inline rename, password, suspend, and reactivate actions.

### Prototype-only ideas to exclude

| Exclude | Reason |
| --- | --- |
| Business home/dashboard, setup checklist, completion state, and overview metrics | No current web route or supporting UI capability |
| Admin summary metrics | No current screen contract |
| Admin business detail, “open” action, account detail, or technical detail route | No current route; management is inline |
| Preset assistant tone cards | Tone is a free-text field |
| Split weekday/Saturday or structured business hours | Business hours are one free-text field |
| WhatsApp unlink/change-number flow | No unlink capability |
| Password recovery/forgot-password link | No recovery capability |
| Prototype cancel/reset controls on profile or assistant forms | Current forms support explicit save, not a separate discard/reset action |
| Prototype help button or unsupported top-bar actions | No current behavior |
| Sample tenants, phone numbers, dates, metrics, and health claims | Reference content is illustrative only |
| Conversation access, secret display, provider/model controls, or additional admin controls | Not supported and conflicts with the current operational boundary |

A visually plausible control is still excluded unless it maps to current behavior.

## Phased implementation sequence

| Phase | Scope | Why this order |
| --- | --- | --- |
| 1. Foundation and login | Tokens, typography, primitives, global feedback, responsive login, role redirects | Establishes identity and shared interaction states with the smallest route |
| 2. Shared shell | Business/admin shells, real navigation, logout, loading and denial states | Makes every later route reachable and role-correct |
| 3. Profile | All nine fields, free-text hours, validation, save feedback | Exercises long-form responsive forms and tenant data |
| 4. Assistant | All six text fields, active state, revision handling | Reuses forms and adds concurrency conflict behavior |
| 5. WhatsApp | Status summary, metadata, QR and complete linking lifecycle | Adds polling, temporary media, expiry, and retry states |
| 6. Admin | Creation, responsive inventory, inline rename/password/status actions | Builds the densest role-specific operational screen on stable foundations |

Each phase preserves the current route and backend behavior. Visual implementation must not defer a real field or state merely because the HTML reference omitted it.

## Review checklist

- [ ] The five current web routes and both roles match the route map.
- [ ] Supported contracts, current `LivePanel` behavior, and production visual obligations remain distinct.
- [ ] Logout uses the existing capability, role denial replaces loading content, and invalid/suspended sessions offer an explicit `/` action.
- [ ] Role mismatch, unauthenticated, suspended, validation, conflict, not-found, and generic failures have distinct safe representation.
- [ ] Every profile and assistant field is present with its actual validation.
- [ ] Business hours and assistant tone remain free text.
- [ ] Assistant revision conflicts have visible reload-and-retry recovery.
- [ ] All four WhatsApp statuses and the complete temporary QR lifecycle are represented.
- [ ] Admin actions remain inline and include rename, password replacement, suspend, and reactivate.
- [ ] Global pending, success, error, empty, and loading states are accessible.
- [ ] No item in the prototype-only exclusion table is visible.
- [ ] Visual decisions follow the [UI/UX foundation](./ui-ux-foundation.md).

## Source evidence

### Web routes and behavior

- `apps/web/app/page.tsx`
- `apps/web/app/(admin)/businesses/page.tsx`
- `apps/web/app/(business)/profile/page.tsx`
- `apps/web/app/(business)/assistant/page.tsx`
- `apps/web/app/(business)/whatsapp/page.tsx`
- `apps/web/src/live-panel.tsx`
- `apps/web/src/api-client.ts`
- `apps/web/src/admin-view.ts`

### Authorization, validation, and persistence

- `apps/api/src/app.ts`
- `packages/auth/src/index.ts`
- `packages/domain/src/business-profile.ts`
- `packages/domain/src/assistant-config.ts`
- `packages/domain/src/administration.ts`
- `packages/domain/src/whatsapp/connection.ts`
- `packages/db/src/repositories.ts`

### Executable behavior evidence

- `tests/contracts/web-api-client.contract.test.ts`
- `tests/integration/http-auth-admin-me.integration.test.ts`
- `tests/e2e/admin.spec.ts`
- `tests/e2e/profile.spec.ts`
- `tests/e2e/assistant.spec.ts`
- `tests/e2e/whatsapp.spec.ts`

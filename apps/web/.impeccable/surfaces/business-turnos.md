---
version: 1
slug: "business-turnos"
primary_target: "apps/web/src/features/appointments/turnos-screen.tsx"
related_targets: ["apps/web/src/features/appointments/turnos-booking-form.tsx", "apps/web/src/features/appointments/turnos-detail.tsx", "apps/web/app/styles.css"]
---

# Turnos V2 — full-width agenda, one native dialog

Operate, code-led; T2/S1–S7 in `odd/tasks/business-ui-redesign.md`, especially S2/L15. The owner rejected V1's monotone inline agenda/detail/editor composition. Its screenshots and earlier visual `ship` are historical anti-reference, not approval or V2 proof. The owner approved V2 with “aprobado, podes continuar”, after the scoped evidence and technical caveat below were disclosed. Local delivery precedes Services; publishing remains unauthorized. Accepted Profile/navigation identity stays fixed.

## Direction contract

THESIS: Keep the agenda full-width. Appointment selection and Nuevo turno open one native modal workspace, not an adjacent inspector or content below the agenda. Modificar changes the visible surface inside that same dialog. Functional headings and scheduling/safety explanations remain; there is no descriptive hero to remove.

OWN-WORLD: Warm paper and white working surfaces, fixed Source Sans 3 and official logo. Coral with ink identifies create/modify/review/confirm booking actions; honey-soft carries compact date rails, month choices and offered terms; pine carries selection, success and focus; danger carries destructive actions/errors. No new palette, root tokens, assets, gradients or marketing cards. This richer owner-requested vocabulary overrides generic one-accent guidance.

STORY: Scan aligned time/client/service/textual-state rows beside honey date labels. Empty dates compress to one short row on desktop. Existing Hoy/Semana/Mes and range controls retain their original dates and behavior. Selecting a row immediately reveals the dialog's loading/error/current-detail flow and still performs the original fresh read. Nuevo turno opens creation; Modificar hides the mounted keyed detail and opens the existing editor. Recovery stays reachable in the active surface.

FIRST VIEWPORT: Preserve the accepted navigation above a compact heading, coral Nuevo turno and calendar controls. The full-width white agenda no longer narrows when working with a turn. Desktop dialog is centered, capped at 58rem and viewport height minus 4rem, with a visible heading/close header and internally scrolling body. Mobile uses viewport minus 1rem, with stacked fields and ordinary flowing actions rather than a sticky stack obscuring inputs. Desktop creation groups the two existing fieldsets into columns; its footer stays sticky inside the body.

FORM: `#turnos-dialog` uses `showModal()`, native Tab containment and background inertness. Only `[open]` receives `display:flex`; the closed dialog is actually hidden. Initial focus goes to the static `#turnos-dialog-title`, not the form or dialog element. Booking's optional `initialFocus` defaults to its previous behavior; this modal opts out of mount focus only. Review/confirm/notes focus remains child-owned. X and native Escape share one guarded close controller; no backdrop dismissal, stacked modal, global Escape listener or close-event recursion.

## Close and draft semantics

| Action | Implemented result |
|---|---|
| Detail X/Escape | Hide presentation only. Keep keyed detail and local notes/confirmation state mounted; closing alone does not discard its draft. |
| Cancelar formulario, create | Existing editor/error cleanup and focus scheduling; discard creation draft, close, return to Nuevo turno. |
| Cancelar formulario, change | Existing cleanup; discard structural editor draft and return to detail in the same open dialog. |
| Editor X/Escape, cancellation allowed | Use that same form cancellation, then close. Return to the original external invoker, including after entering Modificar. |
| Editor X/Escape, session/unresolved lock | Hide presentation without cancelling/unmounting the disabled editor, clearing its draft or touching intents. No trapped user. |
| X/Escape during submission | Do not dismiss: check parent pending/mutation ownership and child busy presentation. Detail exposes its existing saving state through `aria-busy`. |
| Explicit row reselection | Preserve original detail/editor reset and current-state GET; never reuse stale detail to avoid a read. Later explicit opening still uses the existing catalog/current-read lifecycle, not a new persistence promise. |

One visibility effect owns native `showModal()`/`close()`. The close controller never aborts/retries a write, changes operation storage/fence, invokes recovery, or calls a cancellation API. On close the effect restores a connected, enabled, visible external invoker, falling back to the page heading. Entering Modificar never replaces that external invoker. Delayed parent detail-focus requests do nothing while closed; while open, background create/heading requests resolve to the modal heading. Hidden detail uses native `hidden` plus scoped `display:none`, excluding its controls from focus/accessibility while keeping its state mounted.

## Recovery and protected invariants

- The complete original feedback/recovery JSX is defined once as an element, conditionally placed inside the open dialog or in-page while closed. No portal/dependency or nested component type is needed. There is only one mounted feedback location, outside disabled fieldsets: notices/errors, authorization retry, current-state refresh, receipt query and pending-request cancellation plus its confirmation. All original predicates, copy and callbacks remain. Pending-request cancellation is not appointment cancellation.
- Parent mutation ownership remains mounted. API calls/payloads, actor/session/abort ownership, durable operation storage, recovery orchestration, guards and calendar helpers are unchanged. Pre-render changes are limited to L15's visibility/ref/invoker/effect, guarded reveal, surface-aware focus and booking mount-focus adapter. Form cancellation reuses its original cleanup rather than inventing domain cancellation.
- Preserve keys, form ownership, controlled values, labels/IDs/native types, disabled fieldsets/busy protections, existing/new client branches, active assignments, Argentina dates/ARS, server raw slots, expectedTerms, validation, one-hour rules and final revalidation. No autosave, new field limits, scheduling feature, persistence or date semantics.
- Keep irreversible/no-reopen/no-WhatsApp explanations. Accepted navigation declarations and the V1 selector-only Turnos adoption remain unchanged; Profile, other screens, shell/API/contracts/helpers/root tokens/fonts/logo are untouched.

## Evidence and review path

Parent job-9 reproduced the rejected interaction: both actions opened zero dialogs, with zero business writes. V2 source now supplies one actual dialog and no inline inspector. Static checks are reported by the implementation handoff, not substituted for rendered proof.

Parent-owned V2 captures and bounded read-only inspection cover 1440/1024/390/320. Observed native modal/title focus, forward/backward Tab containment and Escape actual-invoker return passed at all four widths; Profile navigation/form/horizontal invariants and public-data comparisons passed at 1440/390. This is not proof of locked/pending/error/recovery or terminal-state mutation outcomes, which remain unexercised under S5. V1 evidence does not certify V2.

Static palette guidance: ink/coral 5.53; ink/honey 8.24; ink/honey-soft 12.84; white/pine 6.31; white/danger 5.93. White/coral fails at 2.82 and is never used for booking action text. Sixteen runtime text/background samples across four widths passed, minimum 5.53; these certify only the sampled pairs, not every state or blanket contrast compliance.

Applied skills: Impeccable with Operate, colorize and craft floor; redesign-existing-projects for replacing the rejected composition within the existing stack; ponytail for one native dialog and no dependency; cognitive-doc-design for the direction/close table/evidence handoff. No context/init/concept/seed/comp rerun, global DESIGN change, shipping raster, mutation probe, suite, commit or T3 advance.

S1 preserves functional content without adding a hero; S2 implements the requested floating interaction and palette correction; S3 stops for parent/owner review before any commit; S4 reports applied skills; S5 defers suites/mutations; S6 preserves the already-adopted navigation without declaration changes. No linked spec is intentionally omitted.

Task Size Risk: none — presentation and bounded modal adapters only; no data, security, contract or mutation-ownership change. Review volume and missing browser evidence are delivery/proof concerns, not data/security risk classifications.

## Observed evidence and remaining limitations

| Evidence | Observed result and boundary |
|---|---|
| Protected source | Audit exited 0: API expressions and ownership/storage/abort/read/recovery/mutation/submit/notes-save functions match baseline. Accepted navigation declarations and shared shell/API/contracts/Profile/helpers are unchanged. |
| Static checks | Typecheck, diff check and local detector exited 0. The detector's 44 advisories are outside Turnos. |
| Initial V2 inspection | The inspector incorrectly waited for a Turnos-only dialog on Profile and timed out; its existence guard was fixed. Original failed artifacts remain intact. |
| Targeted modal/Profile inspection | Real modal/focus/Profile checks above passed, with zero business write attempts and equal public Profile/initial-range appointment responses. Run exit 1 remains for `invoker-before:1024`, `invoker-before:390`, `invoker-before:320`: helper-added pre-click focus checks whose historical cause is unknown. |
| Readiness correction | Future inspection waits for public enabled/connected button readiness and records focus metadata. One pre-click-only 390px probe exited 0 with unchanged Profile and zero write attempts. The button was already enabled, so it did not reproduce or establish the cause of the old flags. No full/multi-width rerun or retroactive pass is claimed. Application guards/focus were not changed to satisfy the helper. |
| Fresh visual review | Disclosed generic read-only substitute for unavailable native finishing roles inspected 27 V2/current/approved Profile captures and returned `ship`, no material fixes. It is not an independent technical verifier. Mobile notes, populated booking review/confirmation and asynchronous recovery are not certified. |
| Native assessment | Unassessable with untracked artifacts. The RDD-off writer-self-verification plan was followed; no separate verifier was required. |
| Deferred proof | Suites, saves, terminal-state and pending/error/recovery mutation outcomes remain unexecuted under S5. No blanket all-checks-green claim. |
| Owner gate | The owner approved V2 after disclosure of these limitations. Local commit is authorized before Services; no publishing is authorized. |

S7's captured visual comparison passed against accepted Profile. Keep typography, control vocabulary, palette meanings, navigation, feedback, focus and overlay conventions coherent while adapting layouts to each task. Final all-screen T9 remains pending; do not silently redesign previously accepted surfaces. Detailed historical evidence is retained in the feature task log.

---
version: 1
slug: "business-clients"
primary_target: "apps/web/src/features/clients/clients-screen.tsx"
related_targets: ["apps/web/app/styles.css"]
---

# Clientes — directory beside profile and history

Operate, code-led; T6/S1–S7 in `odd/tasks/business-ui-redesign.md`, especially L48–L55. Owner manually approved the existing screen with “yo lo vi bien, podes seguir” after the proof limits below were disclosed. Local delivery is authorized; T7 follows only the observed commit. Approval does not certify missing checks.

## Direction

- A compact Clientes heading pairs with the existing Crear cliente action. At 64rem, a 21rem quiet search/directory sits beside profile/history; smaller screens stack in source order. No sticky pane, clipped list or internal scrolling hides content.
- Keep the original conditional inline creation form above the explorer and the original conditional edit form inside the selected profile. Creation fields share a row only on wide screens; edit fields stack. No modal, new editor lifecycle, hidden control or changed draft ownership.
- Rehouse exactly “Buscá por nombre o teléfono.” beside search and “Los turnos conservan las condiciones originales del servicio y recurso.” beside history. Only their combined opening paragraph is removed. A noninteractive empty-detail hint explains existing selection; CSS hides only that hint when detail exists.
- Warm paper, ivory directory and white detail use accepted Source Sans 3, official logo and root colors. Coral with ink marks create/save; Edit, Search and Cancel are outlined; GET refresh/recovery is quiet. Honey distinguishes stored-history/time context, pine marks focus and selection. State-only 160ms transitions yield to reduced motion.
- Names, phones, stored service/resource terms, textual appointment states, full-precision Argentina timestamps/offsets, duration and es-AR ARS amounts wrap without truncation. Appointment rows remain flat separators, not nested cards. No metrics, invented availability, filters, sorting, pagination or extra actions.

## Preservation and isolation

Freeze Clients lines 1–331 against `68bb5163beb5ef7082d83c7f614d573ad01cedee`, including the appointment renderer. Changes below that boundary are classes, unconditional nonfocusable wrappers, the two authorized help relocations and the selection hint. Existing predicates, expressions, callbacks, roles, keys, refs and non-presentation props remain authoritative.

Create/edit retain exactly three required controlled inputs: firstName/Nombre/text, lastName/Apellido/text and phone/Teléfono/tel. Preserve IDs, names, label associations, values, raw guarded input callbacks and raw three-field JSON submission. No new caps, native constraints, masks, defaults, normalization, external form association or field refs. Search stays controlled implicit text, initially empty and submit-only; no live query/filter behavior. Original form refs, conditional mounting, button ownership/types, busy labels, cancellation and focus scheduling remain unchanged.

The read-back-verified scoped creation journal, ownership checks, fences, session/generation/abort guards, uncertain-outcome rules and confirmed-DTO authority are read-only. Comprobar cliente keeps its original GET-only exact-match recovery and `disabled || pending` predicate, not `locked`. Its new action wrapper has no disabled state, overlay or pointer-events fence. No storage setup or recovery fixture is authorized.

Upcoming remains confirmed future appointments; complete history remains all rows, including future. Clock/focus/visibility updates, shared formatting, phone/domain validation, tenant/API/LivePanel/shell and every other consumer remain untouched. No data reset or synthetic replacement.

All appended local selectors start with `main.clients-screen[aria-labelledby="clients-title"]`. Navigation adopts only `main.clients-screen:where([aria-labelledby="clients-title"])` in the 43 existing accepted alternatives, retaining zero attribute specificity, old branches and declarations. All legacy CSS and five approved-screen overrides must restore byte-for-byte after reversing only these additions. No token, font, asset, shared helper or global DESIGN change; admin composition is not business approval authority.

## Evidence and static checks

Opened all four actual root before captures: `.impeccable/review/business-clients-before-1440.png`, `business-clients-before-390.png`, `business-clients-before-selected-1440.png` and `business-clients-before-selected-390.png`. Layout evidence shows oversized opening/green full-width rows and selected detail below the list. No record identities are reproduced here. Parent reports baseline job-23 exit 0/3s, equal Clients/selected-appointments DTOs and zero writes. These are BEFORE evidence, not candidate proof.

Read all five accepted business briefs and their stylesheet conventions. No approved-screen capture is claimed viewed by this worker. No context/init/seed/concept/comp/raster or global design regeneration occurred. A first navigation edit was rejected atomically because one match also occurred in reduced-motion CSS; the corrected, uniquely scoped edit succeeded without changing declarations.

Observed once: `bun run typecheck` exited 0, output `$ tsc -p tsconfig.json --noEmit`. The single detector command `cd apps/web && /home/valerubio7/.pi/agent/skills/impeccable/scripts/impeccable detect --json src/features/clients/clients-screen.tsx app/styles.css` exited 0 with 44 advisory design-system-color findings in unchanged CSS lines 108–3030, none in Clients JSX or appended CSS. Tool output combines streams; separate stdout/stderr attribution is unavailable.

The bounded inline Node/TypeScript AST/source/CSS audit exited 0 on its first run: frozen 331-line prefix byte-equal, complete AST equivalent after only classes/unconditional wrappers/authorized help/hint exceptions, all 14 raw callback attributes and nine API calls identical, native input templates and form-button ownership unchanged. Both exact help sentences occur once; the combined opening is absent. Reversing 43 neutral navigation additions restores ALL prior CSS byte-for-byte; all 65 appended rules are Clients-qualified. No overlay, pointer-events fence or clipping rule was introduced; only the noninteractive hint is hidden. Other tracked sources are unchanged, with no new scratch/cache path.

Source/style footprint is +507/-87; the writer's initial 50-line brief brought the candidate to 644 authored lines (additions plus deletions), within the advisory 450–700 forecast. Parent evidence expanded the brief to 54 lines, for 648 authored lines. Final diff check and working-tree inspection are reported in the handoff. No meaningful behavioral RED/GREEN applies to presentation-only work, and S5 explicitly defers suites/new tests. No browser, API/authentication, localStorage manipulation, fixture, data write, Save, staging, commit or publishing is performed by this worker.

## Spec disposition and parent gate

S1: opening removed with both exact functional sentences retained locally. S2: scoped explorer/action hierarchy implemented. S3: owner manually approved; local commit pending observation before advance. S4: applied skills reported below. S5: suites and mutation probes deferred. S6: accepted navigation adopted only for Clientes. S7: accepted vocabulary reused structurally; fresh visual comparison and final T9 remain pending, with no approved screen restyled.

Applied skills: Impeccable/Operate/craft-floor (task-first layout, native controls and bounded detector); redesign-existing-projects (incumbent diagnosis and in-stack changes); ponytail (existing controllers, no dependency or extra feature); cognitive-doc-design (scannable preservation/evidence/gate record).

Parent read the entire 644-line private inspector before one authenticated execution. `job-24` exited 1 after 19s: TimeoutError at `search-sentinel`. Eight actual 1440 captures and the failed JSON remain intact; zero business write attempts. At 1440, directory/selection, both actual past/future history cohorts with precise terms/time/ARS, native three-field create/edit local drafts, Cancel/reopen/focus, submitted actual-name search and desktop navigation passed. Six actual contrast samples passed, minimum 5.5298; no blanket certification.

Owner “si” authorized one separate bounded diagnosis/completion. New inspector syntax exited 0; parent read all 738 lines before `job-25`, which exited 1 after 4s at `edit-390/DOM-native-labels-fields-actions-fit`. Ten new exclusive captures/report preserve this separate failure. Empty-query response 200/zero rows/public GET agreement/visible message and attached zero-height UL prove the old visible-list wait unsuitable for this observed state, not the original failure's exact conditions. Whitespace reset and 1024 native create/edit/history/navigation passed. At 390, selection/readability/history/native edit/raw typing passed; strict per-control viewport bounds failed. Parent opened the failure PNG: all three fields/labels and Save/Cancel are visibly present, but individual rectangles were not recorded, so the precise measurement failure remains unproven. Thirteen actual contrast samples passed, minimum 5.5298; zero business writes/non-GET attempts.

Remaining 390 interactions, 320, five-screen preservation, final public DTO equality and fresh visual/S7 were not reached. Both failed reports/artifacts remain intact; no application correction or automatic retry. Owner chose manual approval with “yo lo vi bien, podes seguir”; no further measurement pass is requested. Stored uncertainty/recovery, submissions, mutation/domain outcomes and suites remain unexecuted. Local commit is authorized, not yet observed in this brief; T7 follows delivery, and final T9 remains pending. Initial 644-line footprint precedes parent evidence additions.

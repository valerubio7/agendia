---
version: 1
slug: "business-services"
primary_target: "apps/web/src/features/services/services-screen.tsx"
related_targets: ["apps/web/app/styles.css"]
---

# Servicios — editor beside the catalog

Operate, code-led; active T3/S1–S7 in `odd/tasks/business-ui-redesign.md`. The owner approved the reviewed candidate after its 714-line footprint and scoped verification limits were disclosed. Local Services delivery is authorized before Recursos; publishing remains unauthorized. Accepted Perfil and Turnos establish the business identity; the admin DESIGN and sidecar are not approval authority.

## Direction

- Remove only the opening description. Keep the functional Servicios heading and every field, help message, empty state and lifecycle consequence.
- At 64rem and wider, a 24rem four-field editor sits beside the readable catalog. Below that, the same mounted workspaces stack in native reading order. No modal, disclosure, new visibility lifecycle or sticky overlay.
- Warm paper, an ivory editor and white editable/catalog surfaces retain Source Sans 3, official branding and the accepted control radii. Name and textual state lead each catalog row, followed by actual description, duration, ARS price and actions. Rows share one catalog boundary, not nested cards; long content wraps without truncation.
- Coral with ink identifies create/save. Edit is outlined, suspend/reactivate are quiet secondary actions, and retirement/confirmation use danger. Honey carries duration and suspended-state context; pine carries focus, active/success feedback and text selection. State-only 160ms transitions yield to reduced motion. No fake metrics, filters, sorting, search or extra operations.

## Isolation and invariants

Horario also uses `services-screen` and legacy `services-*` classes. The parent approved narrowing after source inspection exposed that overlap. Every new local selector starts with `main.services-screen[aria-labelledby="services-title"]`. The entire shared legacy CSS, including the final 48rem override, remains untouched.

Navigation adoption adds only `main.services-screen:where([aria-labelledby="services-title"])` to each existing `:has(main.profile-screen, main.turnos-screen)` selector. The zero-specificity attribute qualifier preserves the old maximum branch specificity, old branches and all declarations, including mobile, focus and reduced motion. Horario does not match; shared shell markup and approved screens are unchanged.

Lines 1–141 remain byte-identical to `99b0e15e88f5a16ddc5ef079aea805c9f6533a31`. Presentation adds unconditional workspace/catalog and field wrappers only. The keyed uncontrolled form stays mounted in a stable position, with its original submit/busy/heading wiring, name ref, defaults and constraints. Name remains required implicit text; description remains optional with no cap; duration remains required, min/step 15, default 15 and its exact help; price remains required, min 0, step any, default 0. No maximum, new ID, reset, ownership or focus behavior.

All existing handlers, refs, keys, predicates, accessible names, value expressions and `ul`/`li`/`dl` semantics remain. Confirmations stay inline outside the disabled form fieldset; Cancel keeps its ref and focus restoration. Reactivation stays immediate. Save/lifecycle feedback, committed-write refresh warning and GET-only Actualizar catálogo remain distinct. The existing es-AR/ARS formatter retains 2–20 fraction digits. No API, LivePanel, domain, tenant, authentication, abort, storage or transport changes.

## Evidence and review boundary

The actual root `.impeccable/review/business-services-before-{1440,390}.png` captures were viewed as incumbent evidence: the tall editor delayed catalog scanning and all actions had equal green weight. They do not certify the new layout. Parent baseline job-14 reported unchanged public service DTOs and zero writes; no worker browser or data-changing action occurred.

Worker observations, before parent verification: `bun run typecheck` exited 0 with captured output `$ tsc -p tsconfig.json --noEmit`; `git diff --check` exited 0 with no output. The single detector command `cd apps/web && /home/valerubio7/.pi/agent/skills/impeccable/scripts/impeccable detect --json src/features/services/services-screen.tsx app/styles.css` exited 0: 44 advisory `design-system-color` findings in unchanged CSS at lines 108–3030, none in Servicios JSX or the appended local CSS. The tool combines streams, so separate stdout/stderr attribution is unavailable. S5 explicitly defers suites and mutation probes; no RED/GREEN, save/error/pending behavior, rendered overflow, measured contrast or browser focus outcome was claimed by the worker. Parent owns authenticated desktop/mobile inspection, comparison with accepted Perfil/Turnos and the S3 owner handoff. Final cross-screen T9 remains pending.

Applied skills (S4): Impeccable/Operate and craft floor for task-first hierarchy and bounded detector use; redesign-existing-projects for in-stack incumbent diagnosis; ponytail for native controls and presentation-only reuse; cognitive-doc-design for this scoped direction/invariant/evidence record. No context/init/seed/concept/comp/raster rerun or global design update.

A read-only TypeScript AST/source comparison exited 0 against the T2 commit: protected prefix, existing non-presentation JSX attributes, leaf expressions and functional text match. All 43 navigation qualifier additions are exact; reversing them restores the entire original stylesheet byte-for-byte before the appended block, including all shared legacy/48rem rules. Every appended local selector has the Services-only anchor. These are structural checks, not runtime behavior tests.

## Parent inspection

Parent source audit exited 0: the protected prefix matches baseline, reversing the 43 exact navigation branches restores all original CSS byte-for-byte, and shared logic/approved-screen sources are unchanged. Native assessment remained unassessable with untracked artifacts; its RDD-off writer-self-verification/no-separate-verifier plan was followed.

Authenticated read-only job-15 exited 0 in 7 seconds at 1440/1024/390/320. It observed native field/default/constraint contracts, edit values and cancellation, desktop columns/mobile stacking, navigation and no horizontal overflow. At 1440/390, suspension/retirement confirmation cancellation preserved disabled controls and returned focus to the actual opener. Mobile Enter/Tab menu access and logout visibility passed. No Save, Confirm or immediate Reactivate action was invoked.

All 20 sampled text/background ratios passed 4.5:1, minimum 5.53; this is not blanket contrast certification. Public Services/Profile responses stayed equal with zero business write attempts. Eighteen captures include current Profile/Turnos/Horario at desktop/mobile; none of those other screens matches the new Services-only scope. Empty/suspended, actual-save, pending/error/recovery and terminal-state outcomes remain unexercised.

S1 removes the opening paragraph; S2 reorganizes editing/scanning/actions; S3 retains the approval gate; S4 reports skills; S5 preserves test deferral; S6 adopts accepted navigation only for Servicios; S7 reuses accepted identity and palette roles without changing approved surfaces. Fresh visual/S7 review inspected 24 current/before/approved-reference PNGs and returned `ship`, with no material fixes. Native finishing roles were unavailable; the disclosed generic read-only substitute is not an independent technical verifier or owner acceptance. The subsequent owner approval authorizes local delivery of this coherent workspace before T4; it does not expand the deferred verification or certify unexercised states. No further styling batch is warranted from the captured evidence.

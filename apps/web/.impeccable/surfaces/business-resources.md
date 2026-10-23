---
version: 1
slug: "business-resources"
primary_target: "apps/web/src/features/resources/resources-screen.tsx"
related_targets: ["apps/web/app/styles.css"]
---

# Recursos — weekly editing beside the catalog

Operate, code-led; active T4/S1–S7 in `odd/tasks/business-ui-redesign.md`. The owner approved this 838-authored-line candidate with “aprobado segui”. Accepted Perfil, Turnos and Servicios establish the business identity. Parent owns local delivery; T5 activates only after the actual Recursos commit.

## Direction

- Remove only the opening description; retain the functional Recursos heading, all seven days and every functional explanation.
- At 76rem and wider, a 34rem editor sits beside the catalog. Weekly text controls need more room than Servicios' 24rem pane. Below that breakpoint the always-mounted editor and catalog stack in original reading order. No modal, accordion, sticky overlay, new visibility lifecycle or new action.
- Empty weekly days pair their existing Sin franjas text with Agregar franja, reducing vertical repetition without hiding controls. Added rows keep visible Inicio/Fin labels and text inputs; Quitar franja takes its own row on narrow screens. All help, including end-only 24:00 and overnight semantics, remains visible.
- Warm paper, ivory editor, white controls/catalog, Source Sans 3 and the official logo follow accepted references. Coral with ink marks create/save; outlined Edit leads quiet Suspend/Reactivate and danger Retire. Honey distinguishes schedule context and suspended status; pine carries active/success, selection and focus. State transitions are 160ms, removed for reduced motion.
- Actual identity/status, description, assigned services and weekly ranges remain readable without truncation. Catalog rows share one boundary with separators; the schedule disclaimer retains its starting-day, overnight, not-available-slots and date-closure meaning. No metrics, filters, sort, extra operation or availability claim.

## Isolation and protected contracts

Every new local selector starts with `main.resources-screen[aria-labelledby="resources-title"]`. Navigation adoption adds only `main.resources-screen:where([aria-labelledby="resources-title"])` to the 43 accepted Profile/Turnos/Services branches. The attribute qualifier has zero specificity; prior branches and declarations are preserved. Horario's shared weekly component/helpers and legacy resources-week/hours/day/row CSS remain unchanged. No shell, root token, font, logo, approved-screen, API, domain or LivePanel changes.

ResourcesScreen lines 1–165 stay byte-identical to `985ad2c4228ec474fce5b84c79e23fd84537b922`. Only presentation classes, unconditional wrappers and the authorized introductory paragraph change. The form retains its original key, submit/busy/heading ownership, disabled fieldset, name ref, defaults and constraints. Name remains required implicit text, description optional, neither capped. All supplied services, including suspended ones, remain selectable native checkboxes, without min/max/filter or status disablement. Checkbox geometry is explicitly excluded from full-width text-field styling. Unknown assigned IDs keep the existing catalog fallback; data is not repaired.

The original ControlledWeeklyScheduleEditor value/onChange/disabled props remain unchanged. Monday–Sunday order, span IDs/keys, controlled text/inputMode text/HH:mm fields, Add/Remove callbacks and serialization are untouched. Unedited raw descriptions, original service-ID order and raw schedules retain their submission preservation. Save/reset/focus and failure draft behavior are unchanged in source.

Inline confirmation, Cancel ref/opener return, consequences, Procesando text and immediate Reactivate remain intact. GET-only refresh recovery is outside the disabled form fieldset and never replays a write. Existing conditional predicates, handlers, roles, labels, refs, keys, expressions and ul/li/dl semantics remain authoritative.

## Evidence and review boundary

Viewed actual root `.impeccable/review/business-resources-before-{1440,390}.png`: the large full-width create form and seven tall empty days push the catalog below the fold; all actions have equal green emphasis. Suspended assigned-service text is already real content and is retained. Parent reports baseline job-17 exit 0 in 2 seconds, equal public Resource/Service DTOs and zero writes. This is incumbent evidence, not verification of the new render.

The available feature file ended at L36 when read; the parent task supplies the subsequent baseline result and explicit layout direction. No missing L37 content is invented. No context/init/seed/concept/comp/raster/global DESIGN regeneration occurred; existing PRODUCT, DESIGN/sidecar and accepted surface briefs were read without changing them.

Applied skills (S4): Impeccable/Operate and craft floor for task-first composition and bounded detector use; redesign-existing-projects for in-stack diagnosis; ponytail for presentation-only native-control reuse; cognitive-doc-design for this scoped direction/invariant/evidence record.

S1 removes the intro; S2 implements the local composition/action hierarchy; S3 stops before owner acceptance, commit or advancing T5; S4 names applied skills; S5 defers suites/mutation probes with no invented RED/GREEN; S6 adopts accepted navigation only for Recursos; S7 reuses accepted identity/palette without editing approved screens. Captured S7 consistency passed the fresh visual review below; the final cross-screen T9 remains pending.

Observed checks (one invocation each): `bun run typecheck` exited 0 within its 30-second limit, output `$ tsc -p tsconfig.json --noEmit`; `git diff --check` exited 0 with empty output. `cd apps/web && /home/valerubio7/.pi/agent/skills/impeccable/scripts/impeccable detect --json src/features/resources/resources-screen.tsx app/styles.css` exited 0 with 44 advisory design-system-color findings in unchanged CSS at lines 108–3030, none in Recursos JSX or appended CSS. Tool output combines streams; separate stdout/stderr attribution is unavailable.

The read-only inline Node/TypeScript AST and CSS audit exited 0: prefix lines 1–165 byte-equal, non-presentation attributes/expressions/text preserved, 43 exact nav additions, and all prior CSS restored byte-for-byte when those additions are reversed. Every appended selector is Recursos-qualified; checkbox geometry is separate. Tracked changes contain only the two authorized source/style paths; shared helpers, shell, API/domain/LivePanel, approved screens and Horario are unchanged. Two earlier audit runs exited 1 because the audit itself fell back to class text after removing class-only attributes, then overmatched the disabled-field color rule as geometry. Both audit defects were corrected without application changes; neither was a product test failure or a RED/GREEN cycle. One initial nonunique stylesheet edit was rejected atomically before writing, then corrected.

These worker static checks alone cannot certify runtime behavior. No implementation-worker browser/authentication/API/data-changing operation, fixture, staging, commit or publishing occurred.

Parent-owned read-only inspection `job-18` subsequently exited 0 in 9 seconds. `.impeccable/review/business-resources-inspection.json` lists 32 actual captures at 1440/1024/390/320: native field/checkbox contracts and geometry, seven visible text-controlled day groups, data-matching edited/catalog weekly values, edit/cancel reset, navigation/menu/focus, intended composition and no horizontal overflow passed. At 1440/390, local checkbox and weekly Add/Remove/22:00–24:00 draft changes were canceled; suspension/retirement confirmation locks, Cancel focus and actual-opener restoration passed. Twenty sampled contrast ratios were at least 5.5298, not blanket certification. Public Resource/Service/Profile DTOs remained equal and zero business write attempts occurred. Existing catalog content, including suspended assignment labels, was not reset or normalized. Profile, Turnos, Services and Horario preservation views were captured at 1440/390.

Fresh generic finishing substitute `mvl1jt3c-14-9zjo` opened all 32 current captures plus eight actual before/approved references and returned `disposition: ship`, with no material fixes. Native Impeccable finishing roles were unavailable. This is visual review, not independent technical verification or owner acceptance. Populated 320px controls/checkbox wrapping, action hierarchy and captured S7 coherence passed; the 1024px navigation wrap was an acceptable adaptation. Tall-image detail was supported by native viewport views. Development badges locally obscure parts of some captures; surrounding views remained sufficient for the visual disposition.

Suites, Save, Confirm, immediate Reactivate and asynchronous pending/error/recovery mutation outcomes remain intentionally unexecuted and uncertified under S5. S3 owner approval was received; local delivery is authorized before T5. No publishing is authorized. T9 is not completed by this screen's review.

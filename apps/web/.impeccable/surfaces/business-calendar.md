---
version: 1
slug: "business-calendar"
primary_target: "apps/web/src/features/business-calendar/business-calendar-screen.tsx"
related_targets: ["apps/web/src/features/business-calendar/business-closures-section.tsx", "apps/web/app/styles.css"]
---

# Horario — weekly hours and business closures

Operate, code-led; T5/S1–S7 in `odd/tasks/business-ui-redesign.md`, especially L41–L42. The owner approved the 690-authored-line candidate with “aprobado segui”. Parent owns local delivery; T6 activates only after the actual Horario commit.

## Direction

- Remove only “Consultá el horario semanal guardado para tu negocio.” Keep the functional heading and every scheduling, Argentina, business-wide, stale-data, empty-state and deletion explanation.
- Two flat operating areas group weekly editing/saved hours and closure editing/list scanning. At 76rem, a 34rem weekly area sits beside closures; tablet/mobile stack in source order. Both original conditionally mounted editors remain independent and can coexist. No modal, disclosure, hidden field, sticky overlay or extra operation.
- Warm paper, ivory weekly area, white closure area and native white controls follow accepted Perfil/Turnos/Servicios/Recursos. Source Sans 3, official logo and root tokens stay unchanged. Coral with ink identifies create/save, outlined Edit contrasts with quiet GET refresh, and danger identifies deletion/confirmation. Honey marks time context; pine marks focus/selection. State-only 160ms transitions yield to reduced motion.
- Seven saved weekdays retain their actual ranges or Sin atención. Weekly edit days retain all Add/Remove controls and the HH:mm, end-only 24:00 and overnight guidance. Saved summary remains visible while editing. No metrics, fake data, invented availability or nested cards.
- Native date/datetime controls keep their picker and keyboard access. Weekly text inputs keep visible Inicio/Fin labels; removal gets a separate row. At 360px and below those text controls stack. Repeated-hour radios retain native geometry and full label hit areas.

## Isolation and native preservation

Calendar lines 1–114 and Closures lines 1–181 are frozen against `a86db44b1e0e77095d9f0dbc1219c29286e2d13d`. Presentation adds only classes and unconditional, nonfocusable wrappers below those boundaries, plus the authorized intro deletion. Existing handlers, expressions, predicates, refs, keys, data attributes, form ownership and functional Spanish strings remain authoritative.

Weekly helpers/component and Argentina conversion helpers remain read-only. Preserve stable span allocation, Monday–Sunday order, controlled text/inputMode text/HH:mm fields, strict parsing, end-only 24:00 and overnight semantics. Untouched weekly submission still sends original raw data; null and saved-empty remain distinct. Each unchanged closure endpoint independently retains its original offset/precision. Changed wall times still use the existing Argentina converter, ambiguity choices and end-after-start rule.

Closure kind remains a controlled native select defaulting to date, with its useId label. Date remains required type=date. Intervals remain required datetime-local, step 0.001, without min/max. Radio names/keys/checked handlers remain unchanged, with no explicit value. Full-width text geometry excludes radio/checkbox controls; dedicated native radio geometry overrides legacy full-width input styling. No new constraints, IDs, names or form associations.

Forms retain refs, labels, busy/submit wiring, descendant Save buttons, button types, disabled predicates and Cancel callbacks. Section/heading refs, business-closures-title/tabIndex, list keys, action data attributes and inline confirmation group remain intact. Recovery controls remain outside forms/disabled scopes. There is no controller, focus, abort, request, lifecycle, validation, normalization or persistence change.

Every appended local selector starts with `main.services-screen[aria-labelledby="business-calendar-title"]`. Navigation adds only `main.services-screen:where([aria-labelledby="business-calendar-title"])` to the 43 accepted alternatives, preserving old branches/declarations and zero attribute specificity. Existing legacy/Servicios/Recursos CSS remains byte-identical after reversing those additions. Shared sources and approved screens are unchanged; no global DESIGN regeneration or administrative-composition approval is inferred.

## Evidence and checks

Viewed actual root `.impeccable/review/business-calendar-before-{1440,390}.png`: a large opening, left navigation, full-width stacked schedule/closures and equal green actions. Parent reports baseline job-20 exit 0/2s, equal public Calendar/Closure DTOs and zero business writes. This is before evidence only, never candidate verification. Read all four accepted surface briefs and their relevant CSS conventions. Referenced Recursos1440/Servicios390 image paths were absent in this worker checkout; no visual comparison with missing captures is claimed.

Observed once: `bun run typecheck` exited 0, output `$ tsc -p tsconfig.json --noEmit`. The single detector command was `cd apps/web && /home/valerubio7/.pi/agent/skills/impeccable/scripts/impeccable detect --json src/features/business-calendar/business-calendar-screen.tsx src/features/business-calendar/business-closures-section.tsx app/styles.css`: exit 0, 44 advisory design-system-color findings in unchanged CSS lines 108–3030, none in Calendar JSX or appended CSS. Tool output combines streams; separate stdout/stderr attribution is unavailable. The inline TypeScript AST/source and bounded CSS audit exited 0 after the audit-only correction below: frozen 114/181-line prefixes byte-equal; non-presentation attributes/raw inline callbacks, expressions/text, existing elements and descendant form-button ownership matched. All 43 nav additions reversed to the complete old stylesheet byte-for-byte; all 78 appended rules were Calendar-qualified. Text geometry excluded radios/checkboxes or targeted the shared component's text-only weekly rows; the explicit native radio reset remained separate. Other tracked source diff was empty. Final diff-check and workload are recorded in the implementation handoff.

One nonunique stylesheet replacement was rejected atomically before writing; the scoped replacement was corrected. The first inline audit exited 1 because its expected attribute list still included the authorized deleted introductory p. The audit was corrected to exclude that exact paragraph, then exited 0 without application changes. Neither tooling failure is a product-test failure or RED/GREEN cycle. No suites/new tests, browser/API/authentication, fixtures, data-changing actions, staging, commit or publishing occurred. S5 defers tests; presentation-only work has no meaningful deterministic behavioral RED/GREEN here.

## Spec disposition and parent gate

S1 removes the sole intro; S2 implements the local composition/action hierarchy; S3 stops before commit/advance for owner review; S4 reports applied skills; S5 preserves test deferral; S6 adopts accepted navigation only for Horario; S7 reuses accepted visual vocabulary without restyling approved screens. The bounded runtime inspection and captured visual S7 review below passed; final T9 remains pending.

Applied skills: Impeccable/Operate and craft floor (task-first composition, native controls, bounded detector); redesign-existing-projects (incumbent diagnosis and in-stack changes); ponytail (reuse existing controllers without dependencies/extra features); cognitive-doc-design (scoped, evidence-bounded review brief).

Parent read the full 522-line inspector, corrected desktop logout scope and the text-bearing contrast target before execution, and observed `node --check` exit 0. The single authenticated read-only `job-21` exited 0 in 11 seconds: `.impeccable/review/business-calendar-inspection.json` lists 32 actual captures at 1440/1024/390/320, empty issues and zero business write attempts.

Native weekly/date/interval defaults, constraints and form ownership; data-matching saved summary; all seven days; local Add/Remove text drafts; independent coexisting editors, cancellation/focus and original-state reopening; navigation/menu and document overflow checks passed. At 1440/390, unsaved historical input `2008-03-15T23:45:00.123` exposed four native required radios with independent choices and readable label hit areas. This is public UI draft evidence, not serializer/domain validation. Twenty actual text/background samples were at least 5.5298, not blanket certification. Calendar/Closure/Profile/Service/Resource DTOs remained unchanged. Eight preservation views cover the four approved screens at 1440/390.

Parent opened the desktop default, 320px interval controls and 390px ambiguity captures; native dates, milliseconds and options are readable there. Internal input metrics are informational only. The current closure list is empty: populated rows, existing-record edit and deletion confirmation remain unexercised, with no manufactured fixtures. Suites, Save/Confirm/Delete and asynchronous mutation/pending/error/recovery outcomes remain deliberately unexecuted and uncertified.

Fresh generic read-only finishing substitute `mvlahl8e-19-o5ug` opened all 32 current PNGs and ten actual before/approved references, returning `disposition: ship` with no material fixes or missing inputs. Native finishing roles were unavailable; this is visual judgment, not independent technical verification or owner acceptance. It confirmed complete native 320px interval fields, readable weekly/radio controls, accepted 1024px navigation wrapping and captured S7 consistency with all four approved screens. Local development badges partly obscure some views; complementary captures were sufficient.

Owner acceptance was received; local delivery is authorized before T6. No publishing is authorized. Final all-screen T9 remains pending.

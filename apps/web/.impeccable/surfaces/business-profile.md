---
version: 1
slug: "business-profile"
primary_target: "apps/web/src/features/business-profile/profile-screen.tsx"
related_targets: ["apps/web/app/styles.css"]
---

# Perfil — one editing workspace

Mode: operate. Scope: `/profile` only, T1/S1–S6 in `odd/tasks/business-ui-redesign.md`. Agent-selected implementation under delegated visual authority; not a user-locked concept or owner-approved system. Code-led. Existing official identity is fixed; admin composition is not a profile template.

## Direction contract

THESIS: One working form beneath horizontal navigation replaces both the left-hand wall and the static opening. Identity, description and address lead; refuse the invented information map and advisory rail.

OWN-WORLD: A shallow pine-deep navigation band retains the official inverse logo and its 32px height/clearspace. Warm paper surrounds an ivory workspace, white controls, pine strokes/focus and Source Sans 3. Compact rectangular corners and restrained dividers distinguish editing from decoration; coral remains an adverse-state signal.

STORY: Reach all eight existing destinations or logout without a vertical wall. Find the three existing labels, edit native fields, then explicitly save. Required versus optional information and limits stay visible; feedback belongs beside the action.

FIRST VIEWPORT: Desktop uses one horizontal brand/navigation/logout band, at least 92px tall, with naturally wrapping labeled links rather than clipped or hidden destinations. The redundant section topbar disappears only on Perfil. Below 64rem the inverse logo stays visible and the existing native Menú disclosure supplies eight destinations in two columns plus logout, in a bounded scrollable light panel. No DOM reordering or new controls. A 32px functional heading precedes the unchanged full-width fields and broad description canvas. The sole save action ends the workspace. Signature treatment: description text shares the other controls' inline-start inset; end padding limits writing measure without narrowing the control. Mobile retains 16px gutters and a full-width footer action. State-only transitions are 160ms and removed for reduced motion.

FORM: Parent-specified operational composition, agent-selected within the fixed boundary; no seed, concept tournament, comp or user-lock claimed. Light surfaces support reading and editing business information under ordinary daylight. No new visual world or global system change.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Preservation and review boundary

Keep the three uncontrolled fields, default values, labels/IDs/help relationships, native input kinds and limits (160/4000/500), required name, form ID, submit callback, busy state and pending button semantics. Fields stay editable while pending. No resets, remount keys, new operations or product claims. Parent feedback supplies alert/status roles. Shared shell markup/logic, root tokens, admin and the other business routes remain unchanged. S6 authorizes shell appearance changes only when the business shell contains `main.profile-screen`.

Parent owns authenticated 1440/1024/390/320 capture, read-only focus/interaction inspection and owner handoff. Existing `.impeccable/review/business-demo-profile.png` proves only the incumbent appearance. Native finish roles are unavailable; no review invocation or verdict is claimed here. Suites and mutation probes are deferred under S5. T1 remains an implemented candidate awaiting parent/owner review; no commit or T2 advance is authorized.

## Implemented candidate — source evidence, not visual approval

- S1: removed the entire static opening/map, numbered identity decoration and advisory rail; retained `Perfil del negocio` as the functional h1.
- S2: one ivory form, full-width name/address, white controls with deliberate pine/sand stroke, visible required/optional annotations, and a 12rem-minimum description canvas with 72ch writing measure and 1.7 line-height. Form cap includes gutters at 68rem; mobile uses 16px outer gutters and a full-width action. These are CSS observations, not measured rendered results.
- Preserved labels, help copy and IDs, native kinds/limits, uncontrolled defaults, form ID/onSubmit/aria-busy and explicit button form association. The three fields remain mounted and editable regardless of pending/feedback. Source wiring still supplies one save callback and alert/status feedback; no backend, auth or LivePanel edits.
- S3: implementation ready for parent review only; owner confirmation, commit and every later screen remain pending. No screenshots or shipping assets were created.
- S4: applied Impeccable (Operate, direction contract, craft floor and detector), redesign-existing-projects (incumbent diagnosis and in-stack replacement), high-end-visual-design (type, spacing and control finish only), ponytail (native controls, no extra state/dependencies), and cognitive-doc-design (scannable, evidence-bounded handoff).
- S5: no test-first cycle applies to this cosmetic composition; suites and mutation probes explicitly deferred. Before S6, `bun run typecheck` exited 0 with `$ tsc -p tsconfig.json --noEmit`; `git diff --check` exited 0 with no output. The single authorized detector invocation also predates S6: exit 0 with 44 advisory literal-color findings in unchanged CSS outside the then-profile block (then-lines 108–120 and 1089–2765); none targeted the profile component or profile CSS at that point. Out-of-scope findings were not changed. Typecheck/build/suites/detector are not rerun for the CSS-only S6 amendment.

The app-local DESIGN.md and sidecar remain the unchanged admin-only baseline: no global primitive/token addition or Profile approval is inferred. This brief records the profile-specific implementation; final authenticated captures, fresh finish disposition and any closing design metadata belong to the parent. Browser focus, overflow, contrast and mutation/pending/error behavior are not verified by static checks.

## S6 human scope amendment — navigation candidate

The human added S6: «recorda tambien modificar o cambiar la barra lateral izquierda que no me gusta». This supersedes the earlier appearance-preservation promise for the Profile shell only, not the other seven screens. It is not a new page, owner acceptance or authorization to advance T2.

The existing aside becomes a static horizontal desktop band: official inverse Brand, all eight original route links in DOM order, then the original logout button. Links wrap within their own flex area at constrained desktop widths. There is no scroll-only hidden navigation, unlabeled icon rail or fixed-height clipping. At widths below 64rem the same inverse Brand remains, while desktop links/logout are hidden and replaced by the existing native mobile disclosure and its own logout callback. The duplicate mobile brand and section label are hidden. The menu uses native disclosure markers, a two-column route grid, viewport-bounded width/height and vertical scrolling. Focus is paper on the dark desktop band and pine in the light mobile panel; current-page state retains the source `aria-current`.

Every new shell rule, including mobile, hover, focus and reduced-motion overrides, starts with `.authenticated-shell[data-variant="business"]:has(main.profile-screen)`. No shared component, form, route, asset, callback or root-token changes. Only this brief and profile-conditional CSS change in the amendment. Existing skills remain applied: Impeccable/Operate and craft floor, redesign-existing-projects, high-end-visual-design for precision rather than ornament, ponytail for CSS reuse of native shell DOM, and cognitive-doc-design for the bounded record.

Source inspection supports route/control preservation and other-page isolation. The worker amendment itself claims no browser, mutation, screenshot, mock, network operation, commit or acceptance.

## Parent review checkpoint

The parent observed `bun run typecheck` and `git diff --check` exit 0 after S6. Native assessment was unassessable because of untracked artifacts; with RDD off, its plan requires writer self-verification and no independent technical verifier. Shared shell/API/admin source remains unchanged, and the tracked UI diff is limited to the Profile component and stylesheet.

Authenticated read-only capture at 1440/1024/390/320 exited 0: eight route labels and logout available at each size, no document horizontal overflow, native mobile disclosure opens by Enter and Tab reaches Turnos. Form values matched the public profile response, limits remained 160/4000/500, name remained required and the save button retained its form association. Before/after public profile responses were equal; zero business write attempts occurred. This is not save/pending/error execution or owner acceptance.

Visual inspection found a desktop-only alignment issue: the description text began centrally rather than alongside the other field values. Parent polish retains the 72ch measure using inline-end padding and a shared 1rem inline-start inset. Final post-polish recapture exited 0 at all four widths: field text starts align within 1px, no document overflow, eight correct hrefs with only Perfil current, and keyboard entry into the mobile menu. Public profile stayed unchanged with zero business write attempts. Captures: `.impeccable/review/business-profile-{1440,1024,390,320}.png`, `business-profile-menu-{390,320}.png`, and `business-profile-focus-1440.png` in that directory. Final diff check exited 0. Fresh visual disposition: `ship`, from generic read-only substitute `mvjwjgpz-7-q5j7`; all seven valid captures inspected and no material fixes requested. The single wrapped WhatsApp destination at 1024 is the permitted unclipped wrapping adaptation. Parent recorded this scoped disposition because native finish roles are unavailable; this is not owner acceptance or a global DESIGN update. Owner approved this Profile candidate with «perfecto segui» after the visual handoff. S3 now permits its local commit followed by T2; each later screen still needs its own approval. This does not authorize publishing or globally applying the navigation. Suites, save/pending/error execution and a second detector remain unauthorized. Risk: none; only the requested Profile surface and its conditional shell appearance change.

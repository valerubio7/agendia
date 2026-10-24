---
version: 1
slug: "dministration-admin-businesses-screen-tsx-aa77a39d"
primary_target: "apps/web/src/features/administration/admin-businesses-screen.tsx"
related_targets: ["apps/web/app/styles.css"]
---

# Administration v2 — workspace, not sidebar

Mode: operate. Scope: admin `/businesses` only. The user explicitly REJECTED v1's sidebar, overall composition and default-looking fields. The prior DESIGN.md, sidecar and v1 captures described that rejected implementation, not an approved direction; the app-local baseline now records V2. Preserve official assets, Source Sans 3, root palette and product truth only. Visual choices below are agent-selected under explicit delegation, not user-locked concepts. Code-led; no image generation or fabricated comps/QUALITY BAR. Parent owns fresh independent visual review and finish documentation.

## Direction contract

THESIS: Two focused workspaces under one horizontal appbar. Refuse the one-route vertical sidebar, repeated page titles and directory/settings scroll pile.

OWN-WORLD: Pine-deep appbar with the official inverse lockup at its full clearspace; warm paper canvas and lighter working surfaces. Source Sans 3, aligned status columns and softened rectangular controls. White editable fields stand above tinted form ground, with deliberate strokes, inset edges and one pine focus outline. Coral means actual error or destructive action, never ordinary focus.

STORY: Enter Negocios, scan actual counts and written statuses, search/filter, then manage one account inline or open grouped creation. Switch to Configuración de IA for complementary context and timing; every inactive panel remains mounted and hidden so drafts survive. Global operation/refresh feedback remains outside both panels.

FIRST VIEWPORT: A roughly 91px horizontal brand wrapper and directly accessible logout; no hamburger or redundant topbar. Centered workspace capped at 1180px plus comfortable gutters. Administración title, true keyboard-operable tabs, then Negocios count and Nuevo negocio action. Search and a subordinate operational selector belong to the same light directory surface as aligned rows. Signature interaction: a selected row opens a full-width tinted workbench with Nombre, Credenciales and separately divided Estado operativo; on mobile labels, statuses and action stay adjacent. Creation groups business identity and user access, with one clear footer. AI leads editable context and pacing; read-only base instructions move to a secondary disclosure. Only state transitions, 160ms; reduced motion respected.

FORM: Parent's replacement composition is explicitly pinned; mode-operate.md read instead of a new concept tournament/seed. No new seed or user concept approval is claimed. Agent selects this implementation within those fixed constraints. Prior seed 3bf29304 belongs to rejected v1 and has no authority here. Light working surfaces suit an administrator reading/editing operational data in ordinary daylight.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Behavioral boundaries

Preserve runAction, pendingRef/anyPending, action identities and callbacks, native field constraints, direct ReplyPacingSchema/MAX imports, conditional successful field clearing and failed values. No backend/auth/shared-shell markup or business/login styling edits. No additional operations or fabricated records. Search/filter only supplied data. No suites or mutation probes per user; source inspection and read-only UI checks only. V2 screenshots are implementation evidence, not human acceptance or a functional approval. This documentation unit writes only `apps/web/DESIGN.md`, `apps/web/.impeccable/design.json`, `apps/web/PRODUCT.md`, this surface brief and `.impeccable/admin-direction.md`; no source or settings writes.

## V2 finish record

V1 is rejected history, including its earlier review and captures; V2 replaces it. User criticism of the sidebar, overall UI and default-looking fields remains the reason for replacement. The subsequent “retoma” / “segui” authorizes continuation under delegated visual authority, not a signed concept choice or acceptance. The six direction blocks above remain unchanged; no new seed, comp or user interview is claimed.

Fresh read-only generic UX reviewer `mviz4u4n-9-mefv` returned `disposition: ship`, `material_fixes: None` for V2. It independently read all ten valid captures and bounded source: `.impeccable/review/admin-v2-{1440,1024,390,320}.png` plus `admin-v2-{manage,create,ai}-{1440,390}.png` in the same directory. TYPE/MATERIAL/GROUND, appbar scaffold, directory, creation, management and AI match the contract; mobile adaptation and field quality materially address the rejection. No fixes were requested. Generic reviewer/documenter substitutions are explicit: no native reviewer invocation, human acceptance, independent live functional test or measured contrast is claimed. V1's review is not current V2 proof.

Completed V2 documentation: `apps/web/DESIGN.md` with source-grounded tokens and eight canonical sections; app-local `apps/web/.impeccable/design.json` v2 with eight primitives; and `apps/web/PRODUCT.md` with current workspace facts. The repository-root `.impeccable/design.json` remains stale historical context, untouched and out of scope. No public assets or shipping rasters were introduced; review PNGs remain evidence, not shipping assets, and old captures remain rejected history.

Parent-reported implementation evidence: writer and parent typecheck exit 0; final diff check exit 0. The writer's initial trailing-whitespace exit 2 was corrected, not left outstanding. V2 detector ran exactly once, exit 0, with 56 advisory color findings: 55 unchanged outside admin and one intentional pine inset shadow. That field edge is retained by design, not removed to silence the scanner; other pages were not repaired. Two writer read-only browser rounds exited 0, with no writes attempted. This documentation pass runs only inline structural validation and `git diff --check`, not those implementation checks again.

Suites and mutation/pending/error probes remain DEFERRED by user; source inspection and bounded visual evidence do not replace them. Parent reports RDD off with self-verification standing; the native candidate is unassessable because artifacts are untracked, not a review receipt or gate approval. No commits were made by this documentation unit.

## Scoped instruction-editor polish — writer handoff

The subsequent user request isolates ONLY “Indicaciones administrativas complementarias” and “Instrucciones base del recepcionista”; preserve every other V2 field, navigation, palette and behavior. The earlier V2 review predates these pixels and does not approve this change. No new seed, interview, editor library, toolbar, counter or instruction content is introduced.

Both native textareas now sit inside bounded document frames with their existing associated labels in separated tinted headers. Complementary instructions retain a white canvas and a quiet Editable/No editable state. Base instructions retain their native disclosure/readOnly contract with full-ink text on pine-soft/white (20%). Source Sans 3, 1.7 line-height, 72ch maximum writing measure, 24px vertical padding and 256px/448px minimum canvas heights improve long-copy reading. One pine outline belongs to the focused frame; no inner overlapping outline. Read-only hover is inert; pending disablement remains native and has paper/supporting-ink styling.

Writer visited the actual local UI before and after, via public login; one batched before inspection and one after confirmation at 1440px/390px. Eight live DOM field captures were opened: `.impeccable/review/admin-textareas-{before,after}-{editable,readonly}-{1440,390}.png`. Actual pixels show coherent label/header boundaries, comfortable canvases and readable base copy; mobile wraps labels/state without horizontal page overflow. Five untouched controls (search, operational selector and three pacing inputs) matched all 15 recorded computed-style properties at both widths. Both content hashes matched baseline (empty complementary context; 7716-character base copy), and browser names, labels, descriptions, rows, editable/readOnly and enabled state matched. Native vertical resizing remains; base copy scrolls and selection worked. Both frames showed one 2px pine focus outline/2px offset and no inner outline. Switching tabs retained the mounted base control. No configuration save, synthetic typing or non-login POST occurred. Pending/error/mutation behavior was source-inspected only, not exercised.

Static evidence: `bun run typecheck` exit 0 (`tsc -p tsconfig.json --noEmit`); `git diff --check` exit 0, no output. One manual detector invocation on the two source files exited 0, reporting existing advisory literal colors in CSS lines 108–3109 outside this polish. No advisory targeted the new editor styles; that is not a clean scan or visual approval. Intentional new styles use existing pine/white/sand/ink roles and local exact-ID overrides. App-local DESIGN and v2 sidecar describe only this editor refinement; earlier records remain historical.

Disposition: scoped writer implementation/visual readback complete; parent image/diff readback and human acceptance PENDING. Tests, suites, mutation/pending/error probes, commits and publication remain deferred. Review PNGs are evidence only; parent should commit code/docs, not captures.

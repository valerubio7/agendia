---
version: 1
slug: "business-whatsapp"
primary_target: "apps/web/src/features/whatsapp/whatsapp-screen.tsx"
related_targets: ["apps/web/app/styles.css"]
---

# WhatsApp — status beside the linking workspace

Operate, code-led; T8/S1–S7 in `odd/tasks/business-ui-redesign.md`, archived L62–L64 and current L65. The existing source-only presentation candidate is now manually owner-approved: “aprobado”. This is acceptance under S3, not verified design or runtime proof; local commit remains pending. The owner previously chose “Sí, código y revisión manual” / “Implementar únicamente la presentación, con controles estáticos; sin abrir WhatsApp ni consultar su API.” Seven accepted screens remain frozen; T9 stays pending until the observed approved commit.

## Direction

- Compact WhatsApp h1 retains whatsapp-title and its original section association; the main root still has no aria-labelledby. Remove only the opening descriptive marketing content and bridge illustration, plus the aria-hidden placeholder/check/diamond ornaments. Keep all functional status, confirmation, placeholder, instructional and security copy.
- Two coordinated flat areas replace nested elevated cards: current status and factual metadata share an ivory area; the existing linking workspace uses white. At 64rem they sit side by side; below that they stack in source order. No sticky pane, internal scrolling, hidden control, disclosure, overlay or new interaction lifecycle.
- Existing Source Sans 3, official shell logo and warm paper remain fixed. Coral with ink identifies the existing native link action; pine marks focus and the source-connected status. Neutral styling does not imply connection for unknown/disconnected states. Honey carries existing temporal-link context and the temporary-QR note; danger retains existing errors. No invented live/security claim, metric or label.
- Source order inside the same link section is header, original scan/confirmation/placeholder area, security note, SAME sole button, SAME ordered steps. The functional 01/02/03 sequence and all its content remain verbatim. No duplicate action, field, form, controller, modal, new state or focus management.
- Long factual values wrap without truncation. Step instructions form readable vertical rows at every width. Native button hover/active/focus/disabled styling uses state-only 160ms transitions with reduced-motion removal. These are source/CSS intentions, not measured rendered outcomes.

## Native preservation and isolation

Freeze lines 1–97 byte-for-byte against `1960dd1`: imports, types, status table/unknown resolver, date formatter/fallbacks, derived status, display-only linked-number trim and conditional buttonLabel. Return changes are presentation classes, authorized hero/ornament removal, compact h1 and same-button relocation only.

The single button retains its exact type="button", onClick={linkAction}, disabled={!statusDetails.known || connected || linking} and {buttonLabel}. No unknown/connected/linking enablement, new guard, retry or loading trigger. Feedback stays always mounted in its original root position. Dynamic badge role/status label, status dot and all IDs/ARIA remain authoritative.

Metadata keeps exact bdi handling, connected/nonconnected number fallbacks and both original date calls. QR wins over connected, then linking/idle placeholder: no predicate rewrite. The image keeps raw src={qrDataUrl}, exact alt/aria-label and intrinsic width/height 384. No appended image rule changes inherited responsive geometry, aspect, border/quiet-zone treatment, bitmap, encoding or helper options; no code clipping, stretching, overlay or recoloring is introduced. The existing caption and security note remain verbatim.

All new local rules start with `main.whatsapp-screen[data-ui="whatsapp-screen"]`. Navigation adds only `main.whatsapp-screen:where([data-ui="whatsapp-screen"])` to the 43 accepted business-shell alternatives, preserving zero attribute specificity, old alternatives and declarations. Reversing these additions restores ALL prior CSS bytes, including legacy WhatsApp, responsive/reduced-motion and seven accepted overrides. No font/token/brand/shared-shell/helper/API/domain/controller/provider edits.

## Authority and proof limits

No target incumbent capture or rendered evidence exists for this task. Only source, PRODUCT, seven accepted business briefs and existing CSS informed this implementation. Admin DESIGN is not business composition authority. Existing-world context/init/seed/concept/comp/raster/global DESIGN are not rerun or newly required.

No browser, Playwright/devtools, route render, screenshot, preview, server, API/auth/session/status/QR/provider/network call or app-internals execution occurred. No stored QR, linked number, provider payload, credentials or account capture was consulted or copied. There are no mocks, fabricated responses, fixtures or static mock previews.

Native mount/GET behavior remains untouched: a link-code read can delete expired codes and authenticated session reads can touch persistence. This presentation does not fix, bypass or certify those effects. Linking/unlinking/restart/new QR/messages/configuration/storage/data manipulation is unauthorized. Backend/security/controller discrepancies stay out of scope.

No actual before/after, rendered desktop/mobile fit, keyboard interaction, contrast, QR scanability, pending/error/connect outcome or runtime preservation proof is claimed. Source equality is not functional or visual certification. Owner manual approval is now observed under S3; local commit has not been performed. Approval does not certify these missing outcomes; no next-screen advance or T9 correction is performed.

## Observed static checks

- Once: `bun run typecheck` exited 0; output `$ tsc -p tsconfig.json --noEmit`.
- Once: `cd apps/web && /home/valerubio7/.pi/agent/skills/impeccable/scripts/impeccable detect --json src/features/whatsapp/whatsapp-screen.tsx app/styles.css` exited 0. JSON reports 44 advisory design-system-color findings in unchanged CSS lines 108–3030; none in candidate JSX/appended rules. Output combines streams; separate stdout/stderr attribution is unavailable.
- Read-only inline Node/TypeScript AST/source audit exited 0 on its first run: prefix97 equality; full return equality after only authorized class/hero/ornament/h1/relocation exceptions; sole raw button and native disablement; original section ownership; scan→security→button→same OL; conditional status/ARIA/dot; metadata/bdi/date fallbacks; QR precedence/image props; feedback mounting. No application helpers were imported or run.
- CSS audit exited 0: exactly 43 neutral navigation additions reverse to every old byte; all 52 appended rules are actual-root-qualified. No new image geometry, token/font, hidden-control, clipping, overlay or pointer-event restriction. Other tracked sources, HEAD and index are unchanged. Final diff/working-tree checks are reported in the handoff.
- One initial stylesheet edit was rejected atomically because a mobile-button selector also matched reduced motion. A more specific exact match succeeded without changing old declarations. This was an editing-tool rejection, not a failed product check. No static check failed or was retried.

Source/style footprint: +408/-107 = 515 authored lines, plus this scoped brief; final three-path total is reported in the handoff. The 450–750 forecast is advisory, not a cap or reason to split by file type. No scratch/cache or verification artifact was created.

## Specs, skills and manual gate

S1 removes the opening; S2 implements the pinned presentation hierarchy; S3 has observed parent static review and owner manual approval, with local commit pending; S4 reports skills below; S5 defers suites/new tests; S6 adopts accepted navigation only for WhatsApp; S7 reuses accepted vocabulary without editing accepted screens. Rendered S7 consistency and final T9 remain unverified/pending, not passed.

Applied skills: Impeccable/Operate/craft-floor (task-first composition, native state semantics, bounded detector); redesign-existing-projects (source diagnosis and targeted in-stack changes); ponytail (existing component/controller, no extra feature/state/dependency); cognitive-doc-design (answer-first, separated direction/preservation/evidence/gate).

No meaningful RED/GREEN applies to this presentation-only task; S5 and the source-only boundary explicitly defer tests/suites. No build, runtime probe, staging, commit, push or publishing occurred. Owner manual acceptance is observed as “aprobado”; local commit remains pending and no agent rendered verdict is claimed.

Parent static review read the entire render, brief, diff, appended CSS and relevant legacy cascade. Parent inline readback exited0: prefix97 byte-equal, sole raw native button unchanged, raw QR image props preserved, scan/security/button/steps order retained, all prior CSS restored byte-for-byte after reversing43neutral navigation additions, other tracked sources unchanged. Native assess was unassessable with untracked artifacts; RDD-off self-verification/no separate technical verifier plan followed. No browser/API/auth/QR/provider or app-internals call, no new source correction. At the initial handoff, static disposition supported owner manual review, not acceptance or runtime certification. Owner approval is now recorded in L65; it does not establish runtime certification, a performed commit or T9 completion. The initial571-line footprint precedes this parent evidence paragraph.

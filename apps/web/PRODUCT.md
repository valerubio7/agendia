# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Platform administrators manage registered businesses on `/businesses`. Business users have a separate authenticated workspace. Evidence: `src/shell/authenticated-shell.tsx`, `src/shell/live-panel.tsx`.

## Product Purpose

Agendia exposes business administration and business workflows including appointments, clients, services, resources, schedules, assistant settings and WhatsApp. Evidence: existing shell navigation and LivePanel route wiring; no positioning or commercial claims were confirmed.

## Capabilities and Constraints

The admin interface lists supplied business names, operational status, assistant status, WhatsApp status, creation timestamps and last technical activity. Administrators can create a business and its initial user, rename a business, replace a password, suspend or reactivate a business, and save platform-wide complementary AI context and reply pacing. Base receptionist instructions are read-only and changed in code. Complementary context does not replace system rules or tools and compliance is not guaranteed. Pacing changes do not rewrite scheduled waits. Evidence: `src/features/administration/admin-businesses-screen.tsx` and `src/shell/live-panel.tsx`.

The admin workspace separates “Negocios” and “Configuración de IA” through local keyboard-operable tabs, without changing route. Inactive panels stay mounted and hidden to retain drafts. The directory supports local name search and a native all/active/suspended operational selector with counts derived from supplied records. Account management expands inline; creation opens from “Nuevo negocio” and groups business data separately from user access. Closing creation or filtering accounts retains mounted drafts. Creation and technical timestamps remain available inside account management. Evidence: `src/features/administration/admin-businesses-screen.tsx`.

The AI workspace leads with editable complementary context and reply pacing; read-only base instructions are a secondary disclosure explicitly marked “Solo lectura”. Global operation and refresh feedback remain outside both workspace panels. The admin-only horizontal appbar preserves the official brand and direct logout, using qualified CSS without changing shared-shell markup. Evidence: the administration component and `app/styles.css` Admin workspaces block.

There are no admin callbacks for deletion, bulk operations, conversations, impersonation, assistant activation or WhatsApp linking. Mutation reconciliation and GET-only retry belong to the existing LivePanel action layer. Technical timestamps are formatted in es-AR and UTC; they do not measure customer engagement.

## Brand Commitments

Preserve the existing Agendia official assets, Source Sans 3 UI family and warm paper, pine and coral identity. Provenance: existing `app/styles.css`, `src/components/brand.tsx`, and the parent’s explicit admin-only redesign boundary.

## Operating Context

The user explicitly delegated visual decisions for the existing admin screen and requested removal of its introductory descriptive banner. This delegation is limited to admin composition, not a platform rebrand or new backend capabilities. Provenance: verbatim user request and parent handoff. This record captures code-proven facts and explicit scope, not an invented interview or product approval.

## Open Decisions

Product positioning, usage frequency, customer proof and requirements beyond the inspected administration workflow remain unconfirmed. No claims should be inferred from the local preview records.

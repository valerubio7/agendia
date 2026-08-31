# agendIA UI/UX foundation

> **Governing rule:** the current project is the functional source of truth. [`agendia_screens.html`](./agendia_screens.html) is only a partial reference for visual style and product identity.

Every capability that exists in the project must receive intentional visual treatment, even when it is absent from the HTML reference. Prototype ideas that the project does not support must not appear in production UI. See the complete [current screen inventory](./ui-screen-inventory.md) before designing or implementing a screen.

## Decision order

When sources disagree, use this order:

1. Current routes, domain validation, API behavior, and authorization rules.
2. The [screen inventory](./ui-screen-inventory.md), which translates current behavior into UI obligations.
3. The HTML reference for visual character and composition only.

Prototype sample businesses, people, phone numbers, dates, metrics, and marketing claims are examples, not requirements.

## Reading capability and UI status

Keep these layers separate whenever current UI trails the supported behavior:

| Layer | Meaning |
| --- | --- |
| Supported capability | Behavior available through current backend or client contracts. |
| Current web UI | Behavior visibly exposed or rendered by `LivePanel` today. |
| Production visual obligation | Intended treatment for a production UI; it is not a claim about current rendering. |

The main verified gaps are:

| Concern | Supported capability | Current web UI | Production visual obligation |
| --- | --- | --- | --- |
| Logout | The API and `ApiClient.logout()` support session logout. | `LivePanel` exposes no logout action or logout redirect. | Add a visible authenticated-shell action that invokes the existing capability, then returns the user to the existing `/` sign-in route on success. |
| Role denial | Current authorization contracts reject role mismatches safely. | `LivePanel` shows the safe role alert while persistent `Cargando panel…` content remains visible. | Replace the misleading loading content with a terminal denial presentation; do not change authorization semantics. |
| Invalid or suspended session | `UNAUTHENTICATED` client copy explains that the session expired or the business is suspended and asks the user to sign in again. | The copy is shown, but `LivePanel` does not navigate automatically. | Add an explicit action to the existing `/` sign-in route; do not imply automatic navigation already exists. |

See the [screen inventory](./ui-screen-inventory.md) for route-level obligations.

## Visual identity

### Color roles

The reference establishes a warm, editorial palette with high-contrast operational surfaces. Keep colors semantic and tokenized.

| Token role | Reference seed | Use |
| --- | ---: | --- |
| Ink | `#172620` | Primary text, dark shells, strong buttons |
| Ink secondary | `#213B31` | Dark-surface variation |
| Paper | `#F1EEE3` | Application canvas |
| Surface | `#FAF8F1` | Cards, fields, raised content |
| Surface secondary | `#F7F3E8` | Subsections and quiet metadata |
| Coral accent | `#FF6B49` | Primary actions, brand emphasis, active accents |
| Coral soft | `#FFE1D8` | Accent backgrounds; never error by default |
| Pine | `#2F6E52` | Success, connected/active states, focus emphasis |
| Pine soft | `#DDEBDF` | Success backgrounds |
| Sand | `#D9D2BE` | Borders and dividers |
| Mid | `#7D887F` | Secondary copy and metadata |
| Danger | `#C24B3A` | Errors and destructive/status-changing emphasis |
| Danger soft | `#F6E2DE` | Error backgrounds |
| Warning | `#A86618` | Attention and link-required states |
| Warning soft | `#F5E8CE` | Warning backgrounds |
| White | `#FFFFFF` | High-contrast details and field surfaces |

Verify accessible contrast in the final token implementation. A status must always include text and, where useful, an icon or shape; color alone is not meaning.

### Typography

| Role | Family | Principle |
| --- | --- | --- |
| UI and body | Inter | Neutral, readable controls and prose |
| Display and headings | Space Grotesk | Compact, confident hierarchy with restrained negative tracking |
| Technical metadata | JetBrains Mono | Dates, compact labels, identifiers, and uppercase eyebrows only |

Use a clear hierarchy: one page title, short introductory copy, section headings, labels, hints, then metadata. Body copy should remain comfortable at normal browser zoom; metadata must not become illegibly small.

### Spacing, radius, and shadow

- Use a consistent 4 px base rhythm, with 8, 12, 16, 20, 24, 32, and 40 px as the common steps.
- Prefer generous page and card spacing over dense control clusters.
- Use approximately 10–14 px radii for controls, 14–20 px for cards, and up to 28 px for major branded panels.
- Use thin sand borders to define most surfaces. Shadows remain soft and low contrast; reserve stronger elevation for temporary overlays.
- Group related fields tightly and separate unrelated sections clearly. Do not use decoration to compensate for weak information hierarchy.

## Composition

### Login

Use the reference's asymmetric split composition on wide screens: a dark branded story panel and a focused light form panel. Collapse to one column on narrower screens without placing marketing content before the form in a way that delays sign-in.

### Business workspace

Use a persistent desktop shell with brand, tenant context, and navigation to the real routes (`/profile`, `/assistant`, `/whatsapp`). The production shell must expose the existing logout capability as the visible action defined above; `LivePanel` does not currently expose that action. A top bar may reinforce current context. There is no business home/dashboard route.

Content uses a bounded central workspace, page introduction, then one or two primary columns. Forms may pair the main task with concise guidance, but guidance must collapse below the task on smaller screens.

### Administration

Use a distinct dark admin header and a wide operational table. Administration remains list-based and supports actions inline; it does not introduce a tenant detail route or summary dashboard.

## Status semantics

| Meaning | Visual treatment | Current examples |
| --- | --- | --- |
| Positive | Pine text/indicator on pine-soft | Business active, assistant active, WhatsApp connected |
| Neutral | Mid/ink on a quiet neutral surface | Assistant inactive, no technical activity |
| Attention | Warning on warning-soft | WhatsApp requires linking |
| Failure | Danger on danger-soft | Connection error, validation failure, authorization denial |
| Suspended | Neutral or danger according to context | Suspended business; status-changing admin action |
| In progress | Neutral animated indicator plus explicit text | Loading, saving, waiting for QR, waiting for connection |

Use the exact state vocabulary supplied by current behavior. Do not collapse `link_required`, `disconnected`, and `error` into one generic disconnected state.

## Interaction principles

- **Explicit commits:** profile, assistant, business creation, rename, password replacement, and status changes use explicit actions.
- **Visible pending state:** disable the initiating control while its request is in flight and keep its purpose legible.
- **Persistent context:** retain entered form values after a failed submission whenever current behavior permits retry.
- **Global feedback:** provide one consistent, prominent region for safe errors and success notices; associate field validation with its field when available.
- **Terminal role denial:** replace the current safe alert plus persistent loading content with a terminal denial presentation, without changing authorization behavior.
- **Session recovery:** preserve the current safe invalid/suspended-session copy and add an explicit action to `/`; current UI does not navigate there automatically.
- **Conflict recovery:** an assistant revision conflict is not a generic save failure. Explain that data changed and offer the existing reload-and-retry path.
- **Status-changing actions:** distinguish suspend/reactivate from ordinary edits. Do not add unsupported actions as companions.
- **Progressive disclosure:** show primary fields and status first; keep guidance and metadata secondary without hiding required capabilities.
- **No dead controls:** every visible control must map to current behavior. Decorative preview controls, help actions, and links do not ship unless supported.

## Responsive behavior

- Preserve the reference's wide, compact, and mobile progression around its 1050 px and 760 px composition changes; exact breakpoints may be adjusted during implementation testing.
- Collapse multi-column forms and WhatsApp layouts to one column before controls become cramped.
- A compact desktop rail may replace the full sidebar, but every label must remain available through accessible naming and clear active state.
- On mobile, replace the hidden sidebar with an accessible route mechanism. All real routes and logout must remain reachable.
- Allow the admin table to scroll horizontally while keeping row identity and actions understandable. Do not silently drop columns or actions.
- QR content must fit the viewport without losing scan quality or accessible alternative text.

## Accessibility baseline

- Use semantic landmarks, one primary heading, real labels, and keyboard-operable native controls.
- Show visible focus using the pine focus treatment with sufficient contrast.
- Announce errors as alerts, non-urgent success/progress as status, and loading state without repeatedly interrupting assistive technology.
- Connect hints and errors to their fields; do not rely on placeholders as labels.
- Maintain a minimum practical 40–44 px pointer target for primary controls.
- Respect browser zoom, text reflow, reduced-motion preferences, and logical reading/focus order.
- Give the temporary WhatsApp QR descriptive alternative text; surrounding instructions must explain the same task in text.
- Tables require headers and a usable narrow-screen strategy.

## Content tone

The production interface is Spanish and currently uses concise Argentine voseo. Keep language direct, calm, and non-technical:

- Describe business outcomes, not infrastructure.
- State what happened and what the user can do next.
- Avoid exposing secrets, provider internals, raw exceptions, or conversation content.
- Do not make unsupported claims about availability, completion, or system health.
- Keep labels stable across navigation, headings, forms, and feedback.

## Initial production component taxonomy

This taxonomy defines responsibilities, not implementation code.

| Group | Components | Responsibility |
| --- | --- | --- |
| Brand | Brand mark, wordmark, product lockup | Consistent identity on login and authenticated shells |
| Shell | Login frame, business shell, admin shell, top bar, responsive navigation, session menu | Route context, role separation, navigation, logout |
| Structure | Page header, section, card, split layout, form grid, guidance panel | Predictable hierarchy and responsive composition |
| Actions | Primary, secondary, quiet, status-changing, icon-only button | Clear priority, pending/disabled/focus states |
| Forms | Field, text input, password input, free-text area, checkbox/switch, hint, field error, action bar | Labels, validation, dirty/pending/error/success handling |
| Feedback | Global alert, status notice, loading panel, empty state, conflict notice | Safe and accessible application states |
| Status | Status badge, live indicator, metadata item | Text-first representation of domain states |
| Data | Responsive table, business row, inline row action group, timestamp | Admin inventory and actual inline management |
| WhatsApp | Connection summary, linking action, QR panel, linking instructions, expiry/retry notice | Full temporary linking lifecycle |

Create variants only when a current behavior requires them. Prefer a small set of composable primitives over screen-specific visual inventions.

## Extending the language beyond the reference

Use this sequence for project capabilities missing from the HTML:

1. Identify the exact field, action, state, validation, and authorization behavior in the [screen inventory](./ui-screen-inventory.md).
2. Reuse an existing semantic pattern: form section, status badge, inline row action, global feedback, or lifecycle panel.
3. Apply the same typography, spacing, radii, borders, and semantic colors.
4. Add hierarchy only to clarify risk or workflow; do not invent a new product concept.
5. Validate the extension beside reference-derived screens so it looks native.

Examples include placing profile `additionalInfo` with the other long-form knowledge fields; presenting assistant `personality`, `knowledge`, and `rules` as peer free-text sections; using a dedicated conflict notice for revision mismatch; and styling admin rename, password, and status actions as an inline operational group. The WhatsApp lifecycle extends the QR panel with waiting, refreshed, connected, expired, failed, and retry states without adding unlink.

## Recommended first vertical slice: login

Build the login route first because it exercises brand, typography, layout, fields, primary action, validation, pending state, safe error feedback, responsive behavior, and role-based navigation with limited domain surface.

Preserve current behavior:

- Route: `/`.
- Fields: required valid email and required password of at least 16 characters.
- Submit to the existing login behavior; do not change session or CSRF handling.
- Redirect `platform_admin` to `/businesses` and `business_user` to `/profile`.
- Show safe authentication/authorization feedback without revealing which credential failed.
- Do not show password recovery; it is not supported.

## Acceptance and review checklist

- [ ] Current code, not the HTML prototype, determines every visible capability.
- [ ] Supported contracts, current `LivePanel` behavior, and production visual obligations are not conflated.
- [ ] Logout is visible in the intended shell, role denial is terminal, and invalid/suspended sessions offer an explicit `/` sign-in action.
- [ ] Every item in the [screen inventory](./ui-screen-inventory.md) has an intentional visual state.
- [ ] No unsupported route, control, metric, or workflow is visible.
- [ ] Profile business hours and assistant tone remain free-text values.
- [ ] All required loading, empty, success, error, conflict, expiry, and denial states are represented.
- [ ] Status meaning is not conveyed by color alone.
- [ ] Keyboard, focus, announcements, labels, contrast, reflow, and mobile navigation are verified.
- [ ] Desktop, compact, and mobile layouts preserve every real action.
- [ ] Spanish content uses consistent labels and calm, actionable voseo.
- [ ] The login slice preserves validation, role redirects, and safe authentication behavior.

## Sources

- Visual reference only: [`docs/design/agendia_screens.html`](./agendia_screens.html)
- Functional UI and state handling: `apps/web/src/live-panel.tsx`
- Current web routes: `apps/web/app/page.tsx`, `apps/web/app/(admin)/businesses/page.tsx`, and `apps/web/app/(business)/*/page.tsx`
- Client contracts and safe feedback: `apps/web/src/api-client.ts`
- API authorization and current mutations: `apps/api/src/app.ts`
- Domain validation: `packages/domain/src/business-profile.ts`, `packages/domain/src/assistant-config.ts`, `packages/domain/src/administration.ts`, and `packages/domain/src/whatsapp/connection.ts`

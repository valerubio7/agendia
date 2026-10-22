---
{
  "name": "Agendia — admin V2 baseline",
  "description": "Admin-only workspaces inheriting the official Agendia identity; not a platform rebrand.",
  "colors": {
    "pine": "#2e6b4e",
    "pine-deep": "#12372a",
    "pine-soft": "#dfe9e1",
    "coral": "#ff6b49",
    "coral-ink": "#a83a1a",
    "danger": "#b33a1f",
    "danger-soft": "#f3d9d3",
    "paper": "#f3eee1",
    "surface": "#fcfaf3",
    "ink": "#1c2620",
    "ink-2": "#4c5b53",
    "sand": "#d8d0b8",
    "white": "#ffffff",
    "admin-stroke": "color-mix(in srgb, #12372a 32%, #d8d0b8)",
    "workbench": "color-mix(in srgb, #dfe9e1 30%, #fcfaf3)"
  },
  "typography": {
    "headline": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "2rem", "fontWeight": 650, "lineHeight": 1.2, "letterSpacing": "-0.025em" },
    "headline-mobile": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "1.75rem", "fontWeight": 650, "lineHeight": 1.2, "letterSpacing": "-0.025em" },
    "title": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "1.25rem", "fontWeight": 650, "lineHeight": 1.3 },
    "subheading": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "1.125rem", "fontWeight": 650, "lineHeight": 1.3 },
    "body": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontWeight": 400, "lineHeight": 1.5 },
    "label": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "0.9375rem", "fontWeight": 650 },
    "control": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "0.9375rem", "fontWeight": 650, "lineHeight": 1.3 },
    "field": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "1rem", "fontWeight": 450, "lineHeight": 1.4 },
    "supporting": { "fontFamily": "Source Sans 3, system-ui, -apple-system, Segoe UI, sans-serif", "fontSize": "0.8125rem", "fontWeight": 400, "lineHeight": 1.4 }
  },
  "rounded": { "action": "0.5rem", "field": "0.625rem", "workspace": "0.875rem", "status": "0.375rem" },
  "spacing": { "label-gap": "0.5rem", "unit": "1rem", "field-group": "1.25rem", "section": "1.5rem", "form": "2rem", "split": "2.5rem" },
  "components": {
    "button-primary": { "backgroundColor": "{colors.pine}", "textColor": "{colors.white}", "typography": "{typography.control}", "rounded": "{rounded.action}", "padding": "0.6rem 1rem" },
    "button-secondary": { "backgroundColor": "transparent", "textColor": "{colors.ink}", "typography": "{typography.control}", "rounded": "{rounded.action}", "padding": "0.6rem 1rem" },
    "button-danger": { "backgroundColor": "transparent", "textColor": "{colors.coral-ink}", "typography": "{typography.control}", "rounded": "{rounded.action}", "padding": "0.6rem 1rem" },
    "input": { "backgroundColor": "{colors.white}", "textColor": "{colors.ink}", "typography": "{typography.field}", "rounded": "{rounded.field}", "padding": "0.8rem 0.95rem" },
    "select": { "backgroundColor": "{colors.white}", "textColor": "{colors.ink}", "typography": "{typography.field}", "rounded": "{rounded.field}", "padding": "0.8rem 0.95rem" },
    "workspace-tab": { "backgroundColor": "transparent", "textColor": "{colors.ink-2}", "rounded": "0", "padding": "0.5rem 0.125rem 0.9rem" },
    "readonly-disclosure": { "textColor": "{colors.ink}", "padding": "1rem 0" },
    "instruction-editor": { "backgroundColor": "{colors.white}", "textColor": "{colors.ink}", "rounded": "{rounded.workspace}", "padding": "1.5rem max(1.25rem, calc((100% - 72ch) / 2))" },
    "workbench": { "backgroundColor": "{colors.workbench}", "textColor": "{colors.ink}", "padding": "1.5rem" }
  }
}
---

# Design System: Agendia — admin V2 baseline

## Overview

**Creative North Star: "The Warm Operations Workbench"**

A clear working surface, not a stack of decorative panels: a horizontal pine appbar frames warm paper, cohesive directory surfaces and deliberately finished white fields. Soft rectangular corners, readable labels and modest tonal depth distinguish editing from scanning without turning routine operation into a warning.

This baseline is admin-only. Evidence: `app/styles.css` root roles and Admin workspaces block, `src/features/administration/admin-businesses-screen.tsx`, and the existing shell/official assets in `src/shell/authenticated-shell.tsx` and `src/components/brand.tsx`. [PRODUCT.md](PRODUCT.md) supplies durable identity constraints, not a platform rebrand. Descriptive language is agent-written under delegated visual authority, not interview answers or human acceptance.

Sidecar tonal ramps are derived panel-only OKLCH previews with approximate hue/chroma, not a root CSS scale. Source color mixes retain their formulas with root variables resolved in the frontmatter; snippets stay live-bound with self-contained fallbacks.

**Key Characteristics:**
- Horizontal brand frame and focused local workspaces.
- Source Sans 3, persistent labels and finished white fields.
- Cohesive directory surface and tinted inline workbenches.
- Pine focus, explicit states and responsive reflow.

## Colors

### Primary
- **Operational Pine** (`pine`): primary actions, tab indicator, normal focus and positive states. `pine-deep` frames the appbar and deepens action hover; `pine-soft` marks open rows, counts, success feedback and text selection.

### Secondary
- **Identity Coral** (`coral`): inherited official identity accent, not a routine admin control fill. **Coral Ink** (`coral-ink`) marks destructive action and adverse/attention states, not normal focus.
- **Controlled Danger** (`danger`, `danger-soft`): error borders and soft error/suspended surfaces.

### Neutral
- **Warm Paper** (`paper`): canvas and non-editable field ground. **Ivory Surface** (`surface`): cohesive directory ground. **White** (`white`): editable fields and primary-action text.
- **Vegetal Ink** (`ink`) and **Supporting Ink** (`ink-2`): primary information versus help, neutral states and non-editable text.
- **Structural Sand** (`sand`): dividers and workspace borders. **Admin Stroke** (`admin-stroke`): the reused pine-deep/sand field and secondary-action stroke. **Workbench Tint** (`workbench`): the reused pine-soft/surface mixture under creation, management and AI editing.

**The Pine Focus Rule.** Normal admin field focus and action focus use pine; coral-ink remains a consequence/error signal. Written labels carry status meaning independently of color.

## Typography

Source Sans 3 serves headings, labels, actions and field text. The frontmatter records the observed heading, mobile heading, section/subsection, body, label, control, field and supporting roles, not a fabricated modular scale. Workspace tabs use (1rem) on wide screens and (0.9375rem) on mobile. Business names use (1rem, 650, line-height 1.35), becoming (1.0625rem) on mobile; status text uses (0.875rem, line-height 1.35).

Counts, numeric fields and technical timestamp values use tabular numerals. Admin numeric inputs explicitly use the body family, not the root numeric-field mono family. JetBrains Mono remains available elsewhere; Bricolage remains logo-only. Use the official inverse outlined lockup, not a reconstructed text logo.

## Layout

The existing sidebar DOM is restyled only for the admin variant into a horizontal, non-sticky appbar: (5.7rem) minimum height, pine-deep ground, official brand clearspace and directly accessible logout. The old route navigation and topbar, including its mobile menu, are hidden for admin; shared shell markup is unchanged. There is no admin hamburger or vertical rail.

The main border-box cap is (77.75rem), including (2rem) side gutters: working content is capped at (73.75rem / 1180px at a 16px root). Main padding is (2rem 2rem 4rem), with (1.5rem) gaps. Local tabs separate Negocios from Configuración de IA. The directory groups search, a (13rem) native operational selector, results and records within one surface; search is capped at (32rem). Rows use `2fr / 1fr / 1fr / 1.4fr / 6rem` with (1rem) gaps. Creation and management use two columns separated by (2.5rem); AI pacing uses three.

At (60rem) and below, directory columns tighten to `1.8fr / 1fr / 1fr / 1.4fr / 5.5rem` with (0.75rem) gaps, and pacing stacks. At (47.5rem) and below, search/selector, creation and management stack; rows become two-column summaries with visible state labels, full-width name/WhatsApp and adjacent management action. Main padding becomes (1.5rem 1rem 3rem); workspace interiors use (1rem). The horizontal appbar and logout remain. Below (22rem), the directory title yields its own row before the action. Long names wrap; help copy is capped at (75ch).

## Elevation & Depth

Shallow tonal layering makes fields and workspaces distinct: white editable controls sit above the workbench tint; the directory remains a single ivory surface. Reused workspace shadow is (`0 5px 18px rgba(18, 55, 42, 0.04)`); the intentional field inset edge is (`inset 0 1px 2px rgba(18, 55, 42, 0.06)`). Read-only and disabled fields remove that inset shadow. These treatments are source-grounded, not scanner-driven substitutions or a ban on other screens' depth.

## Shapes

Soft rectangular fields use the field radius; actions use the smaller action radius; outer working surfaces use the workspace radius. Count/operational-state badges and feedback use the compact status radius. Account rows share one outer directory boundary, not separate floating cards. Sand rules separate form footers, access state and technical metadata. Dots supplement written channel states; active/suspended operation also has a softly filled badge.

## Components

- **Buttons:** pine primary; transparent secondary with admin stroke; transparent coral-ink destructive action. Hover deepens primary, softens secondary, or fills destructive action. Press shifts (1px). Minimum height is (2.75rem); pending actions use a wait cursor and (0.6) opacity.
- **Inputs, textarea and selector:** white fill, admin stroke, inset edge, (3.125rem) minimum height and persistent labels. Editable enabled hover uses a pine border. Focus uses one pine outline (2px) with (2px) offset and a pine border; actions and summaries use pine (2px) with (3px) offset. Disabled fields use paper/sand/supporting ink, no inset, full opacity and a wait cursor. The two instruction editors use the dedicated pattern below instead of ordinary field styling. Textareas resize vertically.
- **Workspace tabs:** real `tablist`/`tab`/`tabpanel` relationships, selected-tab roving focus and a pine (3px) underline. Left/Right wrap; Home/End select the endpoints. Switching tabs changes local workspace, not the route. Inactive panels stay mounted and hidden, retaining drafts. Sidecar tab snippets demonstrate visual states only; application keyboard/state behavior lives in the component.
- **Directory and workbench:** native row disclosures keep written operation/assistant/WhatsApp states visible. Hover/open uses pine-soft and the SVG chevron rotates. Management unfolds on a tinted surface with named identity/credential forms, separately divided access action and UTC technical timestamps. Creation groups business data and user access with one explicit footer; opening focuses the name field and closing returns focus to its trigger.
- **AI editing and read-only disclosure:** editable complementary context and pacing lead a separate panel with save feedback/footer. Base instructions sit in a secondary native disclosure, explicitly marked “Solo lectura”. This is a read-only source reference, not another editable form.
- **Instruction document editors (only the two platform instruction textareas):** a bounded workspace-radius frame contains the actual associated label in a pine-soft/white (35%) header with a sand divider and (1rem 1.25rem) padding. Complementary instructions show a quiet “Editable” state, switching to “No editable” with native pending disablement. Their canvas is white; base instructions use pine-soft/white (20%) with full ink, never a disabled-looking wash. Both use Source Sans 3 (1rem, 400, line-height 1.7), (1.5rem) vertical padding and responsive horizontal padding `max(1.25rem, calc((100% - 72ch) / 2))`, limiting the actual writing measure without shrinking the frame. Minimum canvas heights are (16rem) editable and (28rem) read-only. Corners meet at the header divider; native resizing, scrolling and text selection remain. One pine focus outline belongs to the frame via `:focus-within`; dedicated exact-ID overrides remove the inner textarea outline/inset, leaving shared field rules unchanged. Only an enabled editable frame advertises hover. Disabled editing uses paper/supporting ink and the inherited wait cursor/full opacity. Existing labels, descriptions, values, rows and form behavior remain authoritative; no formatting toolbar or counter is introduced.
- **Feedback and pending:** global status/refresh feedback stays outside both panels; mutation errors stay beside their workspace. Success uses `role="status"`, errors use `role="alert"`; retry remains query-only. Native field constraints and source pacing validation remain. Empty-directory creation and no-match reset are distinct actions. These are source observations, not executed mutation/pending/error coverage.
- **Motion:** state-only (160ms cubic-bezier(0.2, 0.7, 0.3, 1)) background/border and chevron changes; reduced motion removes transitions. No entrance choreography is introduced.

## Do's and Don'ts

### Do:
- **Do** inherit the official assets, Source Sans 3 and fixed paper/pine/coral identity.
- **Do** distinguish white editable fields from muted read-only/disabled fields, with one pine focus treatment.
- **Do** keep directory controls cohesive, workspaces mounted and mobile labels/actions adjacent to their records.

### Don't:
- **Don't** restore a vertical admin rail, redundant topbar or descriptive hero in this baseline.
- **Don't** reuse coral as ordinary admin focus or make a read-only field advertise editable hover.
- **Don't** promote admin composition into platform-wide rules or infer unsupported actions, engagement metrics or human acceptance.

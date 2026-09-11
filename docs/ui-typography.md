# UI typography

Squig's interface uses Geist. The shared tokens in `app/globals.css` set both
size and line height; use the role that fits the content rather than a local
pixel size. The same tokens work inside portals and in `components/agent/agent.css`.

| Role | Size / line height | Use |
| --- | --- | --- |
| `text-micro` | 12 / 16px | Shortcuts, counts, field prefixes, timestamps, supporting metadata |
| `text-label` | 13 / 20px | Labels, values, buttons, panel copy, tooltips, library names |
| `text-row` | 14 / 20px | Menu items, search results, panel titles |
| `text-title` | 16 / 24px | Dialog headings, command search |

12px is the minimum for interface text. Keep ordinary labels and values at
normal weight, actions at medium, and section/panel/dialog headings at
semibold. Use sentence case and normal tracking. Shortcuts use the same sans
face; code, configurations and technical identifiers use `font-mono`. Numeric
fields and counters use tabular numerals.

Use `text-foreground` for primary content and `text-muted-foreground` for
secondary content. Do not fade secondary text again with opacity. Disabled
controls can retain their disabled treatment. Canvas ink swatches preview
document colors and are separate from UI text contrast.

Controls use `h-ctl` (36px), nested segments `h-ctl-sm` (28px), and menu/search
rows `h-ctl-lg` (40px). Panel gutters are 16px, row gaps 12px, and the label
column 72px. Let longer names wrap and give menus a scrollable viewport;
do not shrink text to fit a fixed box.

Document text, sketch previews, and the wordmark have their own typography.
The documentation pages use 16px body copy and larger editorial headings.
Changing interface tokens must not resize the wireframes people have drawn.

For a typography change, review the page and selection inspectors, library,
file/context menus, command palette, keyboard sheet, tooltips, agent popovers,
and documentation. Check a laptop viewport and a short/narrow viewport, including
scrolling to the final menu item. `/kitchen-sink` shows the library's document
rendering alongside UI labels, so both can be checked together.

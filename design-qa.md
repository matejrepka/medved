# Warning scroll cue QA

Source visual: `output/design/warning-scroll-refined.png` (1487 × 1058 pixels).
Implementation: `http://127.0.0.1:3002/?theme=light`.
Desktop screenshot: `output/design/warning-scroll-desktop.jpg` (1473 × 1045 pixels; browser CSS viewport 1488 × 1056).
Mobile screenshot: `output/design/warning-scroll-mobile.jpg` (natural browser viewport, 366 × 668 CSS pixels).
Full-view comparison: `output/design/warning-scroll-comparison.jpg`.
Focused comparison: `output/design/warning-scroll-detail-comparison.png`.

## Scope and state

Compare the revised scroll cue only: a small clickable message with a separate close button above a circle containing two downward chevrons. The existing full-screen map and warning lists are intentionally retained. The concept image shortens the map to present the list simultaneously; this surrounding presentation layout is outside the requested control change. Live report data also differs from illustrative mock content.

The screenshots show the light theme with the message visible and the map loaded. Full-view comparisons fit each image into a 744 × 528 panel without stretching. Focused comparison crops the source and implementation at their original captured resolution. The desktop browser screenshot has soft text from scaling the large viewport into the narrow app panel; the natural mobile screenshot provides readable evidence of the control.

## Findings

No actionable P0/P1/P2 differences remain within the requested component.

- Fonts and typography: existing Hanken Grotesk UI, 13px message and clear library icons. Copy stays on one line at the tested mobile width. Existing page heading fonts are preserved.
- Spacing and layout: 44px message/close targets, 10px separation and 48px circular arrow. Centered horizontally; raised above the mobile status bar and bottom navigation. Dismissal retains the arrow's 32px desktop offset from the map bottom.
- Colors and tokens: existing surface, forest-green accent, ink and border variables; theme-aware values retained.
- Assets: existing map tiles and bear mark; Phosphor caret-double-down and x icons. No raster imitation of interactive controls.
- Copy: exact message “Konkrétne varovania pod mapou”; arrows have no visible text. Both links have accessible names, and the close button states its purpose.

## Interactions and checks

- Message click reaches `#aktuality` and focuses the warning section.
- Arrow click after closing the message still reaches `#aktuality`.
- Close click hides only `#mapScrollMessage` and moves focus to the arrow without changing its position relative to the map.
- Links work as native anchors; the close button is exposed only after its handler initializes.
- The cue waits for startup to finish; map failure can still expose it as a route to the list.
- Gentle three-cycle icon nudge and smooth scrolling are enabled only for users without a reduced-motion preference.
- Browser error logs were empty during the tested interaction flow.
- `npm run check` passed, including JavaScript, inline-script and SEO checks. `git diff --check` passed.

## Comparison history

Initial capture included the temporary startup screen. Recaptured after the startup element became hidden, compared the full view and focused component together, and verified the component against the source. Added visibility gating during startup and checked the final loaded page. Natural mobile capture was refreshed after the data-loading banner disappeared.

## Follow-up polish

No required follow-up. Dark-theme and reduced-motion behavior use the existing CSS tokens and media preference, but were not independently browser-emulated in this pass.

final result: passed

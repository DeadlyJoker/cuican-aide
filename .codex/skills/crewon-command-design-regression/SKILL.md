---
name: crewon-command-design-regression
description: Use when fixing CrewON command workspace visual regressions, design artifact mismatches, fullscreen layout issues, flicker, sidebar alignment, shell view interactions, or artifact-to-React runtime parity in apps/crewon-ui.
---

# CrewON Command Design Regression

Use this skill before changing or validating the CrewON command workspace in `apps/crewon-ui`.

## Required Inputs

Read these files before making a UI decision:

- `artifacts/desktop-command-home-scene-update/desktop-command.html`
- `artifacts/desktop-command-home-scene-update/desktop-command.css`
- `artifacts/desktop-command-home-scene-update/desktop-pages.css`
- `artifacts/desktop-command-home-scene-update/app.js` when behavior, filters, modals, palettes, or shell view switching are involved
- `apps/crewon-ui/src/components/app/CommandWorkspace.tsx`
- `apps/crewon-ui/src/styles/app.css`
- `apps/crewon-ui/src/styles/original-shell-overrides.css`

## Regression Lessons

- Do not judge only by static DOM. The original design depends on runtime behavior for shell views, filters, modals, palettes, sidebar tools, office/workflow rooms, and card visibility.
- Avoid executing the whole artifact `app.js` inside React. It rewrites sidebar DOM, reads persisted sidebar state, dispatches broad document handlers, and can fight React state, causing visible flicker.
- Prefer scoped React-owned parity runtime inside `CommandWorkspace`: shell view switching, `data-filter-group`, `[data-card-filter]`, `[data-open-modal]`, enhanced selects, slash/context palettes, sidebar search, and workspace tree.
- When making the design fullscreen, update both `app.css` and `original-shell-overrides.css`; the latter is imported after `app.css` and can override window size, radius, margins, and page widths.
- Fullscreen page views must not keep centered max-width rules from the floating mockup. For shell pages, `.page-stack` should use `width: 100%`, `max-width: none`, and `margin: 0` unless the artifact specifically requires a centered composition.
- If a page looks empty after fullscreen conversion, inspect computed layout first. Common causes are max-width centering, large left/right page padding, hidden cards from stale filters, or the wrong active shell view.
- Flicker usually comes from DOM replacement after async platform data, double-running design runtime, or repeated enhancement observers. Check `designHtml` dependencies, runtime boot effects, and MutationObserver loops.
- If the user reports fixed-interval flicker such as every 2-3 seconds, do not assume it is visual CSS first. Check parent component re-renders, polling intervals, connection-status updates, and whether React effects rebind document or root event listeners on every prop change.
- Keep `dangerouslySetInnerHTML` stable for the command shell. Platform data should not be a dependency of the full design HTML unless the task explicitly requires replacing the whole shell.
- If shell navigation works briefly and then jumps back after a backend read or parent re-render, suspect React reapplying `dangerouslySetInnerHTML` over DOM state. Prefer initializing the imported design DOM once and treating it as a scoped non-controlled shell while React owns event handlers.
- Long-lived design runtime handlers should read mutable values from refs instead of depending on frequently changing props such as `composerValue`, `isSending`, or connection callbacks. Rebinding those handlers can cause visible focus/hover/palette jitter even when the DOM tree itself is stable.
- Before declaring flicker fixed, capture both DOM and visual evidence: sample active shell view, root HTML length, important `hidden` states, and repeated screenshots over at least 6-8 seconds.

## Implementation Checklist

1. Reproduce the issue in the browser at the exact hash, for example `/#view-team`, `/#view-schedule`, or `/#view-command`.
2. Compare against the artifact page for the same hash.
3. Use browser computed style checks for:
   - `.command-window` width, height, border radius, shadow
   - `.sidebar-brand`, `.sidebar-tools`, and header search positions
   - `.page-stack` width, max-width, margin, and x position
   - active `[data-shell-view]`, active `.filter-chip`, and visible `[data-card-filter]`
4. For flicker, sample for 6-8 seconds before editing:
   - active shell view and active sidebar nav
   - `.screen-shell.command-screen` HTML length
   - important `hidden` states such as palettes, modals, and office rooms
   - screenshot hashes or visual screenshots
   - after clicking sidebar targets, verify the selected view stays selected after async platform reads complete
5. Fix behavior in `CommandWorkspace.tsx` when state or interactions are wrong.
6. Fix layout in both `app.css` and `original-shell-overrides.css` when fullscreen shell styles are wrong.
7. Keep real agent-platform data limited to approved design slots; do not replace primary artifact copy unless explicitly requested.

## Validation

Always run:

- `pnpm --filter @crewon/ui test -- CommandWorkspace`
- `pnpm --filter @crewon/ui build`

Browser-check the affected hash after changes. For fullscreen changes, confirm:

- `.command-window` matches viewport size
- no visible mockup gutter or floating-window radius remains
- `Crewon v0.2` aligns with the sidebar tools
- page content uses the available width without leaving an artificial left blank band
- no flicker occurs after platform data loads, parent re-renders, or after switching shell views
- event listeners for shell runtime are not rebound by routine composer or connection-status updates

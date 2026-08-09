---
name: "design-studio"
description: "Design and deliver high-fidelity visual artifacts as self-contained HTML, then render and audit them as real evidence. Use when the user asks for a UI mockup, landing page, interactive prototype, dashboard, slide deck as HTML, wireframe, design exploration, visual direction, design system, component states, or a design review - including requests phrased as 做个页面, 设计一版, 出几个方向, 看看视觉效果, 做个原型, 评审这个设计. Also use to screenshot or PDF-export an existing HTML page, or to audit a page for contrast, accessibility and visual quality. Do not use for generating bitmap images from a prompt (use imagegen), for production framework code, or for Word/PowerPoint deliverables (use office-suite)."
---

# Design Studio

Design in HTML, render it, look at it, then judge it. An artifact you have not
rendered and inspected is not a design deliverable — it is untested markup.

The loop is: **understand → acquire context → build → render → audit → look → iterate**.

## Toolchain

Scripts live in `$CODEX_HOME/skills/.system/design-studio/scripts/`. Set
`DESIGN=$CODEX_HOME/skills/.system/design-studio/scripts` (fall back to
`$HOME/.codex/skills/.system/design-studio/scripts`).

| Task | Command |
|---|---|
| Full-page screenshot | `python3 $DESIGN/render_design.py a.html --png out/a.png --width 1440` |
| Fixed viewport | `python3 $DESIGN/render_design.py a.html --png out/m.png --width 390 --height 844` |
| All four breakpoints | `python3 $DESIGN/render_design.py a.html --responsive out/shots` |
| PDF export | `python3 $DESIGN/render_design.py a.html --pdf out/a.pdf` |
| Quality + a11y audit | `python3 $DESIGN/audit_design.py a.html --width 1440` |

Rendering uses a headless Chromium found automatically (Playwright's cached
`chrome-headless-shell` first, then PATH, then installed browsers). No npm install,
no Playwright runtime, no Python dependencies. Override with `CREWON_CHROME=/path`.

Omitting `--height` produces a true full-page capture: the document height is
measured first, then captured in one pass.

**After rendering, view the PNG.** Do not report a design as done from the audit
output alone — the audit catches measurable defects, your eyes catch the rest.

## Workflow

1. **Understand the ask.** Surface, audience, device, tone, and whether they want
   one refined direction or several explorations. If they said "几个方向", produce
   3 genuinely different directions, not one design in three colors.
2. **Acquire design context before designing.** In this order:
   - an existing design system in the repo (tokens, Tailwind config, a component
     library, CSS custom properties) — reuse it, do not invent alongside it
   - a brand the user named — match its actual system, not a vague impression
   - otherwise pick a system from `references/design-systems.md` and say which
3. **Build a self-contained HTML file.** One file, inline `<style>`, no build step,
   no external network requests. `references/artifact-patterns.md` has the
   scaffolds for each artifact type.
4. **Render.** `--responsive` for anything that ships on multiple devices.
5. **Audit.** `audit_design.py` must exit 0 before you present the work. It checks
   contrast, accessible names, labels, heading order, horizontal overflow, and the
   "AI slop" markers listed below.
6. **Look at the screenshot.** Check the things a script cannot: is the hierarchy
   readable at a glance, is the spacing rhythm consistent, does anything look
   accidental.
7. **Report** with the artifact path, the render paths, the audit result, the design
   decisions you made, and what you deliberately left out.

## The quality bar

These are the failure modes that make generated design look generated. Treat each
as a hard rule.

**Use real components, not glyph substitutes.**
- Icons: inline SVG (Lucide/Heroicons paths) or a real icon font. Never an emoji
  standing in for an icon, never `→` as a button affordance.
- Charts: real SVG with computed geometry from the actual data. Never a bar made of
  `█` characters, never a fake sparkline made of dashes.
- Layout: CSS grid/flex. Never unicode box drawing to fake a table or a frame.
- Controls: real `<input type="checkbox">`, `<select>`, `<button>`. Never a styled
  `<div>` where a semantic control belongs.

**Hierarchy must be decisive.** One clear focal point per view. If three things
compete for attention, none of them wins. Vary size, weight and color in service of
one reading order.

**Spacing on a scale.** Pick a 4px or 8px base and stay on it. Arbitrary values
(13px, 27px) are the clearest tell of unconsidered layout.

**Type on a scale.** 4–6 sizes maximum for the whole artifact. Set line-height by
role: ~1.2 for display, ~1.5–1.6 for body. Body text at 60–75 characters per line.

**Color with intent.** One accent, used for one job. Neutrals carry the structure.
Never more than three hues unless the artifact is explicitly about color.

**Cover the real states.** Any interface with data has: default, loading, empty,
error, and a dense/overflow case. A mockup showing only the happy path with three
tidy rows is not a design — it is a screenshot of an assumption. Show at least
empty and overflow.

**Depth sparingly.** Shadows communicate elevation, not decoration. One or two
elevation levels. Do not stack blur, gradient and shadow on the same surface.

**Real content.** Plausible names, realistic lengths, actual numbers. Lorem ipsum
hides every layout bug that long strings expose.

## Producing multiple directions

When the ask is exploratory, vary along real axes, not surface color:

| Axis | Direction A | Direction B | Direction C |
|---|---|---|---|
| Layout | dense/data-first | spacious/editorial | modular/card-based |
| Type | geometric sans | serif display + sans body | mono-accented |
| Visual intensity | flat/restrained | layered with depth | high-contrast/expressive |
| Motion | none | subtle transitions | expressive |

Write each as its own file (`direction-a.html`), render all of them, then state the
tradeoff for each in one sentence. Do not silently prefer one.

## Design review mode

When asked to review rather than create, stay read-only:

1. `audit_design.py --width 1440` and again at `--width 390`
2. `render_design.py --responsive` and inspect every breakpoint
3. Report findings prioritized P0/P1/P2 with the exact selector and the measured
   value (`3.12:1 at .badge, needs 4.5:1`), not an impression
4. Do not implement fixes unless asked

## Failure handling

- `error: no Chromium/Chrome binary found` — tell the user to install Chrome or run
  `npx playwright install chromium`, or set `CREWON_CHROME`.
- A full desktop Chrome install can stall under `--headless=new` when a profile is
  active; the scripts already prefer `chrome-headless-shell` for this reason. If a
  render hangs, point `CREWON_CHROME` at a headless shell binary.
- `--pdf` with landscape: Chrome has no landscape flag. Put
  `@page { size: A4 landscape; }` in the artifact CSS.
- Audit reports `contrast` failures on an accent color — the accent is text-unsafe.
  Darken it for text and keep the original for fills; `references/design-systems.md`
  shows this split (`--accent` vs `--accent-fill`).
- Web fonts will not load (no network in headless render). Use system font stacks,
  or embed the font as base64 if the typeface is essential.

## Reference map

- `references/artifact-patterns.md` — HTML scaffolds per artifact type
- `references/design-systems.md` — reusable system profiles with tokens
- `references/quality-checklist.md` — the pre-delivery checklist

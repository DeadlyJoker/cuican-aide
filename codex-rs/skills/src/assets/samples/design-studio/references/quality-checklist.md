# Pre-delivery checklist

Run through this before presenting any design artifact. `audit_design.py` covers the
mechanical half; the rest needs you to look at the render.

## Automated (must pass)

```bash
python3 "$DESIGN/audit_design.py" artifact.html --width 1440   # exit 0
python3 "$DESIGN/audit_design.py" artifact.html --width 390    # exit 0
python3 "$DESIGN/render_design.py" artifact.html --responsive out/shots
```

The audit fails on: text contrast below AA, `img` without `alt`, form control
without a label, button/link without an accessible name. It warns on: heading order
jumps, missing `h1`, missing `lang`, missing viewport meta, emoji-as-icon, unicode
box drawing, placeholder copy.

Warnings are not automatically acceptable. Each one is either fixed or explained.

## Visual (look at the PNG)

- [ ] One focal point. Squint at the screenshot: what you see first should be what
      matters most.
- [ ] Spacing sits on the 4/8px scale. No 13px, no 27px.
- [ ] 4–6 type sizes total, not nine near-identical ones.
- [ ] Alignment is intentional. Edges line up across sections.
- [ ] One accent doing one job. Neutrals carry structure.
- [ ] At most two elevation levels; no blur+gradient+shadow stacked on one surface.
- [ ] Body measure is 60–75 characters, not full-bleed 140.

## Content

- [ ] Real content. No Lorem ipsum, no `TODO`, no `示例文本`.
- [ ] At least one deliberately long string and one zero/empty value present, to
      prove the layout survives them.
- [ ] Numbers are plausible and internally consistent (percentages sum, totals add).
- [ ] Language matches the request throughout, including button labels and empty
      states.

## States (any interface with data)

- [ ] Default
- [ ] Empty — with a next action, not just "无数据"
- [ ] Loading — skeleton or spinner with `aria-busy`
- [ ] Error — with a recovery path, `role="alert"`
- [ ] Overflow / dense — long text, many rows, truncation behaviour visible

## Responsive

- [ ] 390px: no horizontal overflow (the audit reports the exact overflow px)
- [ ] 390px: touch targets ≥ 44px
- [ ] 834px: layout reflows rather than shrinking text
- [ ] 1920px: content is capped, not stretched edge to edge

## Accessibility beyond the audit

- [ ] Semantic elements: `nav`, `main`, `header`, `button`, `table` with `th`
- [ ] Heading order is a real outline, not chosen for size
- [ ] Focus is visible (`:focus-visible` ring present in the base scaffold)
- [ ] Information is never carried by color alone — status gets an icon or a label
- [ ] `prefers-reduced-motion` respected wherever animation exists

## Components are real

- [ ] Icons are SVG, not emoji
- [ ] Charts are SVG computed from data, not glyph bars
- [ ] Tables and grids are CSS layout, not unicode box drawing
- [ ] Inputs, checkboxes and selects are real form elements

## Delivery report

State, in order:

1. The artifact path and every render path
2. The audit result (`PASS`, plus any warnings you accepted and why)
3. The design system used and where it came from (repo tokens / named brand / profile)
4. Decisions you made that the user did not specify
5. What you did not cover, and what needs their input

Never claim a design was reviewed or verified without having rendered it and read
the audit output.

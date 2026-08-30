---
name: "office-suite"
description: "Create, read, edit and validate Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) deliverables. Use whenever the user asks for a report, memo, letter, proposal, meeting minutes, plan, deck, slides, presentation, spreadsheet, budget model, tracker, or any document/table deliverable they intend to open in Office or WPS - including requests phrased as 出一份报告, 写个方案, 做个 PPT, 做个表格, 周报, 会议纪要, 汇报材料. Also use when reading or restructuring content out of an existing .docx/.pptx/.xlsx/.pdf. Do not use for plain Markdown answers in chat, for code files, or for image generation."
---

# Office Suite

Turn information into a real Office file the user can open, edit and send. Every
deliverable goes through the same loop: **plan the structure → write a JSON spec →
build → validate → report the path**.

Never hand back a document you have not validated.

## Toolchain

All scripts live in `$CODEX_HOME/skills/.system/office-suite/scripts/`. Set
`OFFICE=$CODEX_HOME/skills/.system/office-suite/scripts` (fall back to
`$HOME/.codex/skills/.system/office-suite/scripts` if `CODEX_HOME` is unset) and
call them with the system `python3`.

| Task | Command |
|---|---|
| Word document | `python3 $OFFICE/build_docx.py spec.json --out out/report.docx` |
| Deck | `python3 $OFFICE/build_pptx.py spec.json --out out/deck.pptx` |
| Spreadsheet | `python3 $OFFICE/build_xlsx.py spec.json --out out/model.xlsx` |
| Read any of the above (or PDF) | `python3 $OFFICE/read_office.py path` |
| Validate before delivering | `python3 $OFFICE/validate_office.py out/report.docx` |

Dependencies bootstrap themselves into a private virtualenv at
`$CODEX_HOME/skills/.venvs/office-suite` on first run. Do not `pip install`
anything into the user's interpreter, and do not require `pandoc` or LibreOffice —
these scripts deliberately do not need them.

Specs can also be piped: `cat spec.json | python3 $OFFICE/build_docx.py - --out f.docx`.

## Workflow

1. **Settle the deliverable.** Which format, who reads it, how long, what decision
   should it drive. If the user named a format, use it. If they described an
   outcome ("给董事会讲清楚 Q3"), choose the format that fits: narrative → docx,
   presentation → pptx, numbers → xlsx.
2. **Outline first, in the reply, not in a file.** Section list for a document,
   slide-by-slide line for a deck, sheet + column list for a workbook. Keep it to
   a few lines; do not ask for approval unless the scope is genuinely ambiguous.
3. **Write the spec as JSON** into a working file (for example `tmp/<name>.json`).
   Block references: `references/docx-spec.md`, `references/pptx-spec.md`,
   `references/xlsx-spec.md`.
4. **Build**, then **validate**. `validate_office.py` exits non-zero on real
   problems; fix them and rebuild rather than explaining them away.
5. **Read back what you produced** with `read_office.py` when the document is long
   or the content matters. This catches empty sections and mis-nested lists.
6. **Report** the absolute output path, the structure you produced, and anything
   you assumed or left for the user to fill in.

## Content rules

These decide whether the deliverable is usable, so they matter more than styling.

- **Separate sourced facts from assumptions.** If a number came from the user or a
  file, keep it exact. If you inferred it, label it inline (`（估算）`) or drop it.
- **No filler.** Never ship `TODO`, `TBD`, `Lorem ipsum`, or a section heading with
  one hollow sentence under it. If you lack the input, either leave a clearly
  marked blank for the user or ask one focused question.
- **Make ownership and dates explicit.** Any action item gets an owner and a date,
  or it is not an action item.
- **Match the user's language.** A Chinese request gets a Chinese document,
  including headings, table headers and footers.
- **Respect the workspace.** Write outputs where the user asked; default to an
  `output/` or `tmp/` subdirectory of the workspace, never scattered in the repo root.
- **Editing an existing file:** read it with `read_office.py` first, then rebuild the
  full document from a spec that reflects the original structure. Do not silently
  drop sections you did not understand — list them and ask.

## Format-specific guidance

**Word.** Use `heading` levels consistently (one `level: 0` title, then 1/2/3).
Add a `toc` block for anything over ~5 sections. Use `kv` for memo metadata, `table`
for anything comparative, `quote` for cited material. Prefer tables over long
comma-separated sentences.

**PowerPoint.** One idea per slide. Aim for 5 bullets max, ≤ 14 words each; if a
slide needs more, split it or switch to a `cards`/`table` layout. Open with
`cover`, use `section` dividers for decks over ~8 slides, put the takeaway in the
slide title rather than burying it in a bullet. Put speaker detail in `notes`, not
on the slide. Layouts: `cover`, `section`, `bullets`, `cards`, `metrics`, `table`,
`image`, `twoColumn`, `closing`.

**Excel.** Write real formulas (`"=SUM(B4:B6)"`) so the file stays live; never
paste a computed constant where a formula belongs. Set `numberFormats` per column —
unformatted currency is the most common complaint. One logical table per sheet,
header row frozen (default), `asTable: true` when the user will filter and sort.

Details and full block/layout tables: see the three files under `references/`.

## Theming

Both docx and pptx accept a `theme` object. Ask for or reuse the user's brand
colors when they exist (check the repo for a design token file or an existing
deck). Otherwise the defaults are a neutral professional blue and are fine — do
not invent a loud palette.

`references/themes.md` holds a few ready-to-use palettes.

## Failure handling

- `error: unknown block type ...` — the spec used a name that does not exist; the
  error lists every valid type.
- Build fails inside a specific block — the message names the index and type. Fix
  that block; do not rewrite the whole spec.
- `validate_office.py` reports `warn: placeholder text present` — real finding. Remove
  the placeholder before delivering.
- Chinese text renders as boxes in a converted PDF — a font issue on the viewer
  side, not the file. Keep the `cjkFont` theme value set and mention it.

## Reference map

- `references/docx-spec.md` — every Word block type with examples
- `references/pptx-spec.md` — every slide layout with examples
- `references/xlsx-spec.md` — sheet, formula, chart and conditional-format options
- `references/themes.md` — palettes and typography pairings
- `references/examples/` — complete working specs to copy from

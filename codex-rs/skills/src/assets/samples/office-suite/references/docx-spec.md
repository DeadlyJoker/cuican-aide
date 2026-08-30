# docx spec reference

`build_docx.py` consumes a JSON object. Top-level keys:

| Key | Type | Notes |
|---|---|---|
| `output` | string | output path; `--out` overrides it |
| `template` | string | optional existing `.docx`/`.dotx` to inherit styles from |
| `theme` | object | see below |
| `page` | object | `marginTop/marginBottom/marginLeft/marginRight` (inches), `landscape` |
| `header` | string | right-aligned header text |
| `footer` | string | centered footer text |
| `pageNumbers` | bool | default `true`; inserts a live `PAGE` field |
| `blocks` | array | the document body, rendered in order |

## theme

```json
{
  "headingColor": "#2F6FED",
  "headingFont": "Calibri",
  "bodyFont": "Calibri",
  "cjkFont": "Microsoft YaHei",
  "bodySize": 11
}
```

`cjkFont` sets the `w:eastAsia` font slot. Leave it at the default
`Microsoft YaHei` for Chinese documents so Word does not fall back to a serif.

## Inline markup

Any `text` field supports `**bold**`, `*italic*` and `` `code` ``. Nothing else —
no links, no nested emphasis. Use a `table` when you would reach for complex
inline formatting.

## Block types

### heading

```json
{ "type": "heading", "level": 1, "text": "一、结论摘要", "align": "left" }
```

`level` 0–9. Use `0` for the document title, then `1`/`2`/`3`.

### paragraph

```json
{ "type": "paragraph", "text": "本季度交付 **3 个** 里程碑。", "align": "justify", "spaceAfter": 8, "indent": 0.25 }
```

Optional `style` names a Word paragraph style from the template.

### list

```json
{
  "type": "list",
  "ordered": false,
  "items": [
    "顶层条目",
    { "text": "二级条目", "level": 1 }
  ]
}
```

`level` 0–2. `ordered: true` switches to numbered.

### table

```json
{
  "type": "table",
  "header": ["指标", "目标", "实际"],
  "rows": [["交付里程碑", "3", "3"]],
  "widths": [1.6, 1.2, 1.2],
  "style": "Table Grid",
  "headerFill": "F2F2F2"
}
```

`widths` in inches, length must equal the column count. Cells support inline markup.

### kv

Two-column metadata block — the standard memo header.

```json
{ "type": "kv", "pairs": [["报告人", "王启辰"], ["日期", "2026-08-06"]] }
```

### image

```json
{ "type": "image", "path": "assets/chart.png", "widthInches": 5.5, "align": "center", "caption": "图 1 · 季度趋势" }
```

### toc

```json
{ "type": "toc", "title": "目录", "level": 1 }
```

Inserts a live `TOC` field. Word shows a prompt until the user updates the field
(or presses F9) — that is expected behavior, mention it once when delivering.

### quote / code / pageBreak

```json
{ "type": "quote", "text": "引用内容" }
{ "type": "code", "text": "just test -p crewon-app-server", "size": 9.5 }
{ "type": "pageBreak" }
```

## Common structures

**Report:** `heading(0)` → `kv` → `toc` → `pageBreak` → per section
`heading(1)` + `paragraph` + `table`/`list` → closing `heading(1)` + ordered `list`.

**Memo:** `heading(0)` → `kv`(收件人/发件人/日期/主题) → `paragraph` background →
`list` decisions → `table` action items with owner and date columns.

**Proposal:** `heading(0)` → `paragraph` summary → `heading(1)` 现状/方案/成本/
风险/时间表, each with a `table` where numbers are involved.

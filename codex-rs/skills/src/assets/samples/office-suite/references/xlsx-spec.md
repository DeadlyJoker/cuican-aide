# xlsx spec reference

`build_xlsx.py` consumes a JSON object with a `sheets` array.

```json
{
  "output": "out/model.xlsx",
  "theme": { "headerFill": "#2F6FED", "headerInk": "#FFFFFF" },
  "sheets": [ { "name": "预算模型", "...": "..." } ]
}
```

## sheet keys

| Key | Type | Notes |
|---|---|---|
| `name` | string | sheet tab name, truncated to 31 chars |
| `title` | string | optional bold title written above the header |
| `header` | array | header row labels |
| `rows` | array of arrays | data rows; strings starting with `=` become formulas |
| `startRow` | int | first row to write, default `1` |
| `numberFormats` | object | column letter → Excel format string |
| `widths` | object | column letter → width; omit for auto-fit |
| `freezeHeader` | bool | default `true` |
| `autoFilter` | bool | default `true` |
| `asTable` | bool | register a real Excel table instead of a plain filter |
| `tableName` | string | required-ish when `asTable` is true and the sheet name is non-ASCII |
| `tableStyle` | string | e.g. `TableStyleMedium9` |
| `conditional` | array | see below |
| `charts` | array | see below |

## Formulas

Write them as strings. Row numbers must account for `title` (which consumes two
rows) and `startRow`.

```json
{
  "title": "2026 H2 预算",
  "header": ["科目", "Q3", "Q4", "合计"],
  "rows": [
    ["人力", 1200000, 1350000, "=B4+C4"],
    ["合计", "=SUM(B4:B6)", "=SUM(C4:C6)", "=SUM(D4:D6)"]
  ]
}
```

With a `title` at row 1 and `startRow: 1`, the header lands on row 3 and the first
data row on row 4 — hence `=B4+C4`. Always verify the row math against that offset
before building; a wrong reference is the single most common defect here.

openpyxl writes formulas without cached values, so Excel/WPS/Numbers compute them
on open. `read_office.py --formulas` shows the formula text back.

## numberFormats

```json
{ "B": "#,##0", "C": "#,##0.00", "D": "0.0%", "E": "¥#,##0", "F": "yyyy-mm-dd" }
```

Unformatted currency and percentages are the most common complaint about generated
workbooks. Set these.

## conditional

```json
[
  { "range": "B4:C6", "kind": "colorScale", "startColor": "F8696B", "endColor": "63BE7B" },
  { "range": "D4:D6", "kind": "cellIs", "operator": "lessThan", "formula": "0", "fill": "FFC7CE" }
]
```

`operator` accepts the Excel operators: `greaterThan`, `lessThan`, `equal`,
`between`, `notEqual`, `greaterThanOrEqual`, `lessThanOrEqual`.

## charts

```json
[
  {
    "kind": "bar",
    "title": "季度对比",
    "dataMinCol": 2,
    "dataMaxCol": 3,
    "dataMaxRow": 6,
    "catCol": 1,
    "anchor": "H3",
    "width": 16,
    "height": 8
  }
]
```

`kind`: `bar`, `line`, `pie`. Columns and rows are 1-indexed and absolute (they
include the `title` offset). `dataMinCol` starts at the header row so series names
come from the header.

## Financial model conventions

When the user asks for a model rather than a table:

- One sheet for inputs/assumptions, one for the model, one for outputs. Never mix.
- Inputs get a distinct fill; formulas stay unfilled. Users read color as "editable".
- Every driver is a cell reference, never a number typed into a formula.
- Totals use `SUM` over a contiguous range, not a chain of `+`.
- Label units in the header (`收入（万元）`), not in each cell.

## Multi-sheet example

See `references/examples/tracker.json` for a two-sheet tracker with a table, a
filter and a chart.

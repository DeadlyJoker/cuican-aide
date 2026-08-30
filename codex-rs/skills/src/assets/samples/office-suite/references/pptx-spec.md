# pptx spec reference

`build_pptx.py` consumes a JSON object. Top-level keys:

| Key | Type | Notes |
|---|---|---|
| `output` | string | output path; `--out` overrides it |
| `template` | string | optional existing `.pptx` to inherit the master from |
| `aspect` | string | `16:9` (default), `16:10`, `4:3`. Ignored when `template` is set |
| `theme` | object | see below |
| `slides` | array | one object per slide, `layout` selects the renderer |

Slides are drawn with explicit geometry on blank layouts, so the result does not
depend on the default python-pptx placeholders.

## theme

```json
{
  "background": "#FFFFFF",
  "surface": "#F5F6F8",
  "ink": "#1A1A1A",
  "muted": "#6B7280",
  "accent": "#2F6FED",
  "accentSoft": "#E5EDFD",
  "headingFont": "Microsoft YaHei",
  "bodyFont": "Microsoft YaHei",
  "titleSize": 40,
  "headingSize": 28,
  "bodySize": 16,
  "captionSize": 12
}
```

Keep `accent` and `accentSoft` in the same hue family — `accentSoft` is used as a
card fill behind `ink` text, so a saturated value there breaks contrast.

Every slide accepts `notes` for speaker notes.

## Layouts

### cover

```json
{ "layout": "cover", "title": "标题", "subtitle": "副标题", "meta": "2026-08-06 · 平台组" }
```

### section

Full-bleed accent divider. Use for decks over ~8 slides.

```json
{ "layout": "section", "title": "01 现状", "subtitle": "一句话概述" }
```

### bullets

```json
{
  "layout": "bullets",
  "title": "问题定位",
  "subtitle": "可选的一行说明",
  "bullets": [
    "顶层要点",
    { "text": "支撑细节", "level": 1 }
  ]
}
```

Max 5 top-level bullets, ≤ 14 words each. Beyond that, split the slide or switch
to `cards`.

### cards

```json
{
  "layout": "cards",
  "title": "三条路径",
  "columns": 3,
  "cards": [{ "title": "办公", "body": "一到两句说明" }]
}
```

2–6 cards. `columns` defaults to `min(len(cards), 3)`; a 4-card slide reads better
as `columns: 2`.

### metrics

```json
{
  "layout": "metrics",
  "title": "覆盖度",
  "metrics": [{ "value": "10", "label": "区块类型" }]
}
```

2–4 metrics. `value` should be short (a number and a unit), `label` one line.

### table

```json
{
  "layout": "table",
  "title": "交付对照",
  "header": ["场景", "工具", "校验"],
  "rows": [["办公", "build_docx", "validate_office"]]
}
```

Keep to ~8 rows and 5 columns; beyond that the deliverable belongs in a workbook.

### twoColumn

```json
{
  "layout": "twoColumn",
  "title": "对比",
  "columns": [
    { "title": "新增", "body": ["三套构建脚本", "统一 spec 载入"] },
    { "title": "沿用", "body": "可以是一段字符串" }
  ]
}
```

### image

```json
{ "layout": "image", "title": "架构", "image": "assets/arch.png", "caption": "图 1" }
```

The picture is scaled to fit while preserving aspect ratio.

### closing

```json
{ "layout": "closing", "title": "谢谢", "subtitle": "联系方式或下一步" }
```

## Deck shapes that work

**Status review (8–12 slides):** cover → bullets(结论) → metrics(指标) →
table(进展对照) → bullets(风险) → cards(下一步) → closing.

**Proposal (10–14):** cover → bullets(问题) → section → cards(方案) →
twoColumn(方案对比) → metrics(收益) → table(时间表) → bullets(风险与前提) → closing.

**Training/walkthrough:** cover → bullets(议程) → section per module →
image(截图) with caption per step → bullets(要点回顾) → closing.

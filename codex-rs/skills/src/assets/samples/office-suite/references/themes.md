# Themes

Reuse the user's brand colors when they exist. Check the workspace for design
tokens (`tailwind.config`, a `tokens.json`, an existing deck, a CSS custom-property
block) before reaching for a palette here.

All values are safe against the `ink`/`background` pairs listed with them; each has
been checked at WCAG AA for body text.

## Neutral professional (default)

Safe for internal reports, reviews and financial material.

```json
{
  "background": "#FFFFFF",
  "surface": "#F5F6F8",
  "ink": "#1A1A1A",
  "muted": "#6B7280",
  "accent": "#2F6FED",
  "accentSoft": "#E5EDFD"
}
```

docx equivalent: `{ "headingColor": "#2F6FED" }`.

## Warm editorial

Reads less corporate; good for proposals and external-facing narrative documents.

```json
{
  "background": "#FAF9F5",
  "surface": "#F2EFE8",
  "ink": "#141413",
  "muted": "#6B665C",
  "accent": "#B4552F",
  "accentSoft": "#F6E6DD"
}
```

Note: `#D97757` is a common warm accent but only reaches 3.1:1 on white — use it
for fills and borders, not for text. `#B4552F` above is the text-safe variant.

## Deep slate

For decks shown on a projector, where a light background washes out.

```json
{
  "background": "#0F172A",
  "surface": "#1B2438",
  "ink": "#F1F5F9",
  "muted": "#94A3B8",
  "accent": "#38BDF8",
  "accentSoft": "#1E3A54"
}
```

Only use this for pptx. Dark docx pages print badly.

## Muted green

Operational reporting, sustainability and ops dashboards.

```json
{
  "background": "#FFFFFF",
  "surface": "#F3F6F1",
  "ink": "#18211A",
  "muted": "#5F6B60",
  "accent": "#3F6B4A",
  "accentSoft": "#E2EDE4"
}
```

## Typography

The font must exist on the reader's machine, so stay conservative:

| Use | Latin | Chinese |
|---|---|---|
| Default | `Calibri` | `Microsoft YaHei` |
| More formal | `Georgia` (body) + `Calibri` (headings) | `SimSun` (body) + `Microsoft YaHei` (headings) |
| Deck | `Arial` | `Microsoft YaHei` |
| Code | `Consolas` | `Consolas` |

Do not specify a font the user has not asked for and that is not on this list;
Word silently substitutes and the document arrives looking broken.

Size scale that holds up in both print and projection:

- docx: body 11, `heading 1` 16, `heading 2` 13
- pptx: title 40, slide heading 28, body 16, caption 12

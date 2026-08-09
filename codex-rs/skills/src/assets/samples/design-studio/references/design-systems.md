# Design system profiles

Each profile is a coherent set of decisions, not a color list. Pick one and follow
it fully; mixing two profiles is what makes an artifact look assembled rather than
designed.

Every foreground/background pair below passes WCAG AA for body text.

## Product utility (Linear-like)

Dense, keyboard-first, information-heavy. For dashboards, admin tools, issue
trackers.

```css
:root {
  --bg: #08090a; --surface: #101113; --surface-2: #17181a;
  --border: #23252a; --ink: #f7f8f8; --muted: #8a8f98;
  --accent: #5e6ad2; --success: #4cb782; --warning: #f2994a; --danger: #eb5757;
  --radius: 6px; --space: 8px;
  --font: "Inter", system-ui, -apple-system, sans-serif;
}
```

Rules: 13–14px body. Borders over shadows. Radius stays small (4–8px). Rows are
32–40px tall. Accent only on the primary action and active nav state.

## Editorial clarity (Stripe-like)

Generous, trustworthy, marketing-facing. For landing pages, docs, pricing.

```css
:root {
  --bg: #ffffff; --surface: #f6f9fc; --border: #e6ebf1;
  --ink: #0a2540; --muted: #425466;
  --accent: #635bff; --accent-ink: #0a2540;
  --radius: 8px; --space: 8px;
  --font: -apple-system, "Segoe UI", "Helvetica Neue", sans-serif;
}
```

Rules: 16–18px body, 48–72px display. Section padding 80–120px. One gradient
maximum, in the hero only. Soft shadows (`0 2px 5px rgba(50,50,93,.1)`).

## Warm document (Anthropic-like)

Calm, readable, long-form. For reports, essays, knowledge bases.

```css
:root {
  --bg: #faf9f5; --surface: #f2efe8; --border: #e5e1d8;
  --ink: #141413; --muted: #6b665c;
  --accent: #b4552f; --accent-fill: #d97757;
  --radius: 10px; --space: 8px;
  --font-head: "Poppins", system-ui, sans-serif;
  --font-body: "Lora", Georgia, serif;
}
```

Rules: body 17–19px at 1.65 line-height, measure capped at 68ch. `--accent` for
text, `--accent-fill` for fills only (it is 3.1:1 on the background).

## Neutral enterprise

Conservative, print-friendly, safe for internal review material.

```css
:root {
  --bg: #ffffff; --surface: #f5f6f8; --border: #dfe3e8;
  --ink: #1a1a1a; --muted: #5b6472;
  --accent: #2f6fed; --accent-soft: #e5edfd;
  --radius: 6px; --space: 8px;
  --font: "Segoe UI", system-ui, sans-serif;
}
```

Rules: no gradients, no glass. Tables get visible borders. This is the default when
the user has expressed no preference and the artifact is internal.

## High-contrast expressive

Bold, opinionated, attention-seeking. For campaign pages and launch material.

```css
:root {
  --bg: #0a0a0a; --surface: #141414; --border: #262626;
  --ink: #fafafa; --muted: #a3a3a3;
  --accent: #ccff00; --accent-ink: #0a0a0a;
  --radius: 0px; --space: 8px;
  --font: "Space Grotesk", system-ui, sans-serif;
}
```

Rules: display type 72px+, tight tracking (-0.03em). Sharp corners. `--accent` is a
background for `--accent-ink` text, never text on `--bg` at body size.

## Shared scales

Use these regardless of profile.

**Spacing (8px base):** 4, 8, 12, 16, 24, 32, 48, 64, 96, 128.

**Type scale:** 12, 14, 16, 20, 24, 32, 48, 64. Pick 4–6 of them per artifact.

**Line height:** display 1.1–1.2, heading 1.25–1.35, body 1.5–1.65, dense UI 1.4.

**Elevation:** at most two levels.
```css
--shadow-1: 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.08);
--shadow-2: 0 4px 12px rgb(0 0 0 / 0.10), 0 2px 4px rgb(0 0 0 / 0.06);
```

**Breakpoints:** 390 (mobile), 834 (tablet), 1440 (desktop), 1920 (wide) — matching
`render_design.py --responsive`.

## Cloning an existing brand

When the user names a product ("做成 Notion 那种感觉"), do not guess from memory
alone. Extract the actual system:

1. Look for the brand's design tokens or public style guide
2. Identify: type pairing, base spacing unit, radius, elevation approach, accent role
3. Write the tokens as CSS custom properties before writing any markup
4. State which parts you matched and which you approximated

Naming the approximations honestly is better than presenting a rough imitation as a
faithful match.

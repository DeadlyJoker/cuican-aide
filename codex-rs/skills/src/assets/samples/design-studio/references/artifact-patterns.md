# Artifact patterns

Every artifact is one self-contained HTML file: inline `<style>`, no build step, no
external network requests (headless render has no network — a web font link will
silently fall back).

## Base scaffold

Start every artifact from this. It sets the audit-passing basics: `lang`, viewport,
token block, system font stack.

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact title</title>
<style>
  :root {
    --bg:#ffffff; --surface:#f5f6f8; --border:#dfe3e8;
    --ink:#1a1a1a; --muted:#5b6472; --accent:#2f6fed; --accent-soft:#e5edfd;
    --radius:8px; --shadow-1:0 1px 3px rgb(0 0 0 / .08);
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);
       font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  h1,h2,h3{line-height:1.25;letter-spacing:-.01em;margin:0}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
  <!-- content -->
</body>
</html>
```

## Landing page

Order: hero → social proof → 3-feature grid → detail section → pricing or CTA →
footer. Section padding 80–120px desktop, 48–64px mobile. Content column capped at
1120px. The hero carries one headline, one sub, one primary action — resist a second
competing CTA.

```html
<section class="hero">
  <span class="eyebrow">标签</span>
  <h1>一句话价值主张</h1>
  <p class="lead">一到两句支撑说明，控制在 60–75 字符每行。</p>
  <a class="btn-primary" href="#">主要行动</a>
</section>
```

## Dashboard / data UI

Left nav (240px) + top bar (56px) + content. Metric row of 3–4 cards, then the
primary table or chart, then secondary detail.

Mandatory states — show them, do not describe them:

```html
<!-- empty -->
<div class="empty"><svg …/><p>还没有数据</p><button>创建第一条</button></div>
<!-- loading -->
<div class="row skeleton" aria-busy="true"></div>
<!-- error -->
<div class="alert" role="alert">加载失败。<button>重试</button></div>
<!-- overflow: include one row with a very long value and one with 0 -->
```

Charts must be real SVG computed from data:

```html
<svg viewBox="0 0 320 120" role="img" aria-label="近 7 日趋势">
  <polyline fill="none" stroke="var(--accent)" stroke-width="2"
            points="0,90 53,72 106,78 160,44 213,50 266,26 320,18"/>
</svg>
```

## Mobile flow

Render at `--width 390 --height 844`. 44px minimum touch targets. Bottom nav 56px
plus safe-area inset. Show 3–4 connected screens side by side in one file so the
flow reads as a sequence.

```html
<div class="flow">
  <figure class="phone"><figcaption>1 · 入口</figcaption><div class="screen">…</div></figure>
  <figure class="phone"><figcaption>2 · 填写</figcaption><div class="screen">…</div></figure>
</div>
```

## Slide deck as HTML

One `<section class="slide">` per slide, each exactly the page size, with a print
rule so `--pdf` produces one page per slide.

```css
.slide{width:1280px;height:720px;padding:64px;display:flex;flex-direction:column;
       justify-content:center;page-break-after:always;break-after:page}
@page{size:1280px 720px;margin:0}
@media print{.slide{box-shadow:none}}
```

Export with `render_design.py deck.html --pdf out/deck.pdf`.

## Component / design system spec

For each component show every state in a labelled grid: default, hover, active,
focus, disabled, loading, error. Static hover/focus states need explicit classes
(`.btn.is-hover`) since a screenshot cannot hover.

```html
<div class="spec-grid">
  <div><span class="label">default</span><button class="btn">保存</button></div>
  <div><span class="label">hover</span><button class="btn is-hover">保存</button></div>
  <div><span class="label">disabled</span><button class="btn" disabled>保存</button></div>
</div>
```

Follow with the token table and the usage rules in prose.

## Wireframe

Deliberately unstyled: single neutral gray scale, no accent, no imagery, boxes with
labels. The point is structure, so do not sneak in visual polish — it invites
feedback on the wrong layer.

## Motion study

Keep animation running with CSS so the artifact is inspectable, but always guard it:

```css
@media (prefers-reduced-motion:reduce){.animated{animation:none}}
```

A screenshot captures one frame. For motion, render 3 PNGs with different
`--delay-ms` values to show the sequence.

## Icons

Inline SVG only. Lucide-style stroke icons compose consistently:

```html
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <path d="M5 12h14M12 5l7 7-7 7"/>
</svg>
```

Decorative icons get `aria-hidden="true"`. An icon-only button needs `aria-label`,
or the audit fails it.

## Interactive prototypes

Plain vanilla JS in a `<script>` at the end of body. No CDN React, no Babel — they
need network access that the headless render does not have. If interaction state
matters for the screenshot, set the interesting state as the initial state.

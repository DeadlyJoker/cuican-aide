#!/usr/bin/env python3
"""Render the CrewON customer introduction Markdown into a print-ready PDF.

Uses Chrome headless so Chinese text, tables, and product screenshots all
render with the same engine the product UI uses.
"""

from __future__ import annotations

import base64
import html
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path("/Users/wangqichen/projects/brilliant/cuican-aide")
DOC = REPO / "output/docs/CrewON-current-project-introduction.md"
SHOTS = REPO / "tmp/pdfs/shots-light"
OUT_PDF = REPO / "output/pdf/CrewON-current-project-introduction.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

IMAGES = {
    "IMG_HOME": "01-home.png",
    "IMG_CODING": "02-coding.png",
    "IMG_DESIGN": "03-design.png",
    "IMG_AGENTS": "04-agents.png",
    "IMG_SKILLS": "05-skills.png",
    "IMG_SERVICES": "06-services.png",
    "IMG_SCHEDULE": "07-schedule.png",
    "IMG_COMPOSER": "09-composer.png",
    "IMG_RUNNING": "10-running.png",
    "IMG_DELIVERY": "11-result.png",
}

CSS = r"""
@page {
  size: A4;
  margin: 18mm 16mm 16mm 16mm;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "PingFang SC", "Helvetica Neue", "Hiragino Sans GB", sans-serif;
  font-size: 10.2pt;
  line-height: 1.75;
  color: #1f2328;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { color: #0b1220; font-weight: 600; }
h1 {
  font-size: 26pt;
  line-height: 1.3;
  margin: 0 0 6mm;
  letter-spacing: -0.5px;
}
h2 {
  font-size: 15pt;
  margin: 11mm 0 4mm;
  padding-bottom: 2.4mm;
  border-bottom: 1.6px solid #0b1220;
  break-after: avoid;
}
h3 {
  font-size: 11.6pt;
  margin: 7mm 0 2.6mm;
  break-after: avoid;
}
p { margin: 0 0 3.2mm; }
strong { color: #0b1220; font-weight: 600; }
ul { margin: 0 0 3.6mm; padding-left: 5.4mm; }
li { margin: 0 0 1.4mm; }
hr {
  border: none;
  border-top: 1px solid #e3e6ea;
  margin: 8mm 0;
}
blockquote {
  margin: 4mm 0 5mm;
  padding: 4mm 5mm;
  background: #f5f7f9;
  border-left: 3px solid #0b1220;
  font-size: 11pt;
  color: #0b1220;
}
blockquote p { margin: 0; }
code {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 9pt;
  background: #f1f3f5;
  padding: 0.4mm 1.2mm;
  border-radius: 2px;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 4mm 0 6mm;
  font-size: 9.2pt;
  break-inside: avoid;
}
th, td {
  border: 1px solid #dfe3e8;
  padding: 2.4mm 2.8mm;
  text-align: left;
  vertical-align: top;
}
th {
  background: #f5f7f9;
  font-weight: 600;
  color: #0b1220;
}
tbody tr:nth-child(even) td { background: #fafbfc; }
figure {
  margin: 5mm 0 6mm;
  break-inside: avoid;
}
figure img {
  width: 100%;
  display: block;
  border: 1px solid #e3e6ea;
  border-radius: 3px;
}
figcaption {
  margin-top: 2mm;
  font-size: 8.4pt;
  color: #6b7280;
  text-align: center;
}
.cover {
  height: 246mm;
  display: flex;
  flex-direction: column;
  justify-content: center;
  break-after: page;
  text-align: left;
}
.cover .mark {
  width: 15mm;
  height: 15mm;
  border-radius: 4mm;
  background: #0b1220;
  color: #fff;
  font-size: 20pt;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 9mm;
}
.cover h1 { font-size: 34pt; margin-bottom: 4mm; }
.cover .tagline {
  font-size: 15pt;
  color: #374151;
  margin: 0 0 12mm;
  font-weight: 400;
}
.cover .toc {
  border-top: 1px solid #e3e6ea;
  padding-top: 6mm;
  font-size: 10pt;
  color: #4b5563;
  columns: 2;
  column-gap: 12mm;
}
.cover .toc div { margin-bottom: 2.2mm; break-inside: avoid; }
.cover .meta {
  margin-top: 14mm;
  font-size: 9pt;
  color: #9ca3af;
}
.contact-block {
  margin-top: 10mm;
  padding: 7mm;
  background: #f5f7f9;
  border-radius: 4px;
  break-inside: avoid;
}
.contact-block h3 { margin-top: 0; }
.contact-block p:last-child { margin-bottom: 0; }
section.body h2:first-of-type { margin-top: 0; }
"""


ASSETS = REPO / "tmp/pdfs/preview/assets"
# Screenshots arrive at 1920px; print only needs ~1400px, and JPEG keeps the
# document small enough for Chrome to rasterise without timing out.
ASSET_WIDTH = 1400
ASSET_QUALITY = 82


def prepare_asset(name: str) -> str:
    """Downscale a screenshot into the preview asset dir, returning its href."""
    from PIL import Image

    ASSETS.mkdir(parents=True, exist_ok=True)
    source = SHOTS / name
    target = ASSETS / f"{Path(name).stem}.jpg"
    # Rebuild whenever the screenshot is newer, otherwise re-shot images are
    # silently ignored and the PDF keeps embedding stale assets.
    if not target.exists() or source.stat().st_mtime > target.stat().st_mtime:
        image = Image.open(source).convert("RGB")
        if image.width > ASSET_WIDTH:
            height = round(image.height * ASSET_WIDTH / image.width)
            image = image.resize((ASSET_WIDTH, height), Image.LANCZOS)
        image.save(target, "JPEG", quality=ASSET_QUALITY, optimize=True)
    return f"assets/{target.name}"


def inline(text: str) -> str:
    """Escape then apply the small inline subset the document actually uses."""
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    return out


def render_table(rows: list[str]) -> str:
    def cells(line: str) -> list[str]:
        return [c.strip() for c in line.strip().strip("|").split("|")]

    head = cells(rows[0])
    body = [cells(r) for r in rows[2:]]
    parts = ["<table><thead><tr>"]
    parts += [f"<th>{inline(c)}</th>" for c in head]
    parts.append("</tr></thead><tbody>")
    for row in body:
        parts.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>")
    parts.append("</tbody></table>")
    return "".join(parts)


def render_image(alt: str, token: str) -> str:
    name = IMAGES.get(token)
    if not name:
        raise SystemExit(f"unknown image token: {token}")
    if not (SHOTS / name).exists():
        raise SystemExit(f"missing screenshot: {SHOTS / name}")
    href = prepare_asset(name)
    return (
        f'<figure><img src="{href}" alt="{html.escape(alt)}">'
        f"<figcaption>{inline(alt)}</figcaption></figure>"
    )


def markdown_to_html(lines: list[str]) -> str:
    out: list[str] = []
    index = 0
    total = len(lines)
    while index < total:
        raw = lines[index]
        line = raw.rstrip()
        stripped = line.strip()
        index += 1

        if not stripped:
            continue
        if stripped in {"---", "***"}:
            out.append("<hr>")
            continue
        if stripped.startswith("<"):
            out.append(stripped)
            continue

        image = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
        if image:
            out.append(render_image(image.group(1), image.group(2)))
            continue

        heading = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading:
            level = len(heading.group(1))
            out.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
            continue

        if stripped.startswith(">"):
            quote = [stripped.lstrip("> ").strip()]
            while index < total and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().lstrip("> ").strip())
                index += 1
            out.append(f"<blockquote><p>{inline(' '.join(quote))}</p></blockquote>")
            continue

        if stripped.startswith("|"):
            table = [stripped]
            while index < total and lines[index].strip().startswith("|"):
                table.append(lines[index].strip())
                index += 1
            out.append(render_table(table))
            continue

        if re.match(r"^([-*]|\d+\.)\s+", stripped):
            items: list[str] = []
            ordered = bool(re.match(r"^\d+\.\s+", stripped))
            cursor = index - 1
            while cursor < total and re.match(r"^([-*]|\d+\.)\s+", lines[cursor].strip()):
                items.append(re.sub(r"^([-*]|\d+\.)\s+", "", lines[cursor].strip()))
                cursor += 1
            index = cursor
            tag = "ol" if ordered else "ul"
            body = "".join(f"<li>{inline(i)}</li>" for i in items)
            out.append(f"<{tag}>{body}</{tag}>")
            continue

        out.append(f"<p>{inline(stripped)}</p>")

    return "\n".join(out)


COVER_SECTIONS = [
    "一、我们解决什么问题",
    "二、CrewON 是什么",
    "三、与常见 AI 工具的区别",
    "四、核心能力",
    "五、安全与治理",
    "六、技术特点",
    "七、典型应用场景",
    "八、产品成熟度",
    "九、发展方向",
    "十、总结",
]


def build_cover(title: str, tagline: str) -> str:
    toc = "".join(f"<div>{html.escape(s)}</div>" for s in COVER_SECTIONS)
    return (
        '<section class="cover">'
        '<div class="mark">C</div>'
        f"<h1>{html.escape(title)}</h1>"
        f'<p class="tagline">{html.escape(tagline)}</p>'
        f'<div class="toc">{toc}</div>'
        '<p class="meta">产品介绍 · 2026 年 8 月</p>'
        "</section>"
    )


def main() -> int:
    if not Path(CHROME).exists():
        print(f"Chrome not found at {CHROME}", file=sys.stderr)
        return 1

    lines = DOC.read_text(encoding="utf-8").splitlines()
    title = lines[0].lstrip("# ").strip()
    tagline = next(
        (l.lstrip("# ").strip() for l in lines[1:6] if l.startswith("## ")),
        "",
    )
    # Skip the H1 title and the H2 tagline; the cover renders both.
    body_start = next(
        i for i, l in enumerate(lines) if l.strip() == "---"
    )
    body = markdown_to_html(lines[body_start:])

    document = (
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<title>{html.escape(title)}</title><style>{CSS}</style></head><body>"
        f"{build_cover(title, tagline)}"
        f'<section class="body">{body}</section>'
        "</body></html>"
    )
    return render(document)


PREVIEW_HTML = REPO / "tmp/pdfs/preview/intro.html"


def wait_for_pdf(process: subprocess.Popen, limit: int = 600) -> bool:
    """Poll until the PDF exists and its size has settled, or the limit lapses."""
    import time

    stable = 0
    last = -1
    for _ in range(limit):
        if OUT_PDF.exists():
            size = OUT_PDF.stat().st_size
            stable = stable + 1 if size == last and size > 0 else 0
            last = size
            if stable >= 3:
                return True
        elif process.poll() is not None:
            return False
        time.sleep(1)
    return OUT_PDF.exists() and OUT_PDF.stat().st_size > 0


def render(document: str) -> int:
    OUT_PDF.parent.mkdir(parents=True, exist_ok=True)
    PREVIEW_HTML.parent.mkdir(parents=True, exist_ok=True)
    PREVIEW_HTML.write_text(document, encoding="utf-8")
    source = PREVIEW_HTML
    if OUT_PDF.exists():
        OUT_PDF.unlink()
    with tempfile.TemporaryDirectory() as tmp:
        profile = Path(tmp) / "chrome-profile"
        process = subprocess.Popen(
            [
                CHROME,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-sandbox",
                f"--user-data-dir={profile}",
                "--allow-file-access-from-files",
                "--virtual-time-budget=20000",
                "--no-pdf-header-footer",
                f"--print-to-pdf={OUT_PDF}",
                source.as_uri(),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Chrome on this machine can outlive its own exit signal, so wait for
        # the PDF to stop growing rather than trusting the return code.
        if not wait_for_pdf(process):
            process.kill()
            print("chrome did not produce a stable PDF", file=sys.stderr)
            return 1
    print(f"wrote {OUT_PDF} ({OUT_PDF.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


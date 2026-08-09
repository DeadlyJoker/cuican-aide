"""Block renderers for build_docx.py.

Each block in a spec maps to one renderer. Renderers are registered in
``RENDERERS`` so adding a block type never requires touching the dispatcher.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

from . import spec as specmod

ALIGNMENTS = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}

# Inline markup: **bold**, *italic*, `code`.
_INLINE = re.compile(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)", re.DOTALL)


def add_page_number_field(paragraph) -> None:
    """Insert a live PAGE field so page numbers update in Word."""

    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)


def add_toc_field(paragraph) -> None:
    """Insert a TOC field; Word populates it on open / F9."""

    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = r'TOC \o "1-3" \h \z \u'
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    placeholder = OxmlElement("w:t")
    placeholder.text = "Right-click and choose Update Field to build the table of contents."
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr, separate, placeholder, end):
        run._r.append(node)


def add_rich_text(paragraph, text: str) -> None:
    """Add text with **bold**, *italic* and `code` inline markup applied."""

    for token in _INLINE.split(str(text)):
        if not token:
            continue
        if token.startswith("**") and token.endswith("**") and len(token) > 4:
            paragraph.add_run(token[2:-2]).bold = True
        elif token.startswith("`") and token.endswith("`") and len(token) > 2:
            run = paragraph.add_run(token[1:-1])
            run.font.name = "Consolas"
        elif token.startswith("*") and token.endswith("*") and len(token) > 2:
            paragraph.add_run(token[1:-1]).italic = True
        else:
            paragraph.add_run(token)


def _apply_paragraph_options(paragraph, block: dict[str, Any]) -> None:
    align = block.get("align")
    if align:
        if align not in ALIGNMENTS:
            raise specmod.SpecError(f"unknown align: {align}")
        paragraph.alignment = ALIGNMENTS[align]
    if block.get("spaceAfter") is not None:
        paragraph.paragraph_format.space_after = Pt(float(block["spaceAfter"]))
    if block.get("indent") is not None:
        paragraph.paragraph_format.left_indent = Inches(float(block["indent"]))


def render_heading(document, block: dict[str, Any]) -> None:
    level = int(block.get("level", 1))
    if not 0 <= level <= 9:
        raise specmod.SpecError(f"heading level out of range: {level}")
    paragraph = document.add_heading("", level=level)
    add_rich_text(paragraph, block.get("text", ""))
    _apply_paragraph_options(paragraph, block)


def render_paragraph(document, block: dict[str, Any]) -> None:
    paragraph = document.add_paragraph(style=block.get("style"))
    add_rich_text(paragraph, block.get("text", ""))
    _apply_paragraph_options(paragraph, block)


def render_list(document, block: dict[str, Any]) -> None:
    ordered = bool(block.get("ordered"))
    base_style = "List Number" if ordered else "List Bullet"
    for item in block.get("items", []):
        if isinstance(item, dict):
            text = item.get("text", "")
            level = int(item.get("level", 0))
        else:
            text = item
            level = 0
        style = base_style if level == 0 else f"{base_style} {min(level + 1, 3)}"
        paragraph = document.add_paragraph(style=style)
        add_rich_text(paragraph, text)


def render_table(document, block: dict[str, Any]) -> None:
    header = block.get("header") or []
    rows = block.get("rows") or []
    if not header and not rows:
        raise specmod.SpecError("table block needs `header` or `rows`")

    column_count = len(header) if header else max(len(row) for row in rows)
    table = document.add_table(rows=0, cols=column_count)
    table.style = block.get("style", "Table Grid")
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    if header:
        cells = table.add_row().cells
        for cell, value in zip(cells, header):
            cell.text = ""
            paragraph = cell.paragraphs[0]
            add_rich_text(paragraph, value)
            for run in paragraph.runs:
                run.bold = True
            _shade_cell(cell, block.get("headerFill", "F2F2F2"))

    for row in rows:
        cells = table.add_row().cells
        for cell, value in zip(cells, row):
            cell.text = ""
            add_rich_text(cell.paragraphs[0], "" if value is None else value)

    widths = block.get("widths")
    if widths:
        if len(widths) != column_count:
            raise specmod.SpecError("table `widths` length must match column count")
        for row in table.rows:
            for cell, width in zip(row.cells, widths):
                cell.width = Inches(float(width))


def _shade_cell(cell, hex_fill: str) -> None:
    shading = OxmlElement("w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:fill"), hex_fill.lstrip("#").upper())
    cell._tc.get_or_add_tcPr().append(shading)


def render_image(document, block: dict[str, Any]) -> None:
    source = block.get("path")
    if not source:
        raise specmod.SpecError("image block needs `path`")
    image_path = Path(source).expanduser()
    if not image_path.is_file():
        raise specmod.SpecError(f"image not found: {image_path}")
    width = block.get("widthInches")
    paragraph = document.add_paragraph()
    paragraph.alignment = ALIGNMENTS.get(block.get("align", "center"), WD_ALIGN_PARAGRAPH.CENTER)
    paragraph.add_run().add_picture(
        str(image_path), width=Inches(float(width)) if width else None
    )
    caption = block.get("caption")
    if caption:
        caption_paragraph = document.add_paragraph(style="Caption")
        caption_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_rich_text(caption_paragraph, caption)


def render_page_break(document, block: dict[str, Any]) -> None:
    document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def render_toc(document, block: dict[str, Any]) -> None:
    title = block.get("title")
    if title:
        heading = document.add_heading("", level=int(block.get("level", 1)))
        add_rich_text(heading, title)
    add_toc_field(document.add_paragraph())


def render_quote(document, block: dict[str, Any]) -> None:
    paragraph = document.add_paragraph(style="Intense Quote")
    add_rich_text(paragraph, block.get("text", ""))


def render_code(document, block: dict[str, Any]) -> None:
    paragraph = document.add_paragraph()
    paragraph.paragraph_format.left_indent = Inches(0.25)
    run = paragraph.add_run(block.get("text", ""))
    run.font.name = "Consolas"
    run.font.size = Pt(float(block.get("size", 9.5)))
    run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)


def render_kv(document, block: dict[str, Any]) -> None:
    """A two-column borderless table, the standard memo metadata layout."""

    pairs = block.get("pairs") or []
    if not pairs:
        raise specmod.SpecError("kv block needs `pairs`")
    table = document.add_table(rows=0, cols=2)
    table.style = block.get("style", "Light List")
    for key, value in pairs:
        cells = table.add_row().cells
        cells[0].text = ""
        key_paragraph = cells[0].paragraphs[0]
        add_rich_text(key_paragraph, key)
        for run in key_paragraph.runs:
            run.bold = True
        cells[1].text = ""
        add_rich_text(cells[1].paragraphs[0], "" if value is None else value)


RENDERERS: dict[str, Callable[[Any, dict[str, Any]], None]] = {
    "heading": render_heading,
    "paragraph": render_paragraph,
    "list": render_list,
    "table": render_table,
    "image": render_image,
    "pageBreak": render_page_break,
    "toc": render_toc,
    "quote": render_quote,
    "code": render_code,
    "kv": render_kv,
}


def render_block(document, block: dict[str, Any]) -> None:
    block_type = block["type"]
    renderer = RENDERERS.get(block_type)
    if renderer is None:
        known = ", ".join(sorted(RENDERERS))
        raise specmod.SpecError(f"unknown block type `{block_type}`; known types: {known}")
    renderer(document, block)

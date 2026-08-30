#!/usr/bin/env python3
"""Build a .docx file from a JSON spec.

Usage:
    python build_docx.py spec.json --out report.docx
    cat spec.json | python build_docx.py - --out report.docx

See references/docx-spec.md for the full block reference.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from officelib import env  # noqa: E402

env.reexec_in_environment()

from docx import Document  # noqa: E402
from docx.enum.section import WD_SECTION  # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402
from docx.shared import Inches, Pt, RGBColor  # noqa: E402

from officelib import docxblocks, spec as specmod  # noqa: E402

DEFAULT_BODY_FONT = "Calibri"
DEFAULT_CJK_FONT = "Microsoft YaHei"


def apply_base_style(document: Document, theme: dict) -> None:
    """Set body font (including the CJK font slot) and default sizes."""

    body_font = theme.get("bodyFont", DEFAULT_BODY_FONT)
    cjk_font = theme.get("cjkFont", DEFAULT_CJK_FONT)
    body_size = float(theme.get("bodySize", 11))

    normal = document.styles["Normal"]
    normal.font.name = body_font
    normal.font.size = Pt(body_size)
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.get_or_add_rFonts()
    rfonts.set(qn("w:eastAsia"), cjk_font)
    rfonts.set(qn("w:ascii"), body_font)
    rfonts.set(qn("w:hAnsi"), body_font)

    heading_color = theme.get("headingColor")
    if heading_color:
        rgb = RGBColor.from_string(heading_color.lstrip("#").upper())
        for level in range(1, 5):
            style = document.styles[f"Heading {level}"]
            style.font.color.rgb = rgb
            style.font.name = theme.get("headingFont", body_font)


def apply_page_setup(document: Document, page: dict) -> None:
    section = document.sections[0]
    if page.get("landscape"):
        section.orientation = WD_SECTION.NEW_PAGE  # keeps python-docx happy
        section.page_width, section.page_height = (
            section.page_height,
            section.page_width,
        )
    for edge in ("top", "bottom", "left", "right"):
        value = page.get(f"margin{edge.capitalize()}")
        if value is not None:
            setattr(section, f"{edge}_margin", Inches(float(value)))


def apply_header_footer(document: Document, spec: dict) -> None:
    header_text = spec.get("header")
    footer_text = spec.get("footer")
    section = document.sections[0]

    if header_text:
        paragraph = section.header.paragraphs[0]
        paragraph.text = header_text
        paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT

    if footer_text or spec.get("pageNumbers", True):
        paragraph = section.footer.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if footer_text:
            paragraph.add_run(f"{footer_text}   ")
        if spec.get("pageNumbers", True):
            docxblocks.add_page_number_field(paragraph)


def build(spec: dict, out_path: Path) -> Path:
    template = spec.get("template")
    document = Document(str(Path(template).expanduser())) if template else Document()

    apply_base_style(document, spec.get("theme", {}))
    apply_page_setup(document, spec.get("page", {}))
    apply_header_footer(document, spec)

    for index, block in enumerate(specmod.blocks_of(spec)):
        try:
            docxblocks.render_block(document, block)
        except specmod.SpecError:
            raise
        except Exception as error:  # noqa: BLE001 - surface the failing block
            raise specmod.SpecError(
                f"blocks[{index}] (type={block.get('type')}) failed: {error}"
            ) from error

    document.save(str(out_path))
    return out_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a .docx from a JSON spec")
    parser.add_argument("spec", nargs="?", default="-", help="spec path, or - for stdin")
    parser.add_argument("--out", dest="out", default=None, help="output .docx path")
    args = parser.parse_args(argv)

    try:
        spec = specmod.load_spec(args.spec)
        out_path = specmod.resolve_output(spec, args.out, ".docx")
        build(spec, out_path)
    except specmod.SpecError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

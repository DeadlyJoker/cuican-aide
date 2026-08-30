"""Slide layout primitives for build_pptx.py.

python-pptx placeholder layouts produce generic decks, so every layout here is
drawn with explicit geometry on a blank slide. That keeps the visual result
predictable and lets the theme drive colors and type scale.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

from . import spec as specmod


@dataclass(frozen=True)
class Theme:
    """Resolved deck theme. All colors are hex strings without '#'."""

    background: str = "FFFFFF"
    surface: str = "F5F6F8"
    ink: str = "1A1A1A"
    muted: str = "6B7280"
    accent: str = "2F6FED"
    accent_soft: str = "E5EDFD"
    heading_font: str = "Microsoft YaHei"
    body_font: str = "Microsoft YaHei"
    title_size: float = 40
    heading_size: float = 28
    body_size: float = 16
    caption_size: float = 12

    @classmethod
    def from_spec(cls, raw: dict[str, Any] | None) -> "Theme":
        raw = raw or {}
        known = {field: raw[field] for field in cls.__dataclass_fields__ if field in raw}
        camel = {
            "accentSoft": "accent_soft",
            "headingFont": "heading_font",
            "bodyFont": "body_font",
            "titleSize": "title_size",
            "headingSize": "heading_size",
            "bodySize": "body_size",
            "captionSize": "caption_size",
        }
        for key, field in camel.items():
            if key in raw:
                known[field] = raw[key]
        cleaned = {
            key: (value.lstrip("#").upper() if isinstance(value, str) and _is_hex(value) else value)
            for key, value in known.items()
        }
        return cls(**cleaned)

    def rgb(self, name: str) -> RGBColor:
        return RGBColor.from_string(getattr(self, name))


def _is_hex(value: str) -> bool:
    candidate = value.lstrip("#")
    return len(candidate) == 6 and all(char in "0123456789abcdefABCDEF" for char in candidate)


ALIGN = {
    "left": PP_ALIGN.LEFT,
    "center": PP_ALIGN.CENTER,
    "right": PP_ALIGN.RIGHT,
}


def blank_slide(presentation):
    """Return a slide using the last (blank) master layout."""

    layout = presentation.slide_layouts[6]
    return presentation.slides.add_slide(layout)


def paint_background(slide, presentation, theme: Theme, color_name: str = "background") -> None:
    shape = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, 0, 0, presentation.slide_width, presentation.slide_height
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = theme.rgb(color_name)
    shape.line.fill.background()
    shape.shadow.inherit = False


def add_text(
    slide,
    *,
    text: str,
    left: float,
    top: float,
    width: float,
    height: float,
    size: float,
    color: RGBColor,
    font: str,
    bold: bool = False,
    align: str = "left",
    anchor=MSO_ANCHOR.TOP,
    line_spacing: float = 1.15,
):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    frame = box.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = anchor
    lines = str(text).split("\n")
    for index, line in enumerate(lines):
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.alignment = ALIGN.get(align, PP_ALIGN.LEFT)
        paragraph.line_spacing = line_spacing
        run = paragraph.add_run()
        run.text = line
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
        run.font.name = font
    return box


def add_accent_bar(slide, theme: Theme, *, left: float, top: float, width: float = 0.9) -> None:
    bar = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(0.075)
    )
    bar.fill.solid()
    bar.fill.fore_color.rgb = theme.rgb("accent")
    bar.line.fill.background()
    bar.shadow.inherit = False


def add_card(
    slide,
    theme: Theme,
    *,
    left: float,
    top: float,
    width: float,
    height: float,
    fill: str = "surface",
):
    card = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(height)
    )
    card.fill.solid()
    card.fill.fore_color.rgb = theme.rgb(fill)
    card.line.color.rgb = theme.rgb("accent_soft")
    card.line.width = Pt(1)
    card.shadow.inherit = False
    card.adjustments[0] = 0.06
    return card


def add_picture_fit(slide, image: str, *, left: float, top: float, width: float, height: float):
    """Insert a picture scaled to fit the given box, preserving aspect ratio."""

    path = Path(image).expanduser()
    if not path.is_file():
        raise specmod.SpecError(f"image not found: {path}")
    picture = slide.shapes.add_picture(str(path), Inches(left), Inches(top))
    box_w, box_h = Inches(width), Inches(height)
    scale = min(box_w / picture.width, box_h / picture.height)
    picture.width = Emu(int(picture.width * scale))
    picture.height = Emu(int(picture.height * scale))
    picture.left = Emu(int(Inches(left) + (box_w - picture.width) / 2))
    picture.top = Emu(int(Inches(top) + (box_h - picture.height) / 2))
    return picture

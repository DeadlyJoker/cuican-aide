"""WCAG 2.1 contrast math and CSS color parsing.

Only the color formats that actually appear in generated artifacts are handled:
hex (3/4/6/8 digit), rgb()/rgba(), hsl()/hsla(), and the common named colors.
Unknown values return None so callers can skip instead of guessing.
"""

from __future__ import annotations

import re

NAMED = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "blue": (0, 0, 255),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "silver": (192, 192, 192),
    "orange": (255, 165, 0),
    "navy": (0, 0, 128),
    "teal": (0, 128, 128),
    # `transparent` is fully-transparent black in CSS, not an unparseable value.
    # Modeling it as alpha=0 lets it composite away instead of being skipped.
    "transparent": (0, 0, 0),
}

_RGB = re.compile(r"rgba?\(([^)]+)\)", re.IGNORECASE)
_HSL = re.compile(r"hsla?\(([^)]+)\)", re.IGNORECASE)


def parse_color(value: str) -> tuple[int, int, int] | None:
    """Parse a CSS color, ignoring alpha. Use `parse_color_alpha` when alpha matters."""

    parsed = parse_color_alpha(value)
    return None if parsed is None else parsed[0]


def parse_color_alpha(value: str) -> tuple[tuple[int, int, int], float] | None:
    """Parse a CSS color into ((r, g, b), alpha).

    Alpha is load-bearing for contrast: a tinted badge such as
    `rgb(76 183 130 / .14)` measured as an opaque fill reports 1.4:1 when the
    composited result against its parent is actually 8.6:1.
    """

    text = value.strip().lower()
    if not text:
        return None
    if text in NAMED:
        return NAMED[text], 0.0 if text == "transparent" else 1.0

    if text.startswith("#"):
        digits = text[1:]
        if len(digits) == 3:
            digits = "".join(char * 2 for char in digits)
        elif len(digits) == 4:
            digits = "".join(char * 2 for char in digits)
        if len(digits) in (6, 8):
            try:
                rgb = tuple(int(digits[i : i + 2], 16) for i in (0, 2, 4))
                alpha = int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0
            except ValueError:
                return None
            return rgb, alpha  # type: ignore[return-value]
        return None

    match = _RGB.search(text)
    if match:
        parts = re.split(r"[,\s/]+", match.group(1).strip())
        try:
            rgb = tuple(_clamp_channel(parts[i]) for i in range(3))
            alpha = _clamp_alpha(parts[3]) if len(parts) > 3 else 1.0
        except (IndexError, ValueError):
            return None
        return rgb, alpha  # type: ignore[return-value]

    match = _HSL.search(text)
    if match:
        parts = re.split(r"[,\s/]+", match.group(1).strip())
        try:
            hue = float(parts[0].replace("deg", "")) % 360
            saturation = float(parts[1].rstrip("%")) / 100
            lightness = float(parts[2].rstrip("%")) / 100
            alpha = _clamp_alpha(parts[3]) if len(parts) > 3 else 1.0
        except (IndexError, ValueError):
            return None
        return _hsl_to_rgb(hue, saturation, lightness), alpha

    return None


def composite(
    top: tuple[tuple[int, int, int], float], base: tuple[int, int, int]
) -> tuple[int, int, int]:
    """Flatten a semi-transparent color over an opaque backdrop."""

    (red, green, blue), alpha = top
    if alpha >= 1:
        return red, green, blue
    return tuple(  # type: ignore[return-value]
        round(channel * alpha + backdrop * (1 - alpha))
        for channel, backdrop in ((red, base[0]), (green, base[1]), (blue, base[2]))
    )


def _clamp_alpha(raw: str) -> float:
    text = raw.strip()
    if text.endswith("%"):
        return max(0.0, min(1.0, float(text[:-1]) / 100))
    return max(0.0, min(1.0, float(text)))


def _clamp_channel(raw: str) -> int:
    text = raw.strip()
    if text.endswith("%"):
        return round(max(0.0, min(100.0, float(text[:-1]))) * 255 / 100)
    return max(0, min(255, round(float(text))))


def _hsl_to_rgb(hue: float, saturation: float, lightness: float) -> tuple[int, int, int]:
    chroma = (1 - abs(2 * lightness - 1)) * saturation
    segment = hue / 60
    second = chroma * (1 - abs(segment % 2 - 1))
    table = [
        (chroma, second, 0.0),
        (second, chroma, 0.0),
        (0.0, chroma, second),
        (0.0, second, chroma),
        (second, 0.0, chroma),
        (chroma, 0.0, second),
    ]
    red, green, blue = table[min(int(segment), 5)]
    offset = lightness - chroma / 2
    return (
        round((red + offset) * 255),
        round((green + offset) * 255),
        round((blue + offset) * 255),
    )


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    channels = []
    for raw in rgb:
        value = raw / 255
        channels.append(value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4)
    red, green, blue = channels
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground: tuple[int, int, int], background: tuple[int, int, int]) -> float:
    light = relative_luminance(foreground)
    dark = relative_luminance(background)
    if light < dark:
        light, dark = dark, light
    return (light + 0.05) / (dark + 0.05)


def wcag_level(ratio: float, *, large_text: bool) -> str:
    aa = 3.0 if large_text else 4.5
    aaa = 4.5 if large_text else 7.0
    if ratio >= aaa:
        return "AAA"
    if ratio >= aa:
        return "AA"
    return "FAIL"

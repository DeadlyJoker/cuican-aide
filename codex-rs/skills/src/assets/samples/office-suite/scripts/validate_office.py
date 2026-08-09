#!/usr/bin/env python3
"""Validate a generated office file before reporting it as a deliverable.

Checks performed:
  * the OOXML zip container opens and contains the expected part
  * the file reopens through its own library (catches corrupt XML)
  * content is non-trivial (paragraph / slide / row counts above zero)
  * placeholder text such as TODO / TBD / lorem ipsum is flagged

Exit code 0 means the file is safe to hand to the user.

Usage:
    python validate_office.py out/report.docx
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from officelib import env  # noqa: E402

env.reexec_in_environment()

PLACEHOLDER = re.compile(r"\b(todo|tbd|lorem ipsum|xxx|placeholder|填写此处)\b", re.IGNORECASE)

REQUIRED_PARTS = {
    ".docx": "word/document.xml",
    ".dotx": "word/document.xml",
    ".pptx": "ppt/presentation.xml",
    ".xlsx": "xl/workbook.xml",
    ".xlsm": "xl/workbook.xml",
}


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.facts: list[str] = []

    def fail(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def fact(self, message: str) -> None:
        self.facts.append(message)

    def render(self, path: Path) -> str:
        lines = [f"file: {path}", f"size: {path.stat().st_size} bytes"]
        lines.extend(f"info: {fact}" for fact in self.facts)
        lines.extend(f"warn: {warning}" for warning in self.warnings)
        lines.extend(f"FAIL: {error}" for error in self.errors)
        lines.append("result: FAIL" if self.errors else "result: PASS")
        return "\n".join(lines)


def check_container(path: Path, report: Report) -> None:
    required = REQUIRED_PARTS.get(path.suffix.lower())
    if required is None:
        return
    try:
        with zipfile.ZipFile(path) as archive:
            broken = archive.testzip()
            if broken:
                report.fail(f"corrupt zip entry: {broken}")
            names = set(archive.namelist())
            if required not in names:
                report.fail(f"missing required part: {required}")
            report.fact(f"parts: {len(names)}")
    except zipfile.BadZipFile as error:
        report.fail(f"not a valid OOXML container: {error}")


def check_docx(path: Path, report: Report) -> None:
    from docx import Document

    document = Document(str(path))
    paragraphs = [p.text for p in document.paragraphs if p.text.strip()]
    report.fact(f"paragraphs: {len(paragraphs)}, tables: {len(document.tables)}")
    if not paragraphs and not document.tables:
        report.fail("document has no visible content")
    _flag_placeholders("\n".join(paragraphs), report)
    for index, table in enumerate(document.tables):
        widths = {len(row.cells) for row in table.rows}
        if len(widths) > 1:
            report.warn(f"table {index} has ragged rows: {sorted(widths)}")


def check_pptx(path: Path, report: Report) -> None:
    from pptx import Presentation

    presentation = Presentation(str(path))
    slides = list(presentation.slides)
    report.fact(f"slides: {len(slides)}")
    if not slides:
        report.fail("presentation has no slides")

    slide_w = presentation.slide_width
    slide_h = presentation.slide_height
    texts: list[str] = []
    for index, slide in enumerate(slides, start=1):
        has_text = False
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                has_text = True
                texts.append(shape.text_frame.text)
            if shape.left is None or shape.top is None:
                continue
            right = shape.left + (shape.width or 0)
            bottom = shape.top + (shape.height or 0)
            if shape.left < 0 or shape.top < 0 or right > slide_w or bottom > slide_h:
                report.warn(f"slide {index}: shape `{shape.shape_type}` overflows the slide bounds")
        if not has_text:
            report.warn(f"slide {index} has no text")
    _flag_placeholders("\n".join(texts), report)


def check_xlsx(path: Path, report: Report) -> None:
    from openpyxl import load_workbook

    workbook = load_workbook(str(path))
    report.fact(f"sheets: {[ws.title for ws in workbook.worksheets]}")
    if not workbook.worksheets:
        report.fail("workbook has no sheets")
    total_cells = 0
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows(values_only=True):
            total_cells += sum(1 for value in row if value is not None)
    report.fact(f"non-empty cells: {total_cells}")
    if total_cells == 0:
        report.fail("workbook has no data")


def check_pdf(path: Path, report: Report) -> None:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    report.fact(f"pages: {len(reader.pages)}")
    if not reader.pages:
        report.fail("pdf has no pages")


def _flag_placeholders(text: str, report: Report) -> None:
    found = sorted({match.group(0).lower() for match in PLACEHOLDER.finditer(text)})
    if found:
        report.warn(f"placeholder text present: {', '.join(found)}")


CHECKERS = {
    ".docx": check_docx,
    ".dotx": check_docx,
    ".pptx": check_pptx,
    ".xlsx": check_xlsx,
    ".xlsm": check_xlsx,
    ".pdf": check_pdf,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a generated office document")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args(argv)

    failed = False
    for raw in args.paths:
        path = Path(raw).expanduser()
        report = Report()
        if not path.is_file():
            print(f"FAIL: file not found: {path}", file=sys.stderr)
            failed = True
            continue

        checker = CHECKERS.get(path.suffix.lower())
        if checker is None:
            print(f"skip: unsupported extension {path.suffix} ({path})")
            continue

        check_container(path, report)
        if not report.errors:
            try:
                checker(path, report)
            except Exception as error:  # noqa: BLE001 - any reopen failure is a validation failure
                report.fail(f"library failed to reopen the file: {error}")

        print(report.render(path))
        print()
        failed = failed or bool(report.errors)

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

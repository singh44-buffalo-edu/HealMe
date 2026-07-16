"""Markdown-lite → PDF via reportlab. Handles the subset the Health Review
emits: #/##/### headings, bullet lists, bold via **, plain paragraphs.

Used only by health_review._store_review to produce the printable rendition
(FHIR-MAPPING: Health Review output = DocumentReference + Binary PDF). Pure
function of its inputs — no FHIR, no network, no state. If the Health Review
prompt ever emits richer markdown (tables, links), extend the parser here."""

from __future__ import annotations

import io
import re

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer


def _inline(text: str) -> str:
    """Escape XML entities FIRST (reportlab Paragraphs parse mini-XML — raw
    '<' in model output would crash the build), then map **bold** → <b>."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)


def markdown_to_pdf(markdown: str, title: str) -> bytes:
    """Render markdown-lite to A4 PDF bytes; `title` becomes the PDF document
    title. Line-oriented single pass — consecutive bullets buffer into one
    ListFlowable (flush_bullets) so lists keep their spacing."""
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("HMD-H1", parent=styles["Heading1"], spaceAfter=6)
    h2 = ParagraphStyle("HMD-H2", parent=styles["Heading2"], spaceBefore=10, spaceAfter=4)
    h3 = ParagraphStyle("HMD-H3", parent=styles["Heading3"], spaceBefore=8, spaceAfter=3)
    body = ParagraphStyle("HMD-Body", parent=styles["BodyText"], spaceAfter=4, leading=14)

    flow = []
    bullets: list[str] = []

    def flush_bullets() -> None:
        nonlocal bullets
        if bullets:
            flow.append(
                ListFlowable(
                    [ListItem(Paragraph(_inline(b), body)) for b in bullets],
                    bulletType="bullet",
                    leftIndent=14,
                )
            )
            bullets = []

    for raw in markdown.splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush_bullets()
            flow.append(Spacer(1, 3))
        elif line.startswith("### "):
            flush_bullets()
            flow.append(Paragraph(_inline(line[4:]), h3))
        elif line.startswith("## "):
            flush_bullets()
            flow.append(Paragraph(_inline(line[3:]), h2))
        elif line.startswith("# "):
            flush_bullets()
            flow.append(Paragraph(_inline(line[2:]), h1))
        elif line.lstrip().startswith(("- ", "* ")):
            bullets.append(line.lstrip()[2:])
        else:
            flush_bullets()
            flow.append(Paragraph(_inline(line), body))
    flush_bullets()

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        title=title,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
    )
    doc.build(flow)
    return buffer.getvalue()

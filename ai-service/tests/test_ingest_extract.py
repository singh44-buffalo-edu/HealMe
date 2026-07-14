import io

from pypdf import PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.ingest import ALLOWED_TYPES, extract_text


def _text_pdf(text: str) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    y = 800
    for line in text.splitlines():
        c.drawString(50, y, line)
        y -= 14
    c.save()
    return buf.getvalue()


def test_extract_text_from_digital_pdf():
    text = "Hemoglobin 13.5 g/dL (reference 13.0 - 17.0)\n" * 20
    data = _text_pdf(text)
    extracted, method = extract_text(data, "application/pdf")
    assert method == "pdf-text"
    assert "Hemoglobin 13.5" in extracted


def test_blank_pdf_falls_back_to_ocr():
    writer = PdfWriter()
    writer.add_blank_page(width=595, height=842)
    buf = io.BytesIO()
    writer.write(buf)
    extracted, method = extract_text(buf.getvalue(), "application/pdf")
    assert method == "ocr"
    assert extracted == ""


def test_allowed_types():
    assert "application/pdf" in ALLOWED_TYPES
    assert "image/png" in ALLOWED_TYPES

"""pdfgen.markdown_to_pdf: the Health Review markdown subset (headings,
bullets, bold, XML-escaping of model output) renders to valid PDF bytes."""

import io

from app.pdfgen import markdown_to_pdf


def test_markdown_to_pdf_produces_pdf_bytes():
    md = (
        "# Health Review\n\n"
        "> **Not medical advice.**\n\n"
        "## Medications\n"
        "- Sample Medication A — **92%** adherence\n"
        "- Sample Medication B\n\n"
        "Plain paragraph with <angle brackets> & ampersand.\n"
    )
    pdf = markdown_to_pdf(md, title="Test Review")
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 500


def test_footer_disclaimer_and_page_number_on_every_page():
    """The disclaimer footer must appear on EVERY page (it can't scroll off),
    reinforcing the every-summary-carries-a-disclaimer rule."""
    from pypdf import PdfReader

    # Enough content to force a second page.
    body = "\n\n".join(f"Paragraph {i} with some text to fill the page." for i in range(120))
    disclaimer = "Not medical advice — a discussion aid; review with a qualified clinician."
    pdf = markdown_to_pdf(
        f"# Health Review\n\n{body}",
        title="HealMeDaily Health Review",
        footer_note=disclaimer,
        subtitle="Window: last 90 days · generated 2026-07-17",
    )
    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) >= 2, "test needs a multi-page document"
    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        assert "Not medical advice" in text, f"disclaimer missing on page {i + 1}"
        assert f"Page {i + 1}" in text, f"page number missing on page {i + 1}"
        assert "HealMeDaily Health Review" in text, f"header title missing on page {i + 1}"

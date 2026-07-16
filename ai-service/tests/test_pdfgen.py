"""pdfgen.markdown_to_pdf: the Health Review markdown subset (headings,
bullets, bold, XML-escaping of model output) renders to valid PDF bytes."""

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

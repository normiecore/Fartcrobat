"""Fixtures for the digital-signatures feature.

unsigned-field.pdf: tests/fixtures/text.pdf with an empty, visible signature field "Approver"
near the bottom of page 1 (the kind of field Acrobat's "Prepare a form" adds).

Run from the repository root:  python3 tests/fixtures/digital-signatures/make_fixtures.py
"""
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "text.pdf"


def make_unsigned_field() -> None:
    writer = PdfWriter(clone_from=PdfReader(str(SRC)))
    page = writer.pages[0]
    top = float(page.mediabox.top)
    # Page-space (top-left origin) box 340,640 - 560,700 in PDF user space.
    x0, y0, x1, y1 = 340, top - 700, 560, top - 640
    widget = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Sig"),
            NameObject("/T"): TextStringObject("Approver"),
            NameObject("/TU"): TextStringObject("Sign here to approve"),
            NameObject("/F"): NumberObject(4),
            NameObject("/Rect"): ArrayObject([FloatObject(x0), FloatObject(y0), FloatObject(x1), FloatObject(y1)]),
            NameObject("/P"): page.indirect_reference,
        }
    )
    ref = writer._add_object(widget)
    annots = page.get("/Annots")
    if annots is None:
        page[NameObject("/Annots")] = ArrayObject([ref])
    else:
        annots.get_object().append(ref)
    root = writer._root_object
    acro = DictionaryObject({NameObject("/Fields"): ArrayObject([ref]), NameObject("/SigFlags"): NumberObject(1)})
    root[NameObject("/AcroForm")] = writer._add_object(acro)
    with open(HERE / "unsigned-field.pdf", "wb") as f:
        writer.write(f)


if __name__ == "__main__":
    make_unsigned_field()
    print("wrote", HERE / "unsigned-field.pdf")

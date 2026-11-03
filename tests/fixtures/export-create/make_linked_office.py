"""Generates Office documents whose images are linked (not embedded), for the LibreOffice
conversion tests: converting them must not fetch the linked images.

Run: python3 tests/fixtures/export-create/make_linked_office.py   (outputs are committed next to this file)

Each document links one image over HTTP (http://127.0.0.1:47613/linked.png) and one from the
local disk (file:///tmp/fartcrobat-linked-image-test.png). Only the standard library is needed.
"""
import os
import zipfile

OUT = os.path.dirname(os.path.abspath(__file__))
HTTP_URL = 'http://127.0.0.1:47613/linked.png'
FILE_URL = 'file:///tmp/fartcrobat-linked-image-test.png'


def write_zip(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            # ODF wants the mimetype entry first and stored.
            info.compress_type = zipfile.ZIP_STORED if name == 'mimetype' else zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def docx_picture(rid, n):
    return f'''<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="1828800" cy="1828800"/><wp:docPr id="{n}" name="Picture {n}"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="{n}" name="linked{n}.png"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:link="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'''


def linked_docx():
    document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>
<w:p><w:r><w:t>Linked images document</w:t></w:r></w:p>
{docx_picture('rIdHttp', 1)}
{docx_picture('rIdFile', 2)}
<w:sectPr/></w:body></w:document>'''
    rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdHttp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{HTTP_URL}" TargetMode="External"/>
<Relationship Id="rIdFile" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{FILE_URL}" TargetMode="External"/>
</Relationships>'''
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
    root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
    write_zip(
        os.path.join(OUT, 'linked-image.docx'),
        [
            ('[Content_Types].xml', content_types),
            ('_rels/.rels', root_rels),
            ('word/document.xml', document),
            ('word/_rels/document.xml.rels', rels),
        ],
    )


def linked_odt():
    content = f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
<office:body><office:text>
<text:p>Linked images document</text:p>
<text:p><draw:frame draw:name="Http" text:anchor-type="as-char" svg:width="2in" svg:height="2in"><draw:image xlink:href="{HTTP_URL}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>
<text:p><draw:frame draw:name="File" text:anchor-type="as-char" svg:width="2in" svg:height="2in"><draw:image xlink:href="{FILE_URL}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>
</office:text></office:body></office:document-content>'''
    manifest = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>'''
    write_zip(
        os.path.join(OUT, 'linked-image.odt'),
        [
            ('mimetype', 'application/vnd.oasis.opendocument.text'),
            ('content.xml', content),
            ('META-INF/manifest.xml', manifest),
        ],
    )


if __name__ == '__main__':
    linked_docx()
    linked_odt()

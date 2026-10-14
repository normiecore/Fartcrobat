"""Make PubSec test files in layouts the earlier spikes did not cover.
Usage: python -I make_variants.py <cert.pem> <key.pem> <outdir>"""
import sys
from pathlib import Path
from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.generic import pdf_name, pdf_string
from pyhanko.pdf_utils.crypt import PubKeySecurityHandler, SimpleEnvelopeKeyDecrypter
from pyhanko.pdf_utils.crypt.api import SecurityHandlerVersion
from pyhanko.pdf_utils.writer import PdfFileWriter
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader

cert_path, key_path, outdir = sys.argv[1:4]
out = Path(outdir)
cert = load_cert_from_pemder(cert_path)

def build(sh, stream_xrefs, use_objstm):
    w = PdfFileWriter(stream_xrefs=stream_xrefs, init_page_tree=True)
    w._assign_security_handler(sh)
    content = generic.StreamObject(stream_data=b'BT /F1 24 Tf 72 700 Td (Hello secret world) Tj ET')
    font = generic.DictionaryObject({pdf_name('/Type'): pdf_name('/Font'), pdf_name('/Subtype'): pdf_name('/Type1'), pdf_name('/BaseFont'): pdf_name('/Helvetica')})
    objstm = w.prepare_object_stream() if use_objstm else None
    annot = generic.DictionaryObject({
        pdf_name('/Type'): pdf_name('/Annot'), pdf_name('/Subtype'): pdf_name('/Text'),
        pdf_name('/Rect'): generic.ArrayObject([generic.NumberObject(x) for x in (72, 600, 92, 620)]),
        pdf_name('/Contents'): pdf_string('Note text in an object stream')})
    annot_ref = w.add_object(annot, obj_stream=objstm)
    font_ref = w.add_object(font, obj_stream=objstm)
    page = generic.DictionaryObject({
        pdf_name('/Type'): pdf_name('/Page'),
        pdf_name('/MediaBox'): generic.ArrayObject([generic.NumberObject(x) for x in (0, 0, 612, 792)]),
        pdf_name('/Contents'): w.add_object(content),
        pdf_name('/Resources'): generic.DictionaryObject({pdf_name('/Font'): generic.DictionaryObject({pdf_name('/F1'): font_ref})}),
        pdf_name('/Annots'): generic.ArrayObject([annot_ref])})
    w.insert_page(page)
    w._info = w.add_object(generic.DictionaryObject({pdf_name('/Title'): pdf_string('Secret title')}), obj_stream=objstm)
    w._update_meta_dict = lambda *a, **k: None
    return w

def handler(version, keylen, aes=True):
    return PubKeySecurityHandler.build_from_certs([cert], keylen_bytes=keylen, version=version, use_aes=aes, pdf_mac=False)

variants = {
    'v5-xrefstream-objstm.pdf': (handler(SecurityHandlerVersion.AES256, 32), True, True),
    'v5-classic.pdf': (handler(SecurityHandlerVersion.AES256, 32), False, False),
    'v4-aes128-xrefstream-objstm.pdf': (handler(SecurityHandlerVersion.RC4_OR_AES128, 16), True, True),
    'v4-aes128-classic.pdf': (handler(SecurityHandlerVersion.RC4_OR_AES128, 16), False, False),
    'v4-rc4-classic.pdf': (handler(SecurityHandlerVersion.RC4_OR_AES128, 16, aes=False), False, False),
}
for name, (sh, xs, os_) in variants.items():
    w = build(sh, xs, os_)
    with open(out / name, 'wb') as f:
        w.write(f)
    print('wrote', name, (out / name).stat().st_size)

# Incremental update on top of a V5 xref-stream file: change the title in a new section.
src = out / 'v5-xrefstream-objstm.pdf'
with open(src, 'rb') as f:
    data = f.read()
import io
buf = io.BytesIO(data)
iw = IncrementalPdfFileWriter(buf)
dec = SimpleEnvelopeKeyDecrypter.load(key_path, cert_path, key_passphrase=None)
print('incremental auth', iw.prev.decrypt_pubkey(dec).status)
info = generic.DictionaryObject({pdf_name('/Title'): pdf_string('Updated secret title')})
ref = iw.add_object(info)
iw.trailer_view if False else None
iw._info = ref
iw.update_root()
iw.write_in_place()
(out / 'v5-incremental.pdf').write_bytes(buf.getvalue())
print('wrote v5-incremental.pdf', len(buf.getvalue()))

# Check every file with pyHanko.
for p in sorted(out.glob('*.pdf')):
    with open(p, 'rb') as f:
        r = PdfFileReader(f)
        st = r.decrypt_pubkey(SimpleEnvelopeKeyDecrypter.load(key_path, cert_path, key_passphrase=None))
        enc = r.trailer_view['/Encrypt']
        title = r.trailer_view['/Info'].get_object().get('/Title') if '/Info' in r.trailer_view else None
        print(p.name, 'V', enc.get('/V'), 'auth', st.status, 'title', title, 'xrefstream', b'/XRef' in p.read_bytes(), 'objstm', b'/ObjStm' in p.read_bytes(), 'sections', p.read_bytes().count(b'%%EOF'))

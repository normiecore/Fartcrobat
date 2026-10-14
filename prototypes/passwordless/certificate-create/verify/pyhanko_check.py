"""Independent check of a certificate-encrypted PDF with pyHanko.

Decrypts <encrypted.pdf> with the recipient's key, then compares its whole object graph (from
/Root and /Info) with <plain.pdf>: same shape, same keys, same strings, same decoded stream data
(object numbers, stream /Length and stream encodings are allowed to differ). Also prints readable
facts (pages, annotations, outline, fields, attachments) and scans the raw encrypted bytes for
plaintext strings of the source that should have been encrypted.

Usage: python -I pyhanko_check.py <plain.pdf> <encrypted.pdf> <cert.pem> <key.pem> [--json out.json]
"""
import hashlib
import json
import sys

from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.crypt import SimpleEnvelopeKeyDecrypter
from pyhanko.pdf_utils.crypt.api import AuthStatus
from pyhanko.pdf_utils.reader import PdfFileReader

STREAM_ENCODING_KEYS = {'/Length', '/Filter', '/DecodeParms', '/DL'}

# MuPDF writes empty strings as <> without encrypting them (also in its own password-encrypted
# saves); pyHanko then fails with "Invalid IV size (0)". Count those instead of failing, so the
# rest of the comparison still runs.
from pyhanko.pdf_utils.crypt import filter_mixins as _fm

_real_aes_cbc_decrypt = _fm.aes_cbc_decrypt
UNENCRYPTED_EMPTY = [0]


def _tolerant_aes_cbc_decrypt(key, data, iv):
    if len(iv) == 0 and len(data) == 0:
        UNENCRYPTED_EMPTY[0] += 1
        return b''
    return _real_aes_cbc_decrypt(key, data, iv)


_fm.aes_cbc_decrypt = _tolerant_aes_cbc_decrypt


def sha(b):
    return hashlib.sha256(b).hexdigest()[:16]


def string_bytes(s):
    if isinstance(s, generic.TextStringObject):
        return bytes(s.original_bytes)
    return bytes(s)


class Canon:
    """Canonical form of an object graph: indirect objects numbered in DFS order."""

    def __init__(self):
        self.ids = {}
        self.strings = []
        self.sig_contents = []

    def walk(self, obj, depth=0):
        if depth > 400:
            return '<too deep>'
        if isinstance(obj, generic.IndirectObject):
            key = (obj.idnum, obj.generation)
            if key in self.ids:
                return {'ref': self.ids[key]}
            self.ids[key] = len(self.ids)
            return {'obj': self.ids[key], 'v': self.walk(obj.get_object(), depth + 1)}
        if isinstance(obj, generic.DecryptedObjectProxy):
            return self.walk(obj.decrypted, depth)
        if isinstance(obj, generic.StreamObject):
            d = {k: self.walk(obj.raw_get(k), depth + 1) for k in sorted(obj.keys()) if k not in STREAM_ENCODING_KEYS}
            try:
                data = obj.data
                d['#data'] = sha(data)
            except Exception as e:  # unsupported filter (DCT, JBIG2...): compare encoded bytes
                data = obj.encoded_data
                d['#raw'] = sha(data)
            return {'stream': d}
        if isinstance(obj, generic.DictionaryObject):
            out = {}
            for k in sorted(obj.keys()):
                sig_contents = k == '/Contents' and '/ByteRange' in obj
                raw = None if sig_contents else obj.raw_get(k)
                if k == '/Metadata' and isinstance(raw, generic.IndirectObject):
                    # obj['/Metadata'] is how pyHanko applies /EncryptMetadata false
                    key = (raw.idnum, raw.generation)
                    if key in self.ids:
                        out[k] = {'ref': self.ids[key]}
                    else:
                        self.ids[key] = len(self.ids)
                        out[k] = {'obj': self.ids[key], 'v': self.walk(obj[k], depth + 1)}
                elif k == '/Contents' and '/ByteRange' in obj:
                    # signature /Contents is never encrypted (ISO 32000-2 7.6.2)
                    v = obj.raw_get(k, generic.EncryptedObjAccess.RAW)
                    self.sig_contents.append(string_bytes(v))
                    out[k] = {'str': string_bytes(v).hex()}
                else:
                    out[k] = self.walk(raw, depth + 1)
            return out
        if isinstance(obj, generic.ArrayObject):
            return [self.walk(obj.raw_get(i), depth + 1) for i in range(len(obj))]
        if isinstance(obj, (generic.TextStringObject, generic.ByteStringObject)):
            b = string_bytes(obj)
            self.strings.append(b)
            return {'str': b.hex()}
        if isinstance(obj, generic.NameObject):
            return str(obj)
        if isinstance(obj, generic.BooleanObject):
            return bool(obj)
        if isinstance(obj, generic.NullObject):
            return None
        if isinstance(obj, (generic.FloatObject, generic.NumberObject)):
            # MuPDF writes whole reals as integers (0.0 -> 0) on every save; compare values
            return round(float(obj), 4)
        return repr(obj)


def graph(reader):
    c = Canon()
    t = reader.trailer
    g = {'Root': c.walk(t.raw_get('/Root'))}
    if '/Info' in t:
        g['Info'] = c.walk(t.raw_get('/Info'))
    return g, c


def diff(a, b, path='', out=None, limit=40):
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if type(a) != type(b):
        out.append(f'{path}: {short(a)} != {short(b)}')
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f'{path}/{k}: only in encrypted: {short(b[k])}')
            elif k not in b:
                out.append(f'{path}/{k}: missing in encrypted (was {short(a[k])})')
            else:
                diff(a[k], b[k], f'{path}/{k}', out, limit)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f'{path}: array length {len(a)} != {len(b)}')
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f'{path}[{i}]', out, limit)
    elif a != b:
        out.append(f'{path}: {short(a)} != {short(b)}')
    return out


def short(v):
    s = json.dumps(v)
    return s if len(s) < 90 else s[:87] + '...'


def text(s):
    if s is None:
        return None
    if isinstance(s, generic.TextStringObject):
        return str(s)
    try:
        return bytes(s).decode('latin1')
    except Exception:
        return repr(s)


def g(d, key, default=None):
    """dict.get that decrypts (pyHanko's .get() can hand out undecrypted proxies)."""
    return d[key] if key in d else default


def facts(reader):
    root = reader.root
    f = {}
    pages = []

    def collect(node):
        node = node.get_object()
        if g(node, '/Type') == '/Pages':
            for k in node['/Kids']:
                collect(k)
        else:
            pages.append(node)

    collect(root.raw_get('/Pages'))
    f['pages'] = len(pages)
    annots = []
    for i, p in enumerate(pages):
        for a in g(p, '/Annots', []) or []:
            a = a.get_object()
            annots.append(f"p{i + 1}:{str(g(a, '/Subtype'))[1:]}" + (f"({text(g(a, '/Contents'))!r})" if g(a, '/Contents') else ''))
    f['annotations'] = annots
    outline = []
    if '/Outlines' in root and '/First' in root['/Outlines']:
        def walk_ol(item, depth):
            while item is not None:
                item = item.get_object()
                outline.append('  ' * depth + (text(g(item, '/Title')) or ''))
                if '/First' in item:
                    walk_ol(item['/First'], depth + 1)
                item = g(item, '/Next')
        walk_ol(root['/Outlines']['/First'], 0)
    f['outline'] = outline
    fields = []
    if '/AcroForm' in root:
        def walk_f(node, prefix):
            node = node.get_object()
            name = prefix
            if '/T' in node:
                name = (prefix + '.' if prefix else '') + text(node['/T'])
            kids = g(node, '/Kids')
            if kids and any('/T' in k.get_object() for k in kids):
                for k in kids:
                    walk_f(k, name)
            else:
                v = g(node, '/V')
                fields.append(f"{name} [{str(g(node, '/FT'))[1:] if g(node, '/FT') else '?'}] = {text(v) if isinstance(v, (generic.TextStringObject, generic.ByteStringObject)) else v}")
        for fld in g(root['/AcroForm'], '/Fields', []):
            walk_f(fld, '')
    f['fields'] = fields
    files = []
    names = g(root, '/Names')
    if names is not None and '/EmbeddedFiles' in names:
        def walk_nt(node):
            node = node.get_object()
            if '/Names' in node:
                arr = node['/Names']
                for i in range(0, len(arr), 2):
                    spec = arr[i + 1].get_object()
                    ef = g(spec, '/EF')
                    data = ef['/F'].get_object().data if ef is not None else b''
                    files.append(f'{text(arr[i])}: {len(data)} bytes sha {sha(data)}')
            for k in g(node, '/Kids', []) or []:
                walk_nt(k)
        walk_nt(names['/EmbeddedFiles'])
    f['attachments'] = files
    info = reader.trailer['/Info'] if '/Info' in reader.trailer else {}
    f['info'] = {k: text(info[k]) for k in sorted(info.keys()) if isinstance(info[k], (generic.TextStringObject, generic.ByteStringObject))}
    if '/StructTreeRoot' in root:
        n = 0
        stack = [root['/StructTreeRoot']]
        seen = set()
        while stack:
            e = stack.pop()
            if isinstance(e, generic.IndirectObject):
                if e.idnum in seen:
                    continue
                seen.add(e.idnum)
            e = e.get_object()
            if isinstance(e, generic.DictionaryObject):
                if g(e, '/Type') != '/MCR' and g(e, '/Type') != '/OBJR':
                    n += 1
                k = e.raw_get('/K') if '/K' in e else None
                if isinstance(k, generic.ArrayObject):
                    stack.extend(k.raw_get(i) for i in range(len(k)))
                elif k is not None:
                    stack.append(k)
            elif isinstance(e, generic.ArrayObject):
                stack.extend(e.raw_get(i) for i in range(len(e)))
        f['struct_elements'] = n
    if '/Metadata' in root:
        m = root['/Metadata'].get_object()
        f['metadata'] = f'{len(m.data)} bytes, xpacket={m.data.lstrip().startswith(b"<?xpacket")}'
    return f


def main():
    plain_path, enc_path, cert, key = sys.argv[1:5]
    out_json = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
    with open(plain_path, 'rb') as fp:
        plain = PdfFileReader(fp, strict=False)
        g_plain, c_plain = graph(plain)
        f_plain = facts(plain)
    raw = open(enc_path, 'rb').read()
    with open(enc_path, 'rb') as fe:
        enc = PdfFileReader(fe, strict=True)
        ed = enc.trailer.raw_get('/Encrypt').get_object()
        print('encrypt:', str(ed.get('/Filter')), str(ed.get('/SubFilter')), 'V', ed.get('/V'),
              'recipients', len(ed['/CF']['/DefaultCryptFilter']['/Recipients']))
        res = enc.decrypt_pubkey(SimpleEnvelopeKeyDecrypter.load(key, cert, key_passphrase=None))
        print('decrypt_pubkey:', res.status, 'permissions', hex(res.permission_flags.as_uint32()) if res.permission_flags is not None else None)
        if res.status not in (AuthStatus.USER, AuthStatus.OWNER):
            print('RESULT: FAILED to decrypt')
            sys.exit(2)
        g_enc, c_enc = graph(enc)
        f_enc = facts(enc)
    for k in f_plain:
        same = f_plain[k] == f_enc.get(k)
        val = f_enc.get(k)
        shown = val if not isinstance(val, list) or len(val) <= 8 else val[:8] + [f'... {len(val)} items']
        print(f"  {k}: {'same' if same else 'DIFFERENT'}: {shown}")
        if not same:
            print(f'     plain: {f_plain[k]}')
    d = diff(g_plain, g_enc)
    print(f'graph objects: plain {len(c_plain.ids)}, encrypted {len(c_enc.ids)}; differences: {len(d)}{"+" if len(d) >= 40 else ""}')
    for line in d[:25]:
        print('   ', line)
    print(f'empty strings stored unencrypted (<>): {UNENCRYPTED_EMPTY[0]} reads')
    raw_lower = raw.lower()

    def present(b):  # as raw bytes (literal string) or as hex (hex string)
        return raw.find(b) >= 0 or raw_lower.find(b.hex().encode()) >= 0

    sig = set(c_plain.sig_contents)
    leaks = sorted({s for s in c_plain.strings if len(s) >= 8 and s not in sig and present(s)})
    print(f'signature /Contents present unencrypted (required by the spec): {sum(1 for s in sig if present(s))} of {len(sig)}')
    print(f'plaintext strings of the source found in the encrypted bytes: {len(leaks)}', [s[:40] for s in leaks[:5]])
    print('RESULT:', 'IDENTICAL GRAPH' if not d else 'GRAPH DIFFERS', '| no leaks' if not leaks else '| LEAKS')
    if out_json:
        json.dump({'facts_plain': f_plain, 'facts_enc': f_enc, 'diff': d, 'leaks': [s.hex() for s in leaks]}, open(out_json, 'w'), indent=1)


main()

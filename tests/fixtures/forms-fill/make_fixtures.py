"""Generates the forms-fill test fixtures (requires reportlab and pypdf).

Run: python3 tests/fixtures/forms-fill/make_fixtures.py [calc] [all-fields] [xfa] [signed]   (outputs are committed next to this script)

calc.pdf       an order form with Acrobat-style JavaScript: number/percent/date/special formats,
               keystroke filters, a range validation and calculated totals (AFSimple_Calculate and a
               custom `event.value = ...` script), with a /CO calculation order.
all-fields.pdf every interactive field type on two pages: list boxes (single and multi-select),
               editable combo box, combo box with export values, password, comb, read-only and required
               fields, push buttons (reset, submit, JavaScript), an unsigned signature field.
xfa.pdf        calc.pdf with an /XFA form description added (a "dynamic XFA" form whose static AcroForm
               fields are still fillable).
signed.pdf     all-fields.pdf whose signature field carries a signature dictionary (signer name and time;
               no real PKCS#7 data: enough to show the signed state, not to validate it).
"""
import io
import os

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))


def js(code):
    return DictionaryObject({
        NameObject('/S'): NameObject('/JavaScript'),
        NameObject('/JS'): TextStringObject(code),
    })


def field_map(writer):
    """name -> (annotation dict, indirect ref) for every widget with a /T."""
    out = {}
    for page in writer.pages:
        for ref in page.get('/Annots', []):
            annot = ref.get_object()
            name = annot.get('/T')
            if name is None and '/Parent' in annot:
                name = annot['/Parent'].get_object().get('/T')
            if name is not None:
                out.setdefault(str(name), (annot, ref))
    return out


def set_actions(fields, name, **actions):
    annot, _ = fields[name]
    aa = DictionaryObject()
    for key, code in actions.items():
        aa[NameObject('/' + key)] = js(code)
    annot[NameObject('/AA')] = aa


def appearance(writer, w, h, caption, bg=(0.88, 0.88, 0.88)):
    content = (
        f'{bg[0]} {bg[1]} {bg[2]} rg 0 0 {w} {h} re f 0.4 G 1 w 0.5 0.5 {w - 1} {h - 1} re S '
    )
    if caption:
        content += f'BT /Helv 10 Tf 0 g {w / 2 - len(caption) * 2.6:.1f} {h / 2 - 3.5:.1f} Td ({caption}) Tj ET'
    stream = StreamObject()
    stream.set_data(content.encode('latin-1'))
    stream.update({
        NameObject('/Type'): NameObject('/XObject'),
        NameObject('/Subtype'): NameObject('/Form'),
        NameObject('/BBox'): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(w), FloatObject(h)]),
        NameObject('/Resources'): DictionaryObject({
            NameObject('/Font'): DictionaryObject({NameObject('/Helv'): writer._root_object['/AcroForm']['/DR']['/Font']['/Helv']})
        }),
    })
    return writer._add_object(stream)


def add_widget(writer, page_index, name, rect, ft, ff=0, extra=None, caption=None):
    page = writer.pages[page_index]
    x0, y0, x1, y1 = rect
    widget = DictionaryObject({
        NameObject('/Type'): NameObject('/Annot'),
        NameObject('/Subtype'): NameObject('/Widget'),
        NameObject('/FT'): NameObject(ft),
        NameObject('/T'): TextStringObject(name),
        NameObject('/Rect'): ArrayObject([FloatObject(v) for v in rect]),
        NameObject('/F'): NumberObject(4),
        NameObject('/Ff'): NumberObject(ff),
        NameObject('/DA'): TextStringObject('/Helv 10 Tf 0 g'),
        NameObject('/P'): page.indirect_reference,
        NameObject('/AP'): DictionaryObject({NameObject('/N'): appearance(writer, x1 - x0, y1 - y0, caption,
                                                                          (0.88, 0.88, 0.88) if caption else (1, 1, 1))}),
    })
    if caption:
        widget[NameObject('/MK')] = DictionaryObject({
            NameObject('/CA'): TextStringObject(caption),
            NameObject('/BG'): ArrayObject([FloatObject(0.88)] * 3),
            NameObject('/BC'): ArrayObject([FloatObject(0.4)] * 3),
        })
    for k, v in (extra or {}).items():
        widget[NameObject(k)] = v
    ref = writer._add_object(widget)
    if '/Annots' not in page:
        page[NameObject('/Annots')] = ArrayObject()
    page['/Annots'].append(ref)
    writer._root_object['/AcroForm']['/Fields'].append(ref)
    return ref


def finish(writer, path):
    with open(path, 'wb') as f:
        writer.write(f)


# ---------------------------------------------------------------------------------------------

def calc_form():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle('Order Form (calculations)')
    form = c.acroForm
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 720, 'Order Form')
    c.setFont('Helvetica', 11)
    rows = [
        ('Amount 1:', 'amount1', 660),
        ('Amount 2:', 'amount2', 630),
        ('Total:', 'total', 600),
        ('Discount:', 'discount', 570),
        ('Net total:', 'net', 540),
        ('Quantity (0-100):', 'qty', 510),
        ('Order date:', 'orderDate', 480),
    ]
    for label, name, y in rows:
        c.drawString(72, y + 5, label)
        flags = 'readOnly' if name in ('total', 'net') else ''
        form.textfield(name=name, tooltip=label.rstrip(':'), x=200, y=y, width=160, height=20, fieldFlags=flags,
                       fontSize=11, borderStyle='solid')
    c.setFont('Helvetica', 9)
    c.drawString(72, 440, 'Total = Amount 1 + Amount 2. Net total = Total x (1 - Discount).')
    c.showPage()
    c.save()

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    fields = field_map(writer)
    money = 'AFNumber_Format(2, 0, 0, 0, "$", true);'
    money_k = 'AFNumber_Keystroke(2, 0, 0, 0, "$", true);'
    set_actions(fields, 'amount1', F=money, K=money_k)
    set_actions(fields, 'amount2', F=money, K=money_k)
    set_actions(fields, 'total', F=money, K=money_k,
                C='AFSimple_Calculate("SUM", new Array ("amount1", "amount2"));')
    set_actions(fields, 'discount', F='AFPercent_Format(0, 0);', K='AFPercent_Keystroke(0, 0);')
    set_actions(fields, 'net', F=money, K=money_k,
                C='var t = this.getField("total").value;\n'
                  'var d = this.getField("discount").value;\n'
                  'event.value = t * (1 - d);')
    set_actions(fields, 'qty', K='AFNumber_Keystroke(0, 1, 0, 0, "", true);',
                F='AFNumber_Format(0, 1, 0, 0, "", true);', V='AFRange_Validate(true, 0, true, 100);')
    set_actions(fields, 'orderDate', F='AFDate_FormatEx("mm/dd/yyyy");', K='AFDate_KeystrokeEx("mm/dd/yyyy");')
    writer._root_object['/AcroForm'][NameObject('/CO')] = ArrayObject([fields['total'][1], fields['net'][1]])
    finish(writer, os.path.join(OUT, 'calc.pdf'))


def all_fields_form():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle('All Field Types')
    form = c.acroForm
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 740, 'All field types')
    c.setFont('Helvetica', 10)

    def label(y, text, x=72):
        c.drawString(x, y + 5, text)

    label(700, 'First name *')
    form.textfield(name='firstName', tooltip='First name', x=170, y=700, width=150, height=18, fieldFlags='required')
    label(700, 'Last name', 340)
    form.textfield(name='lastName', tooltip='Last name', x=400, y=700, width=150, height=18)
    label(670, 'Password')
    form.textfield(name='password', x=170, y=670, width=150, height=18, fieldFlags='password')
    label(670, 'PIN', 340)
    form.textfield(name='pin', x=400, y=670, width=120, height=18, fieldFlags='comb', maxlen=6)
    label(640, 'Member ID')
    form.textfield(name='memberId', value='M-0042', x=170, y=640, width=150, height=18, fieldFlags='readOnly')
    label(640, 'Amount', 340)
    form.textfield(name='amountRight', x=400, y=640, width=150, height=18)
    label(610, 'Auto size')
    form.textfield(name='autoSize', x=170, y=605, width=150, height=26, fontSize=0)
    label(580, 'State')
    form.choice(name='state', value='Texas', options=['California', 'New York', 'Texas', 'Washington'],
                x=170, y=575, width=150, height=20, fieldFlags='combo edit')
    label(580, 'Colour', 340)
    form.choice(name='colour', value='G', options=[('Red', 'R'), ('Green', 'G'), ('Blue', 'B')],
                x=400, y=575, width=150, height=20)
    label(540, 'Languages')
    form.listbox(name='languages', value=['French', 'Japanese'],
                 options=['English', 'French', 'German', 'Spanish', 'Japanese'],
                 x=170, y=470, width=150, height=80, fieldFlags='multiSelect')
    label(540, 'Contact by', 340)
    form.listbox(name='contact', value='Phone', options=['Email', 'Phone', 'Post'], x=400, y=490, width=150,
                 height=60)
    label(440, 'I agree *')
    form.checkbox(name='agree', x=170, y=438, size=14, checked=False, fieldFlags='required')
    label(410, 'Comments')
    form.textfield(name='comments', x=170, y=350, width=380, height=70, fieldFlags='multiline')
    label(220, 'Signature')
    c.drawString(72, 110, 'Page 1 of 2')
    c.showPage()

    c.setFont('Helvetica-Bold', 14)
    c.drawString(72, 740, 'Page 2: special formats')
    c.setFont('Helvetica', 10)
    rows = [('City', 'city', 700), ('ZIP code', 'zip', 670), ('Phone', 'phone', 640), ('SSN', 'ssn', 610),
            ('Date of birth', 'dob', 580), ('Appointment', 'appt', 550), ('Age', 'age', 520)]
    for text, name, y in rows:
        label(y, text)
        form.textfield(name=name, tooltip=text, x=170, y=y, width=150, height=18)
    c.drawString(72, 110, 'Page 2 of 2')
    c.showPage()
    c.save()

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    fields = field_map(writer)
    # right-aligned text
    fields['amountRight'][0][NameObject('/Q')] = NumberObject(2)
    set_actions(fields, 'zip', F='AFSpecial_Format(0);', K='AFSpecial_Keystroke(0);')
    set_actions(fields, 'phone', F='AFSpecial_Format(2);', K='AFSpecial_Keystroke(2);')
    set_actions(fields, 'ssn', F='AFSpecial_Format(3);', K='AFSpecial_Keystroke(3);')
    set_actions(fields, 'dob', F='AFDate_FormatEx("mm/dd/yyyy");', K='AFDate_KeystrokeEx("mm/dd/yyyy");')
    set_actions(fields, 'appt', F='AFTime_Format(1);', K='AFTime_Keystroke(1);')
    set_actions(fields, 'age', K='AFNumber_Keystroke(0, 1, 0, 0, "", true);', V='AFRange_Validate(true, 0, true, 130);')
    set_actions(fields, 'city', K='if (!event.willCommit) event.change = event.change.toUpperCase();')

    reset = DictionaryObject({NameObject('/S'): NameObject('/ResetForm')})
    submit = DictionaryObject({
        NameObject('/S'): NameObject('/SubmitForm'),
        NameObject('/F'): DictionaryObject({NameObject('/FS'): NameObject('/URL'),
                                            NameObject('/F'): TextStringObject('https://example.com/submit')}),
    })
    add_widget(writer, 0, 'resetButton', (170, 270, 250, 292), '/Btn', 65536, {'/A': reset}, 'Reset')
    add_widget(writer, 0, 'submitButton', (260, 270, 340, 292), '/Btn', 65536, {'/A': submit}, 'Submit')
    add_widget(writer, 0, 'printButton', (350, 270, 430, 292), '/Btn', 65536, {'/A': js('this.print();')}, 'Print')
    add_widget(writer, 0, 'helloButton', (440, 270, 520, 292), '/Btn', 65536,
               {'/A': js('app.alert("Hello from the form");')}, 'Hello')
    add_widget(writer, 0, 'signature1', (170, 200, 370, 245), '/Sig', 0, {}, None)
    writer.pages[0][NameObject('/Tabs')] = NameObject('/R')
    finish(writer, os.path.join(OUT, 'all-fields.pdf'))


def xfa_form():
    writer = PdfWriter(clone_from=PdfReader(os.path.join(OUT, 'calc.pdf')))
    xdp = StreamObject()
    xdp.set_data(b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">'
                 b'<subform name="form1" layout="tb"/></template></xdp:xdp>')
    writer._root_object['/AcroForm'][NameObject('/XFA')] = writer._add_object(xdp)
    finish(writer, os.path.join(OUT, 'xfa.pdf'))


def signed_form():
    writer = PdfWriter(clone_from=PdfReader(os.path.join(OUT, 'all-fields.pdf')))
    sig = DictionaryObject({
        NameObject('/Type'): NameObject('/Sig'),
        NameObject('/Filter'): NameObject('/Adobe.PPKLite'),
        NameObject('/SubFilter'): NameObject('/adbe.pkcs7.detached'),
        NameObject('/Name'): TextStringObject('Jane Signer'),
        NameObject('/M'): TextStringObject("D:20240305140709+00'00'"),
    })
    annot, _ = field_map(writer)['signature1']
    annot[NameObject('/V')] = writer._add_object(sig)
    finish(writer, os.path.join(OUT, 'signed.pdf'))


if __name__ == '__main__':
    import sys
    targets = sys.argv[1:] or ['calc', 'all-fields', 'xfa', 'signed']
    if 'calc' in targets:
        calc_form()
    if 'all-fields' in targets:
        all_fields_form()
    if 'xfa' in targets:
        xfa_form()
    if 'signed' in targets:
        signed_form()
    print('fixtures written to', OUT)

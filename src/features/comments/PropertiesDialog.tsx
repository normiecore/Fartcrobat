import { useState } from 'react'
import type { AnnotInfo, AnnotSpec, LineEnding } from '@engine/ops/annots'
import {
  Button,
  Checkbox,
  ColorButton,
  Dialog,
  Field,
  openDialog,
  Select,
  showError,
  Slider,
  TextInput,
  type DocumentModel
} from '@renderer/sdk'
import { FONT_SIZES, fillOf, fillSpec, lineStyleOf, lineStyleSpec, saveAsDefault, WIDTHS, type LineStyle } from './appearance'
import { capabilities, commentDate, fullDate, typeLabel } from './model'
import { buildThreads, LINE_ENDINGS } from './shared'
import { annotsOf, useCommentList } from './state'

export function openProperties(doc: DocumentModel, a: AnnotInfo) {
  void openDialog((close) => <PropertiesDialog doc={doc} annot={a} close={close} />)
}

type Tab = 'appearance' | 'general' | 'history'

function PropertiesDialog({ doc, annot: a, close }: { doc: DocumentModel; annot: AnnotInfo; close: () => void }) {
  const caps = capabilities(a)
  const { list } = useCommentList(doc)
  const thread = buildThreads(list).find((t) => t.root.id === a.id)
  const [tab, setTab] = useState<Tab>('appearance')
  const [color, setColor] = useState<string | null>(a.color)
  const [fill, setFill] = useState<string | null>(fillOf(a))
  const [opacity, setOpacity] = useState(Math.round(a.opacity * 100))
  const [width, setWidth] = useState(a.borderWidth || 1)
  const [style, setStyle] = useState<LineStyle>(lineStyleOf(a))
  const [start, setStart] = useState<string>(a.lineEndings?.start ?? 'None')
  const [end, setEnd] = useState<string>(a.lineEndings?.end ?? 'None')
  const [fontSize, setFontSize] = useState(a.fontSize ?? 12)
  const [textColor, setTextColor] = useState(a.textColor ?? '#000000')
  const [quadding, setQuadding] = useState(a.quadding)
  const [icon, setIcon] = useState(a.icon)
  const [locked, setLocked] = useState(a.locked)
  const [author, setAuthor] = useState(a.author)
  const [subject, setSubject] = useState(a.subject || typeLabel(a))
  const [makeDefault, setMakeDefault] = useState(false)

  const apply = async () => {
    const spec: AnnotSpec = {}
    if (caps.color && color !== a.color) spec.color = color
    if (caps.fill && fill !== fillOf(a)) Object.assign(spec, fillSpec(a, fill))
    if (caps.opacity && opacity !== Math.round(a.opacity * 100)) spec.opacity = opacity / 100
    if (caps.width && width !== a.borderWidth) spec.borderWidth = width
    if ((caps.dash || caps.cloud) && (style !== lineStyleOf(a) || (style === 'dashed' && spec.borderWidth !== undefined))) {
      Object.assign(spec, lineStyleSpec(style, width))
    }
    if (caps.arrows && (start !== (a.lineEndings?.start ?? 'None') || end !== (a.lineEndings?.end ?? 'None'))) {
      spec.lineEndings = { start: start as LineEnding, end: end as LineEnding }
    }
    if (caps.font) {
      if (fontSize !== a.fontSize) spec.fontSize = fontSize
      if (textColor !== a.textColor) spec.textColor = textColor
      if (quadding !== a.quadding) spec.quadding = quadding
    }
    if (caps.icon && icon !== a.icon) spec.icon = icon
    if (locked !== a.locked) spec.locked = locked
    if (author !== a.author) spec.author = author
    if (subject !== a.subject && !(subject === typeLabel(a) && !a.subject)) spec.subject = subject
    try {
      let updated = a
      if (Object.keys(spec).length) updated = await annotsOf(doc).update(a.id, spec, a.page)
      if (makeDefault) await saveAsDefault(updated)
      close()
    } catch (err) {
      showError(err, 'Could not change the comment')
    }
  }

  const states = thread ? [...thread.states].reverse() : []
  return (
    <Dialog
      title={`${typeLabel(a)} Properties`}
      onClose={close}
      width={520}
      className="fc-comments-props"
      onSubmit={() => void apply()}
      footer={
        <div className="fc-comments-props-footer">
          <Checkbox checked={makeDefault} onChange={setMakeDefault} label="Make Properties Default" />
          <span className="fc-comments-spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void apply()}>
            OK
          </Button>
        </div>
      }
    >
      <div className="fc-comments-tabs" role="tablist">
        {(
          [
            ['appearance', 'Appearance'],
            ['general', 'General'],
            ['history', 'Review History']
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'appearance' && (
        <div className="fc-comments-props-grid">
          {caps.color && (
            <Field label="Colour">
              <ColorButton value={color} onChange={setColor} title="Colour" />
            </Field>
          )}
          {caps.fill && (
            <Field label={caps.fill === 'background' ? 'Fill colour' : 'Fill colour'}>
              <ColorButton value={fill} onChange={setFill} allowNone title="Fill colour" />
            </Field>
          )}
          {caps.font && (
            <>
              <Field label="Text colour">
                <ColorButton value={textColor} onChange={(v) => setTextColor(v ?? '#000000')} title="Text colour" />
              </Field>
              <Field label="Font size">
                <Select
                  value={String(fontSize)}
                  onChange={(v) => setFontSize(parseFloat(v))}
                  options={[...new Set([...FONT_SIZES, fontSize])].sort((x, y) => x - y).map((s) => ({ value: String(s), label: `${s} pt` }))}
                />
              </Field>
              <Field label="Alignment">
                <Select
                  value={String(quadding)}
                  onChange={(v) => setQuadding(parseInt(v, 10))}
                  options={[
                    { value: '0', label: 'Left' },
                    { value: '1', label: 'Centre' },
                    { value: '2', label: 'Right' }
                  ]}
                />
              </Field>
            </>
          )}
          {caps.width && (
            <Field label={a.type === 'FreeText' ? 'Border thickness' : 'Thickness'}>
              <Select
                value={String(width)}
                onChange={(v) => setWidth(parseFloat(v))}
                options={[...new Set([...(a.type === 'FreeText' ? [0] : []), ...WIDTHS, width])]
                  .sort((x, y) => x - y)
                  .map((w) => ({ value: String(w), label: w === 0 ? 'None' : `${w} pt` }))}
              />
            </Field>
          )}
          {(caps.dash || caps.cloud) && (
            <Field label="Line style">
              <Select<LineStyle>
                value={style}
                onChange={setStyle}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'dashed', label: 'Dashed' },
                  ...(caps.cloud ? [{ value: 'cloudy' as LineStyle, label: 'Cloudy' }] : [])
                ]}
              />
            </Field>
          )}
          {caps.arrows && (
            <>
              <Field label="Start">
                <Select value={start} onChange={setStart} options={LINE_ENDINGS} />
              </Field>
              <Field label="End">
                <Select value={end} onChange={setEnd} options={LINE_ENDINGS} />
              </Field>
            </>
          )}
          {caps.icon && (
            <Field label="Icon">
              <Select value={icon || caps.icon[0].value} onChange={setIcon} options={caps.icon} />
            </Field>
          )}
          {caps.opacity && (
            <Field label="Opacity">
              <Slider value={opacity} min={0} max={100} step={5} onChange={setOpacity} format={(v) => `${v}%`} />
            </Field>
          )}
          <div className="fc-comments-props-wide">
            <Checkbox checked={locked} onChange={setLocked} label="Locked (cannot be moved, resized or deleted)" />
          </div>
        </div>
      )}
      {tab === 'general' && (
        <div className="fc-comments-props-grid is-single">
          <Field label="Author">
            <TextInput value={author} onChange={(e) => setAuthor(e.target.value)} />
          </Field>
          <Field label="Subject">
            <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <dl className="fc-comments-props-facts">
            <dt>Type</dt>
            <dd>{typeLabel(a)}</dd>
            <dt>Page</dt>
            <dd>{doc.info.pages[a.page]?.label ?? a.page + 1}</dd>
            <dt>Created</dt>
            <dd>{fullDate(a.created) || '—'}</dd>
            <dt>Modified</dt>
            <dd>{fullDate(commentDate(a)) || '—'}</dd>
          </dl>
        </div>
      )}
      {tab === 'history' && (
        <div className="fc-comments-history">
          {states.length ? (
            <ul>
              {states.map((s) => (
                <li key={s.id}>
                  <b>{s.author || 'Someone'}</b> {s.state === 'Marked' ? 'marked it with a checkmark' : s.state === 'Unmarked' ? 'removed the checkmark' : `set the status to ${s.state}`}
                  <span>{fullDate(commentDate(s))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fc-comments-muted">No status changes yet. Use Set Status on the comment to record a review decision.</p>
          )}
        </div>
      )}
    </Dialog>
  )
}

/**
 * Floating properties bar shown next to a single selected comment: colour, fill, opacity, line
 * width and style, arrow ends, text size and colour, note icon, lock, and "More…" for the full
 * Properties dialog. Every change is one undoable step.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Lock, LockOpen, MessageSquare, Settings2, TextAlignCenter, TextAlignEnd, TextAlignStart } from 'lucide-react'
import type { AnnotInfo, AnnotSpec, LineEnding } from '@engine/ops/annots'
import { ColorButton, IconButton, type DocumentModel } from '@renderer/sdk'
import { updateComment } from './actions'
import { FONT_SIZES, fillOf, fillSpec, lineStyleOf, lineStyleSpec, WIDTHS, type LineStyle } from './appearance'
import { capabilities } from './model'
import { openProperties } from './PropertiesDialog'
import { LINE_ENDINGS } from './shared'
import { openPopup } from './state'

function MiniSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  width
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  width?: number
}) {
  return (
    <select
      className="fc-comments-mini-select"
      aria-label={label}
      title={label}
      value={value}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function OpacityControl({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(Math.round(value * 100))
  useEffect(() => setV(Math.round(value * 100)), [value])
  const commit = () => {
    if (v !== Math.round(value * 100)) onCommit(v / 100)
  }
  return (
    <label className="fc-comments-opacity" title="Opacity">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={v}
        aria-label="Opacity"
        onChange={(e) => setV(parseInt(e.target.value, 10))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span>{v}%</span>
    </label>
  )
}

const ENDING_SHORT: Record<string, string> = {
  None: '—',
  OpenArrow: '→ open',
  ClosedArrow: '▶ closed',
  ROpenArrow: '← open',
  RClosedArrow: '◀ closed',
  Circle: '● circle',
  Square: '■ square',
  Diamond: '◆ diamond',
  Butt: '┤ butt',
  Slash: '/ slash'
}

export function Inspector({
  doc,
  annot: a,
  anchor,
  bounds
}: {
  doc: DocumentModel
  annot: AnnotInfo
  /** The comment's box in overlay coordinates. */
  anchor: { left: number; top: number; bottom: number }
  /** The visible part of the document in overlay coordinates: the bar stays inside it. */
  bounds: { left: number; top: number; right: number; bottom: number }
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Above the comment, else below it, else pinned to the top of the visible area while the
  // comment is in view. The bar wraps onto a second row when the document area is narrow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(bounds.left, Math.min(anchor.left, bounds.right - w))
    const above = anchor.top - h - 10
    const below = anchor.bottom + 10
    const inView = anchor.top < bounds.bottom && anchor.bottom > bounds.top
    const top = !inView || above >= bounds.top ? above : below + h <= bounds.bottom ? below : bounds.top
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  })
  const caps = capabilities(a)
  const set = (spec: AnnotSpec) => void updateComment(doc, a, spec)
  const style = lineStyleOf(a)
  const endings = LINE_ENDINGS.map((e) => ({ value: e.value, label: ENDING_SHORT[e.value] ?? e.label }))
  return (
    <div
      ref={ref}
      className="fc-comments-inspector"
      role="toolbar"
      aria-label="Comment properties"
      style={{ maxWidth: Math.max(160, bounds.right - bounds.left) }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {caps.color && <ColorButton value={a.color} onChange={(v) => set({ color: v ?? '#000000' })} title="Colour" />}
      {caps.font && (
        <>
          <ColorButton value={a.textColor ?? '#000000'} onChange={(v) => set({ textColor: v ?? '#000000' })} title="Text colour" />
          <MiniSelect
            label="Font size"
            value={String(a.fontSize ?? 12)}
            options={[...new Set([...FONT_SIZES, a.fontSize ?? 12])].sort((x, y) => x - y).map((s) => ({ value: String(s), label: `${s} pt` }))}
            onChange={(v) => set({ fontSize: parseFloat(v) })}
          />
          <span className="fc-comments-inspector-group" role="group" aria-label="Alignment">
            {[TextAlignStart, TextAlignCenter, TextAlignEnd].map((Icon, q) => (
              <IconButton
                key={q}
                icon={Icon}
                size={15}
                label={['Align left', 'Centre', 'Align right'][q]}
                active={a.quadding === q}
                onClick={() => set({ quadding: q })}
              />
            ))}
          </span>
        </>
      )}
      {caps.fill && (
        <ColorButton value={fillOf(a)} allowNone onChange={(v) => set(fillSpec(a, v))} title={caps.fill === 'background' ? 'Fill colour' : 'Fill colour'} />
      )}
      {caps.width && (
        <MiniSelect
          label={a.type === 'FreeText' ? 'Border thickness' : 'Line thickness'}
          value={String(a.borderWidth)}
          options={[...new Set([...(a.type === 'FreeText' ? [0] : []), ...WIDTHS, a.borderWidth])]
            .sort((x, y) => x - y)
            .map((w) => ({ value: String(w), label: w === 0 ? 'No border' : `${w} pt` }))}
          onChange={(v) => {
            const w = parseFloat(v)
            set(style === 'dashed' ? { borderWidth: w, ...lineStyleSpec('dashed', w) } : { borderWidth: w })
          }}
        />
      )}
      {(caps.dash || caps.cloud) && (
        <MiniSelect<LineStyle>
          label="Line style"
          value={style}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'dashed', label: 'Dashed' },
            ...(caps.cloud ? [{ value: 'cloudy' as LineStyle, label: 'Cloudy' }] : [])
          ]}
          onChange={(v) => set(lineStyleSpec(v, a.borderWidth))}
        />
      )}
      {caps.arrows && (
        <>
          <MiniSelect
            label="Line start"
            value={a.lineEndings?.start ?? 'None'}
            options={endings}
            onChange={(v) => set({ lineEndings: { start: v as LineEnding, end: (a.lineEndings?.end ?? 'None') as LineEnding } })}
          />
          <MiniSelect
            label="Line end"
            value={a.lineEndings?.end ?? 'None'}
            options={endings}
            onChange={(v) => set({ lineEndings: { start: (a.lineEndings?.start ?? 'None') as LineEnding, end: v as LineEnding } })}
          />
        </>
      )}
      {caps.icon && (
        <MiniSelect label="Icon" value={a.icon || caps.icon[0].value} options={caps.icon} onChange={(v) => set({ icon: v })} />
      )}
      {caps.opacity && <OpacityControl value={a.opacity} onCommit={(v) => set({ opacity: v })} />}
      <span className="fc-comments-inspector-sep" />
      <IconButton icon={MessageSquare} size={16} label="Open pop-up note" onClick={() => openPopup(doc, a)} />
      <IconButton
        icon={a.locked ? Lock : LockOpen}
        size={16}
        label={a.locked ? 'Locked — click to unlock' : 'Lock (prevent moving and deleting)'}
        active={a.locked}
        onClick={() => set({ locked: !a.locked })}
      />
      <IconButton icon={Settings2} size={16} label="More properties…" onClick={() => openProperties(doc, a)} />
    </div>
  )
}

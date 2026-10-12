/**
 * Tool options bar shown under the document toolbar while a comment tool is active: colour, fill,
 * opacity, line width and style, arrow ends, font, note icon, eraser size, and "Keep tool selected".
 * Every change is remembered as the tool's default.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Cloud, Pin, RotateCcw, X } from 'lucide-react'
import type { LineEnding } from '@engine/ops/annots'
import {
  Button,
  ColorPicker,
  IconButton,
  Select,
  Segmented,
  setPrefs,
  usePrefs,
  type DocumentModel
} from '@renderer/sdk'
import { cancelPolyDraft, finishPolyDraft, usePolyDraft } from './layers/PolyLayer'
import { useActiveToolAndStyle } from './layers/shared'
import { resetToolStyle, setToolStyle, type FontKey, type LineStyle, type ToolStyle } from './style'

const WIDTHS = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12]
const FONT_SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]
const ERASER_SIZES = [4, 6, 10, 16, 24, 40]
const OPACITIES = [100, 90, 80, 75, 70, 60, 50, 40, 30, 25, 20, 10]

export const LINE_ENDINGS: { value: LineEnding; label: string }[] = [
  { value: 'None', label: 'None' },
  { value: 'OpenArrow', label: 'Open arrow' },
  { value: 'ClosedArrow', label: 'Closed arrow' },
  { value: 'ROpenArrow', label: 'Reverse open' },
  { value: 'RClosedArrow', label: 'Reverse closed' },
  { value: 'Circle', label: 'Circle' },
  { value: 'Square', label: 'Square' },
  { value: 'Diamond', label: 'Diamond' },
  { value: 'Butt', label: 'Butt' },
  { value: 'Slash', label: 'Slash' }
]

export const NOTE_ICONS: { value: string; label: string }[] = [
  { value: 'Comment', label: 'Comment' },
  { value: 'Note', label: 'Note' },
  { value: 'Help', label: 'Help' },
  { value: 'Insert', label: 'Insert' },
  { value: 'Key', label: 'Key' },
  { value: 'NewParagraph', label: 'New paragraph' },
  { value: 'Paragraph', label: 'Paragraph' }
]

export const ATTACH_ICONS: { value: string; label: string }[] = [
  { value: 'PushPin', label: 'Push pin' },
  { value: 'Paperclip', label: 'Paperclip' },
  { value: 'Graph', label: 'Graph' },
  { value: 'Tag', label: 'Tag' }
]

const FONTS: { value: FontKey; label: string }[] = [
  { value: 'Helv', label: 'Helvetica' },
  { value: 'TiRo', label: 'Times' },
  { value: 'Cour', label: 'Courier' }
]

/** Colour swatch button with a popover picker (rendered in a portal so the bar cannot clip it). */
export function ColorControl({
  label,
  value,
  onChange,
  allowNone
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  allowNone?: boolean
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    if (!at || !pop.current) return
    const r = pop.current.getBoundingClientRect()
    if (r.right > window.innerWidth - 8) setAt({ x: Math.max(8, window.innerWidth - r.width - 8), y: at.y })
  }, [at])

  useEffect(() => {
    if (!at) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        setAt(null)
        btn.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [at])

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="fc-markup-tools-color"
        title={label}
        aria-label={`${label}: ${value ?? 'none'}`}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        onClick={() => {
          if (at) return setAt(null)
          const r = btn.current!.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 6 })
        }}
      >
        <span className="fc-markup-tools-color-swatch" style={{ background: value ?? 'transparent' }}>
          {value === null && <span className="ui-swatch-none-line" />}
        </span>
        <span className="fc-markup-tools-color-label fc-markup-tools-label">{label}</span>
      </button>
      {at &&
        createPortal(
          <>
            <div className="ui-popover-scrim" onMouseDown={() => setAt(null)} />
            <div ref={pop} className="fc-markup-tools-popover" role="dialog" aria-label={label} style={{ left: at.x, top: at.y }}>
              <div className="fc-markup-tools-popover-title">{label}</div>
              <ColorPicker
                value={value}
                allowNone={allowNone}
                onChange={(v) => {
                  onChange(v)
                  setAt(null)
                  btn.current?.focus()
                }}
              />
            </div>
          </>,
          document.body
        )}
    </>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="fc-markup-tools-field" title={label}>
      <span className="fc-markup-tools-label">{label}</span>
      {children}
    </label>
  )
}

const LINE_STYLE_LABEL: Record<LineStyle, string> = { solid: 'Solid line', dashed: 'Dashed line', cloudy: 'Cloudy border' }

function LineStyleIcon({ style }: { style: LineStyle }) {
  if (style === 'cloudy') return <Cloud size={16} aria-hidden="true" />
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
      <line x1="1" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="2" strokeDasharray={style === 'dashed' ? '4 3' : undefined} />
    </svg>
  )
}

/**
 * Switches the bar to a compact layout (no text labels) when the full layout does not fit, and
 * back when there is room again.
 */
function useCompact(ref: React.RefObject<HTMLDivElement | null>, key: string) {
  const [state, setState] = useState({ key, compact: false, needed: 0 })
  // another tool: start from the full layout again
  if (state.key !== key) setState({ key, compact: false, needed: 0 })
  const check = () => {
    const el = ref.current
    if (!el) return
    const overflow = el.scrollWidth > el.clientWidth + 1
    const full = el.scrollWidth
    const room = el.clientWidth
    setState((s) => {
      if (!s.compact) return overflow ? { ...s, compact: true, needed: full } : s
      return room >= s.needed + 4 ? { ...s, compact: false } : s
    })
  }
  // content changes (e.g. Finish/Cancel appearing) and container resizes both re-measure
  useLayoutEffect(check)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => check())
    ro.observe(el)
    return () => ro.disconnect()
    // check only uses refs and the state setter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref])
  return state.key === key && state.compact
}

export function MarkupToolbar({ doc }: { doc: DocumentModel }) {
  const { tool, style } = useActiveToolAndStyle()
  const keep = usePrefs().keepToolSelected
  const draft = usePolyDraft((s) => (s.draft && s.draft.docId === doc.id ? s.draft : null))
  const ref = useRef<HTMLDivElement>(null)
  const compact = useCompact(ref, tool?.id ?? '')
  if (!tool) return null
  const has = (p: string) => tool.props.includes(p as never)
  const set = (patch: Partial<ToolStyle>) => setToolStyle(tool.key, patch)
  const lineStyles: LineStyle[] = has('cloudy') ? ['solid', 'dashed', 'cloudy'] : ['solid', 'dashed']
  const isText = tool.kind === 'textbox' || tool.kind === 'callout'

  return (
    <div
      ref={ref}
      className={`fc-markup-tools-toolbar ${compact ? 'is-compact' : ''}`}
      role="group"
      aria-label={`${tool.label} options`}
    >
      <span className="fc-markup-tools-toolname" title={tool.label}>
        <tool.icon size={16} />
        <span className="fc-markup-tools-label">{tool.label}</span>
      </span>
      {has('color') && <ColorControl label="Colour" value={style.color} onChange={(v) => v && set({ color: v })} />}
      {has('fontColor') && <ColorControl label={isText ? 'Text & border' : 'Text colour'} value={style.fontColor} onChange={(v) => v && set({ fontColor: v })} />}
      {has('fill') && <ColorControl label="Fill" value={style.fill} allowNone onChange={(v) => set({ fill: v })} />}
      {has('width') && (
        <Labeled label={isText ? 'Border' : 'Width'}>
          <Select
            aria-label={isText ? 'Border width' : 'Line width'}
            value={String(style.width)}
            onChange={(v) => set({ width: parseFloat(v) })}
            options={(isText ? [0, ...WIDTHS] : WIDTHS).map((w) => ({ value: String(w), label: w === 0 ? 'None' : `${w} pt` }))}
          />
        </Labeled>
      )}
      {has('lineStyle') && (
        <span className="fc-markup-tools-linestyle" aria-label="Line style">
          <Segmented
            value={lineStyles.includes(style.lineStyle) ? style.lineStyle : 'solid'}
            onChange={(v) => set({ lineStyle: v })}
            options={lineStyles.map((v) => ({ value: v, label: <LineStyleIcon style={v} />, title: LINE_STYLE_LABEL[v] }))}
          />
        </span>
      )}
      {has('ends') &&
        (tool.kind === 'callout' ? (
          <Labeled label="Arrow">
            <Select aria-label="Callout arrow" value={style.endEnd} onChange={(v) => set({ endEnd: v })} options={LINE_ENDINGS} />
          </Labeled>
        ) : (
          <>
            <Labeled label="Start">
              <Select aria-label="Line start" value={style.startEnd} onChange={(v) => set({ startEnd: v })} options={LINE_ENDINGS} />
            </Labeled>
            <Labeled label="End">
              <Select aria-label="Line end" value={style.endEnd} onChange={(v) => set({ endEnd: v })} options={LINE_ENDINGS} />
            </Labeled>
          </>
        ))}
      {has('font') && (
        <span className="fc-markup-tools-field" title="Font">
          <Select aria-label="Font" value={style.font} onChange={(v) => set({ font: v })} options={FONTS} />
        </span>
      )}
      {has('fontSize') && (
        <Labeled label="Size">
          <Select
            aria-label="Font size"
            value={String(style.fontSize)}
            onChange={(v) => set({ fontSize: parseFloat(v) })}
            options={(FONT_SIZES.includes(style.fontSize) ? FONT_SIZES : [...FONT_SIZES, style.fontSize].sort((a, b) => a - b)).map((s) => ({ value: String(s), label: `${s} pt` }))}
          />
        </Labeled>
      )}
      {has('icon') && (
        <Labeled label="Icon">
          <Select aria-label="Note icon" value={style.icon} onChange={(v) => set({ icon: v })} options={NOTE_ICONS} />
        </Labeled>
      )}
      {has('attachIcon') && (
        <Labeled label="Icon">
          <Select
            aria-label="Attachment icon"
            value={ATTACH_ICONS.some((i) => i.value === style.icon) ? style.icon : 'PushPin'}
            onChange={(v) => set({ icon: v })}
            options={ATTACH_ICONS}
          />
        </Labeled>
      )}
      {has('eraserSize') && (
        <Labeled label="Eraser size">
          <Select aria-label="Eraser size" value={String(style.eraserSize)} onChange={(v) => set({ eraserSize: parseFloat(v) })} options={ERASER_SIZES.map((s) => ({ value: String(s), label: `${s} pt` }))} />
        </Labeled>
      )}
      {has('opacity') && (
        <Labeled label="Opacity">
          <Select
            aria-label="Opacity"
            value={String(Math.round(style.opacity * 100))}
            onChange={(v) => set({ opacity: parseInt(v, 10) / 100 })}
            options={(OPACITIES.includes(Math.round(style.opacity * 100)) ? OPACITIES : [...OPACITIES, Math.round(style.opacity * 100)].sort((a, b) => b - a)).map((o) => ({ value: String(o), label: `${o}%` }))}
          />
        </Labeled>
      )}
      <span className="fc-markup-tools-hint" title={tool.hint}>
        {tool.hint}
      </span>
      {draft && draft.toolId === tool.id && (
        <span className="fc-markup-tools-draft">
          <Button size="sm" variant="primary" icon={Check} aria-label="Finish" title="Finish (Enter or double-click)" onClick={() => void finishPolyDraft(doc)}>
            <span className="fc-markup-tools-label">Finish</span>
          </Button>
          <Button size="sm" variant="quiet" icon={X} aria-label="Cancel" title="Cancel (Esc)" onClick={() => cancelPolyDraft()}>
            <span className="fc-markup-tools-label">Cancel</span>
          </Button>
        </span>
      )}
      <IconButton icon={RotateCcw} size={16} label="Reset this tool's settings" onClick={() => resetToolStyle(tool.key)} />
      <IconButton
        icon={Pin}
        size={16}
        className="fc-markup-tools-pin"
        label="Keep tool selected"
        active={keep}
        onClick={() => void setPrefs({ keepToolSelected: !keep })}
      />
    </div>
  )
}

import { AArrowDown, AArrowUp, ChevronDown, Crosshair, PenLine, X } from 'lucide-react'
import { Button, IconButton, openToolGroup, setTool, useApp, useDocState, type DocumentModel } from '@renderer/sdk'
import { FILL_SIGN_COLORS, isDraftId, isSignatureKind, stepSize, type FillSignItem, type MarkKind, type TextKind } from './shared'
import { fsOps, selectedItem, setDefaultColor, setDefaultTextSize, useFillSign } from './state'
import { activateFillTool, cancelPlacing, changeColor, changeSize, KIND_TOOL, placeSignature, TOOL_KIND } from './actions'
import { KIND_ICON } from './icons'
import { openSignMenu } from './SignMenu'

export const TOOL_ORDER: (TextKind | MarkKind)[] = ['text', 'cross', 'check', 'dot', 'line', 'box', 'date']

/** Acrobat's names for the Fill & Sign tools. */
export const TOOL_LABEL: Record<TextKind | MarkKind, string> = {
  text: 'Add text',
  cross: 'Cross mark',
  check: 'Check mark',
  dot: 'Dot',
  line: 'Line',
  box: 'Rounded box',
  date: 'Date'
}

export function toolLabel(kind: TextKind | MarkKind): string {
  return TOOL_LABEL[kind]
}

/** Applies a size or colour to the selected item, or else to the defaults for new items. */
async function withSelected(doc: DocumentModel, fn: (item: FillSignItem) => Promise<unknown>, otherwise: () => void) {
  const sel = selectedItem(doc)
  if (!sel) {
    otherwise()
    return
  }
  let item: FillSignItem | null = null
  if (isDraftId(sel.id)) {
    const e = useFillSign.getState().editing
    item = e && e.docId === doc.id && e.id === sel.id ? e.item : null
  } else {
    item = await fsOps(doc)
      .get(sel.id, sel.page)
      .catch(() => null)
  }
  if (item) await fn(item)
  else otherwise()
}

/**
 * The Fill & Sign bar under the document toolbar (like Acrobat's Fill & Sign toolbar): the mark
 * tools, Sign yourself, text size and colour.
 */
export function FillSignToolbar({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const size = useFillSign((s) => s.textSize)
  const color = useFillSign((s) => s.color)
  const selection = useDocState(doc, (s) => s.selection)
  const hasSel = !!selectedItem(doc) && selection.kind === 'custom'
  return (
    <div
      className="fc-fill-sign-toolbar"
      role="group"
      aria-label="Fill & Sign"
      onMouseDown={(e) => {
        // Clicking a button here must not end typing in the text being edited.
        if ((e.target as HTMLElement).closest('button')) e.preventDefault()
      }}
    >
      {TOOL_ORDER.map((k) => {
        const Icon = KIND_ICON[k]
        const id = KIND_TOOL[k]
        return (
          <IconButton key={k} icon={Icon} label={toolLabel(k)} active={toolId === id} onClick={() => activateFillTool(id)} />
        )
      })}
      <span className="shell-sep" />
      <Button
        size="sm"
        variant="accent"
        icon={PenLine}
        className="fc-fill-sign-signbtn"
        aria-haspopup="menu"
        aria-label="Sign yourself"
        title="Add your signature or initials"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          openSignMenu({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <span className="fc-fill-sign-signbtn-label">Sign yourself</span>
        <ChevronDown size={14} />
      </Button>
      <span className="shell-sep" />
      <IconButton
        icon={AArrowDown}
        label={hasSel ? 'Smaller' : 'Smaller text for new items'}
        onClick={() =>
          void withSelected(
            doc,
            (item) => changeSize(doc, item, -1),
            () => void setDefaultTextSize(stepSize(size, -1))
          )
        }
      />
      <span className="fc-fill-sign-size" title="Text size for new items" aria-live="polite">
        {size} pt
      </span>
      <IconButton
        icon={AArrowUp}
        label={hasSel ? 'Larger' : 'Larger text for new items'}
        onClick={() =>
          void withSelected(
            doc,
            (item) => changeSize(doc, item, 1),
            () => void setDefaultTextSize(stepSize(size, 1))
          )
        }
      />
      <span className="shell-sep" />
      <div className="fc-fill-sign-colors" role="radiogroup" aria-label="Colour">
        {FILL_SIGN_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={color === c.value}
            aria-label={c.label}
            title={c.label}
            className={`fc-fill-sign-ink ${color === c.value ? 'is-active' : ''}`}
            style={{ background: c.value }}
            onClick={() => {
              void setDefaultColor(c.value)
              void withSelected(
                doc,
                (item) => (isSignatureKind(item.kind) ? Promise.resolve() : changeColor(doc, item, c.value)),
                () => {}
              )
            }}
          />
        ))}
      </div>
      {TOOL_KIND[toolId] && (
        <span className="fc-fill-sign-hint shell-muted">
          {TOOL_KIND[toolId] === 'text' ? 'Click anywhere to type.' : `Click to add a ${toolLabel(TOOL_KIND[toolId]).toLowerCase()}.`}
        </span>
      )}
      <span className="fc-fill-sign-spacer" />
      <Button
        size="sm"
        variant="quiet"
        className="fc-fill-sign-close"
        title="Close Fill & Sign"
        onClick={() => (useApp.getState().toolGroupId === 'fillsign' ? openToolGroup(null) : setTool('select'))}
      >
        Close
      </Button>
    </div>
  )
}

/** Bar shown while a signature follows the pointer. */
export function PlaceToolbar({ doc }: { doc: DocumentModel }) {
  const placing = useFillSign((s) => s.placing)
  if (!placing) return null
  const noun = placing.kind === 'signature' ? 'signature' : 'initials'
  return (
    <div className="fc-fill-sign-toolbar" role="group" aria-label={`Place ${noun}`}>
      <img className="fc-fill-sign-place-thumb" src={placing.image.dataUrl} alt={`Your ${noun}`} />
      <span className="fc-fill-sign-place-text" title={`Click where you want your ${noun}. Press Esc to cancel.`}>
        Click where you want your {noun}. Press Esc to cancel.
      </span>
      <span className="fc-fill-sign-spacer" />
      <Button
        size="sm"
        icon={Crosshair}
        aria-label="Place in the middle of the page"
        title="Place in the middle of the page"
        onClick={() => {
          const page = doc.state.currentPage
          const pg = doc.state.info.pages[page]
          if (pg) void placeSignature(doc, page, [pg.width / 2, pg.height / 2])
        }}
      >
        Place in the middle<span className="fc-fill-sign-place-long"> of the page</span>
      </Button>
      <Button size="sm" variant="quiet" icon={X} onClick={() => cancelPlacing()}>
        Cancel
      </Button>
    </div>
  )
}

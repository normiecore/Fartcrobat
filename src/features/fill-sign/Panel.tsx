import { ChevronDown, Lightbulb, PenLine, Send } from 'lucide-react'
import { displayShortcut, openToolGroup, registry, Section, setTool, ToolPanelFrame, ToolRow, useApp, type DocumentModel } from '@renderer/sdk'
import { KIND_TOOL, startPlacing } from './actions'
import { KIND_ICON } from './icons'
import { openSignMenu } from './SignMenu'
import { TOOL_LABEL, TOOL_ORDER } from './Toolbar'
import { useFillSign } from './state'

const DESCRIPTIONS: Record<string, string> = {
  text: 'Click anywhere and type',
  cross: 'Cross out a box or answer',
  check: 'Tick a box',
  dot: 'Fill in a bubble',
  line: 'Strike through or underline',
  box: 'Circle an answer',
  date: "Insert today's date"
}

/** Left pane of the Fill & Sign tool group. */
export function FillSignPanel({ doc }: { doc: DocumentModel | null }) {
  const toolId = useApp((s) => s.toolId)
  const signature = useFillSign((s) => s.signature)
  const initials = useFillSign((s) => s.initials)
  const requestSign = registry.toolGroups.find((g) => g.id === 'requestsign')
  return (
    <ToolPanelFrame title="Fill & Sign">
      <div className="fc-fill-sign-panel">
        <button
          type="button"
          className="fc-fill-sign-bigbtn"
          disabled={!doc}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            openSignMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          <span className="fc-fill-sign-bigbtn-icon">
            <PenLine size={20} />
          </span>
          <span className="fc-fill-sign-bigbtn-text">
            <span className="fc-fill-sign-bigbtn-label">Sign yourself</span>
            <span className="fc-fill-sign-bigbtn-desc">
              {signature || initials ? 'Use your saved signature or initials' : 'Add your signature or initials'}
            </span>
          </span>
          <ChevronDown size={16} />
        </button>
        {(signature || initials) && (
          <div className="fc-fill-sign-panel-saved" role="group" aria-label="Saved signature and initials">
            {signature && (
              <button
                type="button"
                disabled={!doc}
                title="Place your saved signature"
                aria-label="Place your saved signature"
                onClick={() => startPlacing('signature', signature)}
              >
                <img src={signature.dataUrl} alt="" draggable={false} />
              </button>
            )}
            {initials && (
              <button
                type="button"
                disabled={!doc}
                title="Place your saved initials"
                aria-label="Place your saved initials"
                onClick={() => startPlacing('initials', initials)}
              >
                <img src={initials.dataUrl} alt="" draggable={false} />
              </button>
            )}
          </div>
        )}
        <Section title="Fill in">
          {TOOL_ORDER.map((k) => (
            <ToolRow
              key={k}
              icon={KIND_ICON[k]}
              label={TOOL_LABEL[k]}
              description={DESCRIPTIONS[k]}
              active={toolId === KIND_TOOL[k]}
              disabled={!doc}
              onClick={() => setTool(KIND_TOOL[k])}
            />
          ))}
        </Section>
        {requestSign && (
          <Section title="Others">
            <ToolRow
              icon={requestSign.icon ?? Send}
              label="Request e-signatures"
              description="Send this document to others to sign"
              onClick={() => openToolGroup('requestsign')}
            />
          </Section>
        )}
        <div className="fc-fill-sign-tip" role="note">
          <Lightbulb size={16} />
          <div>
            <b>Tip:</b> click anywhere on the page to type. Drag an item to move it, drag its corner to resize it, and
            press Delete to remove it. Everything can be undone with {displayShortcut('Mod+Z')}.
          </div>
        </div>
      </div>
    </ToolPanelFrame>
  )
}

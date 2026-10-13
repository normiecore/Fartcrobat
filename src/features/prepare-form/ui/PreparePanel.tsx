import { useEffect } from 'react'
import {
  Calculator,
  Eye,
  ListOrdered,
  MousePointer2,
  PanelRight,
  PencilLine,
  Trash,
  TriangleAlert,
  WandSparkles
} from 'lucide-react'
import {
  confirm,
  openRightPanel,
  Section,
  Segmented,
  setTool,
  showError,
  ToolPanelFrame,
  ToolRow,
  toast,
  useApp,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { TYPE_LABELS, type PFType } from '../model'
import { clearFieldSelection, isFormTool, pf, refreshInfo, TYPE_TOOLS } from './actions'
import { openCalculationOrder } from './CalcOrderDialog'
import { detectFieldsFlow, offerDetection } from './detectFlow'
import { useAllFields } from './hooks'
import { TYPE_ICONS } from './icons'
import { usePF } from './state'

const ADD: { type: PFType; desc: string }[] = [
  { type: 'text', desc: 'Any typed answer' },
  { type: 'checkbox', desc: 'Yes or no; tick several' },
  { type: 'radio', desc: 'Pick one option of a group' },
  { type: 'list', desc: 'A scrolling list of options' },
  { type: 'combo', desc: 'A drop-down list of options' },
  { type: 'button', desc: 'Clear the form, open a link…' },
  { type: 'date', desc: 'A date in a set format' },
  { type: 'signature', desc: 'Where someone signs' }
]

export function EditPreviewSwitch() {
  const toolId = useApp((s) => s.toolId)
  const editing = isFormTool(toolId)
  return (
    <Segmented<'edit' | 'preview'>
      value={editing ? 'edit' : 'preview'}
      onChange={(v) => setTool(v === 'edit' ? 'form.select' : 'select')}
      options={[
        { value: 'edit', label: 'Edit', title: 'Add, move and change fields' },
        { value: 'preview', label: 'Preview', title: 'Fill in the form as your users will' }
      ]}
    />
  )
}

/** Left pane of "Prepare a form". */
export function PreparePanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame title="Prepare a form">
      {doc ? <PreparePanelBody doc={doc} /> : <p className="shell-muted">Open a PDF to prepare a form.</p>}
    </ToolPanelFrame>
  )
}

function PreparePanelBody({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const showTabs = usePF((s) => s.showTabNumbers)
  const hasForm = useDocState(doc, (s) => s.info.hasForm)
  const signed = useDocState(doc, (s) => s.info.signatureCount > 0)
  const xfa = useDocState(doc, (s) => s.info.hasXfa)
  const { fields, loaded } = useAllFields(doc)

  // Acrobat offers automatic field detection when a document without fields is opened here.
  useEffect(() => {
    if (!loaded || fields.length || hasForm) return
    void offerDetection(doc)
  }, [doc, loaded, fields.length, hasForm])

  const editing = isFormTool(toolId)
  return (
    <div className="fc-prepare-form-left">
      <div className="fc-prepare-form-mode">
        <EditPreviewSwitch />
        <span className="shell-muted">{editing ? 'Editing fields' : 'Filling in the form'}</span>
      </div>
      {signed && (
        <div className="fc-prepare-form-note is-warning" role="note">
          <TriangleAlert size={16} aria-hidden />
          <span>
            This document is signed. Adding or changing fields makes the existing signatures invalid.
          </span>
        </div>
      )}
      {xfa && (
        <div className="fc-prepare-form-note is-warning" role="note">
          <TriangleAlert size={16} aria-hidden />
          <span>
            This form also has an XFA (LiveCycle) design. Fartcrobat edits its standard fields; apps that show
            the XFA design will not see the changes.
          </span>
        </div>
      )}
      <Section title="Add a form field">
        <ToolRow
          icon={MousePointer2}
          label="Select and move fields"
          active={toolId === 'form.select'}
          onClick={() => setTool('form.select')}
        />
        {ADD.map((a) => (
          <ToolRow
            key={a.type}
            icon={TYPE_ICONS[a.type]}
            label={TYPE_LABELS[a.type]}
            description={a.desc}
            active={toolId === TYPE_TOOLS[a.type]}
            onClick={() => {
              clearFieldSelection(doc)
              setTool(TYPE_TOOLS[a.type])
            }}
          />
        ))}
      </Section>
      <Section title="More">
        <ToolRow
          icon={WandSparkles}
          label="Detect form fields automatically"
          description="Turn blanks and boxes into fields"
          onClick={() => void detectFieldsFlow(doc)}
        />
        <ToolRow
          icon={PanelRight}
          label="Fields panel"
          description={`${fields.length} field${fields.length === 1 ? '' : 's'} in this document`}
          onClick={() => openRightPanel('fields')}
        />
        <ToolRow
          icon={ListOrdered}
          label={showTabs ? 'Hide tab numbers' : 'Show tab numbers'}
          description="The order the Tab key follows"
          onClick={() => usePF.setState({ showTabNumbers: !showTabs })}
        />
        <ToolRow
          icon={Calculator}
          label="Set field calculation order"
          onClick={() => void openCalculationOrder(doc)}
        />
        <ToolRow
          icon={Trash}
          label="Delete all fields"
          disabled={!fields.length}
          onClick={async () => {
            if (
              !(await confirm({
                title: 'Delete all fields',
                message: `Delete all ${fields.length} form fields from this document? You can undo this.`,
                confirmLabel: 'Delete all',
                danger: true
              }))
            )
              return
            try {
              const n = await pf(doc).deleteAll()
              clearFieldSelection(doc)
              void refreshInfo(doc)
              toast(`Deleted ${n} field${n === 1 ? '' : 's'}`)
            } catch (err) {
              showError(err, 'Could not delete the fields')
            }
          }}
        />
      </Section>
      <div className="fc-prepare-form-tip">
        {editing ? <PencilLine size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
        <span>
          {editing
            ? 'Click a field tool, then click or drag on the page. Double-click a field for its properties; Shift-click or drag a box around fields to select several.'
            : 'Fill in fields to test the form. Switch back to Edit to change it.'}
        </span>
      </div>
    </div>
  )
}

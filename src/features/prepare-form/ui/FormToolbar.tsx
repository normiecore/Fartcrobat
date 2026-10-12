import { Calculator, Ellipsis, Eye, ListOrdered, MousePointer2, PanelRight, Settings2, WandSparkles, X } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  IconButton,
  openRightPanel,
  openToolGroup,
  setTool,
  useApp,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { TYPE_LABELS, type PFType } from '../model'
import { clearFieldSelection, fieldSelection, TYPE_TOOLS } from './actions'
import { openCalculationOrder } from './CalcOrderDialog'
import { detectFieldsFlow } from './detectFlow'
import { TYPE_ICONS } from './icons'
import { openProperties } from './PropertiesDialog'
import { usePF } from './state'

const TYPES: PFType[] = ['text', 'checkbox', 'radio', 'list', 'combo', 'button', 'date', 'signature']

/** Contextual toolbar while editing a form (Acrobat's horizontal field toolbar). */
export function FormToolbar({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const selection = useDocState(doc, (s) => s.selection)
  const showTabs = usePF((s) => s.showTabNumbers)
  const radioGroup = usePF((s) => s.radioGroup)
  const signer = usePF((s) => s.pendingSigner)
  const sel = fieldSelection(selection)
  return (
    <div className="fc-prepare-form-toolbar" role="toolbar" aria-label="Form fields">
      <IconButton icon={MousePointer2} label="Select fields" active={toolId === 'form.select'} onClick={() => setTool('form.select')} />
      <span className="shell-sep" />
      {TYPES.map((t) => (
        <IconButton
          key={t}
          icon={TYPE_ICONS[t]}
          label={`Add ${TYPE_LABELS[t].toLowerCase()}`}
          active={toolId === TYPE_TOOLS[t]}
          onClick={() => {
            clearFieldSelection(doc)
            setTool(TYPE_TOOLS[t])
          }}
        />
      ))}
      <span className="shell-sep" />
      <span className="fc-prepare-form-toolbar-hint">
        {signer
          ? `Placing a field for ${signer.name}: click or drag on the page`
          : radioGroup && toolId === 'form.radio'
            ? `Adding a button to “${radioGroup}”: click on the page`
            : toolId !== 'form.select'
              ? 'Click to place, drag to draw, or press Enter. Esc to stop.'
              : sel?.ids.length
                ? `${sel.ids.length} field${sel.ids.length > 1 ? 's' : ''} selected`
                : ''}
      </span>
      <span className="fc-prepare-form-toolbar-spacer" />
      {!!sel?.ids.length && (
        <Button size="sm" icon={Settings2} title="Field properties (Enter)" onClick={() => openProperties(doc, sel.ids)}>
          Properties
        </Button>
      )}
      <Button size="sm" icon={Eye} onClick={() => setTool('select')} title="Fill in the form as your users will">
        Preview
      </Button>
      <DropdownMenu
        align="right"
        trigger={(p) => <IconButton icon={Ellipsis} label="More form options" {...p} />}
        items={() => [
          { id: 'detect', label: 'Detect form fields automatically', icon: WandSparkles, run: () => void detectFieldsFlow(doc) },
          { id: 'tabs', label: showTabs ? 'Hide tab numbers' : 'Show tab numbers', icon: ListOrdered, run: () => usePF.setState({ showTabNumbers: !showTabs }) },
          { id: 'calc', label: 'Set field calculation order…', icon: Calculator, run: () => void openCalculationOrder(doc) },
          { id: 'panel', label: 'Show Fields panel', icon: PanelRight, run: () => openRightPanel('fields') }
        ]}
      />
      <IconButton icon={X} label="Close form editing" onClick={() => openToolGroup(null)} />
    </div>
  )
}

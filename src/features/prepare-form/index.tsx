import { Calculator, CopyPlus, Eye, FilePenLine, ListOrdered, MousePointer2, Send, Settings2, TextCursorInput, Trash, WandSparkles } from 'lucide-react'
import {
  defineFeature,
  openToolGroup,
  setTool,
  useApp,
  type CommandDefinition,
  type MenuContribution,
  type ToolDefinition
} from '@renderer/sdk'
import { TYPE_LABELS, type PFType } from './model'
import {
  copySelected,
  deleteSelected,
  duplicateSelected,
  enterFormEditing,
  isFormTool,
  pasteFields,
  selectAllFields,
  selectedIds,
  TYPE_TOOLS
} from './ui/actions'
import { openCalculationOrder } from './ui/CalcOrderDialog'
import { detectFieldsFlow } from './ui/detectFlow'
import { FieldLayer } from './ui/FieldLayer'
import { FieldsPanel } from './ui/FieldsPanel'
import { FormToolbar } from './ui/FormToolbar'
import { PrepareFormKeys } from './ui/Globals'
import { TYPE_ICONS } from './ui/icons'
import { PreparePanel } from './ui/PreparePanel'
import { openProperties } from './ui/PropertiesDialog'
import { RequestSignPanel } from './ui/RequestSignPanel'
import { usePF } from './ui/state'
import './prepare-form.css'

const TYPES: PFType[] = ['text', 'checkbox', 'radio', 'list', 'combo', 'button', 'signature', 'date']

const editingForm = () => isFormTool(useApp.getState().toolId)
const hasFieldSelection = (doc: Parameters<NonNullable<CommandDefinition['enabled']>>[0]['doc']) => editingForm() && selectedIds(doc).length > 0

const tools: ToolDefinition[] = [
  {
    id: 'form.select',
    label: 'Select form fields',
    icon: MousePointer2,
    layer: FieldLayer,
    toolbar: FormToolbar
  },
  ...TYPES.map(
    (t): ToolDefinition => ({
      id: TYPE_TOOLS[t],
      label: `Add ${TYPE_LABELS[t].toLowerCase()}`,
      icon: TYPE_ICONS[t],
      cursor: 'crosshair',
      layer: FieldLayer,
      toolbar: FormToolbar
    })
  )
]

const commands: CommandDefinition[] = [
  {
    id: 'form.prepare',
    label: 'Prepare Form',
    icon: FilePenLine,
    run: () => openToolGroup('prepareform'),
    keywords: ['form', 'fields', 'fillable', 'acroform', 'create form', 'form fields']
  },
  {
    id: 'form.requestSign',
    label: 'Request E-signatures',
    icon: Send,
    run: () => openToolGroup('requestsign'),
    keywords: ['send for signature', 'signers', 'e-sign', 'esign']
  },
  {
    id: 'form.detect',
    label: 'Detect Form Fields',
    icon: WandSparkles,
    run: async ({ doc }) => {
      enterFormEditing()
      await detectFieldsFlow(doc!)
    },
    keywords: ['auto detect', 'automatic', 'fields']
  },
  ...TYPES.map(
    (t): CommandDefinition => ({
      id: `form.add.${t}`,
      label: `Add ${TYPE_LABELS[t]}`,
      icon: TYPE_ICONS[t],
      run: () => enterFormEditing(TYPE_TOOLS[t]),
      keywords: ['form field', 'prepare form']
    })
  ),
  {
    id: 'form.properties',
    label: 'Field Properties…',
    icon: Settings2,
    enabled: ({ doc }) => hasFieldSelection(doc),
    run: ({ doc }) => openProperties(doc!, selectedIds(doc))
  },
  {
    id: 'form.duplicate',
    label: 'Duplicate Field',
    icon: CopyPlus,
    enabled: ({ doc }) => hasFieldSelection(doc),
    run: ({ doc }) => duplicateSelected(doc!)
  },
  {
    id: 'form.delete',
    label: 'Delete Field',
    icon: Trash,
    shortcut: ['Delete', 'Backspace'],
    enabled: ({ doc }) => hasFieldSelection(doc),
    run: ({ doc }) => deleteSelected(doc!)
  },
  {
    id: 'form.copy',
    label: 'Copy Fields',
    shortcut: 'Mod+C',
    hidden: true,
    enabled: ({ doc }) => hasFieldSelection(doc),
    run: ({ doc }) => copySelected(doc!)
  },
  {
    id: 'form.cut',
    label: 'Cut Fields',
    shortcut: 'Mod+X',
    hidden: true,
    enabled: ({ doc }) => hasFieldSelection(doc),
    run: async ({ doc }) => {
      await copySelected(doc!)
      await deleteSelected(doc!)
    }
  },
  {
    id: 'form.paste',
    label: 'Paste Fields',
    shortcut: 'Mod+V',
    hidden: true,
    enabled: () => editingForm() && !!usePF.getState().clipboard?.length,
    run: ({ doc }) => pasteFields(doc!)
  },
  {
    id: 'form.selectAll',
    label: 'Select All Fields on Page',
    enabled: () => editingForm(),
    run: ({ doc }) => selectAllFields(doc!)
  },
  {
    id: 'form.tabNumbers',
    label: 'Show Tab Numbers',
    icon: ListOrdered,
    checked: () => usePF.getState().showTabNumbers,
    run: () => {
      usePF.setState((s) => ({ showTabNumbers: !s.showTabNumbers }))
      if (!editingForm()) enterFormEditing()
    }
  },
  {
    id: 'form.calcOrder',
    label: 'Set Field Calculation Order…',
    icon: Calculator,
    run: ({ doc }) => openCalculationOrder(doc!)
  },
  {
    id: 'form.preview',
    label: 'Preview Form',
    icon: Eye,
    checked: () => {
      const s = useApp.getState()
      return (s.toolGroupId === 'prepareform' || s.toolGroupId === 'requestsign') && !isFormTool(s.toolId)
    },
    run: () => {
      const s = useApp.getState()
      if (isFormTool(s.toolId)) setTool('select')
      else enterFormEditing()
    }
  }
]

const menus: MenuContribution[] = [
  { menu: 'forms', group: 'prepare', command: 'form.prepare', order: 0 },
  { menu: 'forms', group: 'prepare', command: 'form.detect', order: 1 },
  { menu: 'forms', group: 'prepare', command: 'form.preview', order: 2 },
  ...TYPES.map((t, i): MenuContribution => ({ menu: 'forms', group: 'add', command: `form.add.${t}`, order: 100 + i, submenu: 'Add Field' })),
  { menu: 'forms', group: 'edit', command: 'form.properties', order: 200 },
  { menu: 'forms', group: 'edit', command: 'form.duplicate', order: 201 },
  { menu: 'forms', group: 'edit', command: 'form.delete', order: 202 },
  { menu: 'forms', group: 'edit', command: 'form.selectAll', order: 203 },
  { menu: 'forms', group: 'order', command: 'form.tabNumbers', order: 300 },
  { menu: 'forms', group: 'order', command: 'form.calcOrder', order: 301 },
  { menu: 'sign', group: 'request', command: 'form.requestSign', order: 20 }
]

export default defineFeature({
  id: 'prepare-form',
  commands,
  menus,
  tools,
  toolGroups: [
    {
      id: 'prepareform',
      label: 'Prepare a form',
      icon: FilePenLine,
      color: '#d4317d',
      description: 'Turn a document into a fillable form: add text fields, check boxes, signature fields and more',
      order: 80,
      category: 'sign',
      panel: PreparePanel,
      defaultTool: 'form.select',
      keywords: ['form', 'fillable', 'fields', 'acroform']
    },
    {
      id: 'requestsign',
      label: 'Request e-signatures',
      icon: Send,
      color: '#7b4fd6',
      description: 'Add signature fields for each signer, then save and email the PDF',
      order: 85,
      category: 'sign',
      panel: RequestSignPanel,
      defaultTool: 'form.select',
      keywords: ['send for signature', 'signers']
    }
  ],
  rightPanels: [{ id: 'fields', label: 'Fields', icon: TextCursorInput, order: 50, component: FieldsPanel }],
  globals: [PrepareFormKeys]
})

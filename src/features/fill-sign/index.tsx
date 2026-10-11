import '@fontsource/dancing-script/400.css'
import '@fontsource/great-vibes/400.css'
import '@fontsource/caveat/400.css'
import '@fontsource/allura/400.css'
import './fill-sign.css'
import { PenLine, Trash2 } from 'lucide-react'
import {
  defineFeature,
  registry,
  useApp,
  type CommandDefinition,
  type MenuContribution,
  type ToolDefinition
} from '@renderer/sdk'
import { kindLabel } from './shared'
import { loadSaved, selectedItem, useFillSign } from './state'
import { deleteSelected, isFillSignTool, KIND_TOOL, openFillSign, PLACE_TOOL, startPlacing } from './actions'
import { KIND_ICON } from './icons'
import { FillSignLayer } from './FillSignLayer'
import { PlaceLayer } from './PlaceLayer'
import { FillSignToolbar, PlaceToolbar, TOOL_LABEL, TOOL_ORDER } from './Toolbar'
import { FillSignPanel } from './Panel'
import { SignatureSettings } from './Settings'
import { addSignatureFlow, clearSaved, openSignMenu, SignMenuHost } from './SignMenu'

const fillTools: ToolDefinition[] = TOOL_ORDER.map((k) => ({
  id: KIND_TOOL[k],
  label: TOOL_LABEL[k],
  icon: KIND_ICON[k],
  cursor: k === 'text' || k === 'date' ? 'text' : 'crosshair',
  toolbar: FillSignToolbar,
  onActivate: () => void loadSaved()
}))

const placeTool: ToolDefinition = {
  id: PLACE_TOOL,
  label: 'Place signature',
  icon: PenLine,
  cursor: 'crosshair',
  layer: PlaceLayer,
  toolbar: PlaceToolbar,
  onDeactivate: () => useFillSign.setState({ placing: null })
}

const toolCommands: CommandDefinition[] = TOOL_ORDER.map((k) => ({
  id: `fillsign.tool.${k}`,
  label: TOOL_LABEL[k],
  icon: KIND_ICON[k],
  keywords: ['fill', 'sign', 'fill and sign', 'form', kindLabel(k).toLowerCase()],
  checked: () => useApp.getState().toolId === KIND_TOOL[k],
  run: () => openFillSign(KIND_TOOL[k])
}))

const commands: CommandDefinition[] = [
  {
    id: 'fillsign.open',
    label: 'Fill & Sign',
    icon: PenLine,
    keywords: ['fill', 'sign', 'signature', 'form', 'type on pdf'],
    run: () => openFillSign()
  },
  {
    id: 'fillsign.signYourself',
    label: 'Sign Yourself',
    icon: PenLine,
    keywords: ['signature', 'initials', 'sign', 'e-sign'],
    run: () => openSignMenu()
  },
  {
    id: 'fillsign.addSignature',
    label: 'Add Signature…',
    keywords: ['signature', 'sign'],
    run: () => addSignatureFlow('signature')
  },
  {
    id: 'fillsign.addInitials',
    label: 'Add Initials…',
    keywords: ['initials', 'sign'],
    run: () => addSignatureFlow('initials')
  },
  {
    id: 'fillsign.placeSignature',
    label: 'Place Saved Signature',
    keywords: ['signature', 'sign'],
    enabled: () => !!useFillSign.getState().signature,
    run: () => {
      const sig = useFillSign.getState().signature
      if (sig) startPlacing('signature', sig)
    }
  },
  {
    id: 'fillsign.placeInitials',
    label: 'Place Saved Initials',
    keywords: ['initials', 'sign'],
    enabled: () => !!useFillSign.getState().initials,
    run: () => {
      const ini = useFillSign.getState().initials
      if (ini) startPlacing('initials', ini)
    }
  },
  {
    id: 'fillsign.clearSaved',
    label: 'Clear Saved Signatures…',
    requiresDocument: false,
    keywords: ['signature', 'initials', 'remove', 'delete'],
    enabled: () => !!(useFillSign.getState().signature || useFillSign.getState().initials),
    run: () => clearSaved()
  },
  {
    id: 'fillsign.delete',
    label: 'Delete Fill & Sign Item',
    icon: Trash2,
    shortcut: ['Delete', 'Backspace'],
    hidden: true,
    enabled: (ctx) => !!selectedItem(ctx.doc),
    run: (ctx) => deleteSelected(ctx.doc!)
  },
  ...toolCommands
]

const menus: MenuContribution[] = [
  { menu: 'sign', group: 'fillsign', command: 'fillsign.open', order: 0 },
  { menu: 'sign', group: 'fillsign', command: 'fillsign.signYourself', order: 1 },
  { menu: 'sign', group: 'fillsign', command: 'fillsign.addSignature', order: 2 },
  { menu: 'sign', group: 'fillsign', command: 'fillsign.addInitials', order: 3 },
  { menu: 'sign', group: 'fillsign', command: 'fillsign.placeSignature', order: 4 },
  { menu: 'sign', group: 'fillsign', command: 'fillsign.placeInitials', order: 5 },
  ...toolCommands.map((c, i) => ({ menu: 'sign' as const, group: 'fillsign', command: c.id, order: 10 + i, submenu: 'Fill & Sign Tools' })),
  { menu: 'sign', group: 'fillsign', command: 'fillsign.clearSaved', order: 30 },
  { menu: 'tools', group: 'sign', command: 'fillsign.open', order: 70 }
]

export default defineFeature({
  id: 'fill-sign',
  commands,
  menus,
  tools: [...fillTools, placeTool],
  toolGroups: [
    {
      id: 'fillsign',
      label: 'Fill & Sign',
      icon: PenLine,
      color: '#7a4fe0',
      description: 'Fill in forms, add your signature or initials',
      order: 70,
      category: 'sign',
      homeTile: true,
      panel: FillSignPanel,
      defaultTool: 'fillsign.text',
      keywords: ['fill', 'sign', 'signature', 'initials', 'form', 'type']
    }
  ],
  pageLayers: [
    {
      id: 'fill-sign',
      order: 45,
      component: FillSignLayer,
      when: ({ toolId }) =>
        toolId === 'select' || isFillSignTool(toolId) || !!registry.tools.get(toolId)?.allowDefaultInteractions
    }
  ],
  settings: [{ id: 'signatures', label: 'Signatures', order: 40, component: SignatureSettings }],
  quickTools: [
    { id: 'fillsign.text', order: 40 },
    { id: 'fillsign.signYourself', order: 50 }
  ],
  globals: [SignMenuHost],
  onDocumentOpen: () => void loadSaved()
})

import { Crop, Eraser, FilePen, Hash, Layers, PaintBucket, Scissors, Stamp } from 'lucide-react'
import { defineFeature, setTool, useApp, type CommandDefinition, type MenuContribution } from '@renderer/sdk'
import { addMarks, removeCrop, removeMarksFromUi, updateMarks } from './actions'
import { hasMarks, listingOf, trackDocument } from './store'
import type { MarkType } from './shared'
import { CropLayer, CropToolbar, openPageBoxes } from './ui/CropTool'
import { PageMarksPanel } from './ui/Panel'
import './page-marks.css'

const markCommands = (
  type: MarkType,
  ids: { add: string; update?: string; remove: string },
  names: { add: string; update?: string; remove: string },
  icon: CommandDefinition['icon'],
  keywords: string[]
): CommandDefinition[] => {
  const out: CommandDefinition[] = [
    { id: ids.add, label: names.add, icon, keywords, run: ({ doc }) => addMarks(doc!, type) }
  ]
  if (ids.update && names.update) {
    out.push({
      id: ids.update,
      label: names.update,
      icon,
      keywords,
      enabled: ({ doc }) => hasMarks(doc, type),
      run: ({ doc }) => updateMarks(doc!, type)
    })
  }
  out.push({
    id: ids.remove,
    label: names.remove,
    icon: Eraser,
    keywords,
    enabled: ({ doc }) => hasMarks(doc, type),
    run: ({ doc }) => removeMarksFromUi(doc!, type)
  })
  return out
}

const commands: CommandDefinition[] = [
  ...markCommands(
    'HeaderFooter',
    {
      add: 'marks.headerFooter.add',
      update: 'marks.headerFooter.update',
      remove: 'marks.headerFooter.remove'
    },
    { add: 'Add Header & Footer…', update: 'Update Header & Footer…', remove: 'Remove Header & Footer…' },
    FilePen,
    ['header', 'footer', 'page numbers', 'number pages', 'date']
  ),
  ...markCommands(
    'Watermark',
    { add: 'marks.watermark.add', update: 'marks.watermark.update', remove: 'marks.watermark.remove' },
    { add: 'Add Watermark…', update: 'Update Watermark…', remove: 'Remove Watermark…' },
    Stamp,
    ['watermark', 'confidential', 'draft']
  ),
  ...markCommands(
    'Background',
    { add: 'marks.background.add', update: 'marks.background.update', remove: 'marks.background.remove' },
    { add: 'Add Background…', update: 'Update Background…', remove: 'Remove Background…' },
    PaintBucket,
    ['background', 'page colour', 'page color']
  ),
  ...markCommands(
    'Bates',
    { add: 'marks.bates.add', remove: 'marks.bates.remove' },
    { add: 'Add Bates Numbering…', remove: 'Remove Bates Numbering…' },
    Hash,
    ['bates', 'legal', 'numbering', 'page numbers']
  ),
  {
    id: 'marks.crop',
    label: 'Crop Pages',
    icon: Crop,
    keywords: ['crop', 'trim', 'cut margins'],
    checked: () => useApp.getState().toolId === 'marks.crop',
    // Like Acrobat's Crop Pages button: a second click puts the tool away.
    run: () => setTool(useApp.getState().toolId === 'marks.crop' ? 'select' : 'marks.crop')
  },
  {
    id: 'marks.setPageBoxes',
    label: 'Set Page Boxes…',
    icon: Scissors,
    shortcut: 'Mod+Shift+T',
    keywords: ['crop', 'remove white margins', 'trim box', 'bleed box', 'art box'],
    run: ({ doc }) => openPageBoxes(doc!, doc!.state.currentPage)
  },
  {
    id: 'marks.removeCrop',
    label: 'Remove Crop…',
    icon: Eraser,
    keywords: ['uncrop', 'reset crop', 'media box'],
    enabled: ({ doc }) => listingOf(doc).croppedPages.length > 0,
    run: ({ doc }) => removeCrop(doc!)
  }
]

const sub = (submenu: string, order: number, ids: string[]): MenuContribution[] =>
  ids.map((command, i) => ({ menu: 'document', group: 'pagemarks', submenu, order: order + i, command }))

const menus: MenuContribution[] = [
  ...sub('Header & Footer', 400, [
    'marks.headerFooter.add',
    'marks.headerFooter.update',
    'marks.headerFooter.remove'
  ]),
  ...sub('Watermark', 410, ['marks.watermark.add', 'marks.watermark.update', 'marks.watermark.remove']),
  ...sub('Background', 420, ['marks.background.add', 'marks.background.update', 'marks.background.remove']),
  ...sub('Bates Numbering', 430, ['marks.bates.add', 'marks.bates.remove']),
  { menu: 'document', group: 'crop', order: 450, command: 'marks.crop' },
  { menu: 'document', group: 'crop', order: 451, command: 'marks.setPageBoxes' },
  { menu: 'document', group: 'crop', order: 452, command: 'marks.removeCrop' }
]

export default defineFeature({
  id: 'page-marks',
  commands,
  menus,
  tools: [
    {
      id: 'marks.crop',
      label: 'Crop Pages',
      icon: Crop,
      cursor: 'crosshair',
      layer: CropLayer,
      toolbar: CropToolbar
    }
  ],
  toolGroups: [
    {
      id: 'pagemarks',
      label: 'Add header, watermark or background',
      icon: Layers,
      color: '#7B5CD6',
      description:
        'Add headers, footers, page numbers, watermarks, backgrounds and Bates numbers, or crop pages.',
      order: 175,
      category: 'edit',
      panel: PageMarksPanel,
      keywords: ['header', 'footer', 'watermark', 'background', 'bates', 'page numbers', 'crop']
    }
  ],
  onDocumentOpen: (doc) => trackDocument(doc)
})

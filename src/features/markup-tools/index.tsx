/**
 * markup-tools: every comment creation tool (Acrobat's "Add comments" tool group): text markup,
 * sticky notes, text comments, text boxes, callouts, free-form drawing and eraser, shapes, clouds
 * and area highlights, with an options bar per tool and remembered defaults.
 */
import { useEffect, type ComponentType } from 'react'
import { Highlighter, MessageSquarePlus, StickyNote, Strikethrough, Underline } from 'lucide-react'
import {
  defineFeature,
  setTool,
  useApp,
  type CommandDefinition,
  type MenuContribution,
  type PageLayerProps,
  type ToolDefinition
} from '@renderer/sdk'
import { applyTextMarkup, runSelectionMarkup } from './actions'
import { ClickLayer, placeNote } from './layers/ClickLayer'
import { EraserLayer } from './layers/EraserLayer'
import { PencilLayer, endPencilSession } from './layers/PencilLayer'
import { PolyLayer, cancelPolyDraft } from './layers/PolyLayer'
import { ShapeLayer, cancelCalloutTip } from './layers/ShapeLayer'
import { TextMarkupLayer, useTextDrag } from './layers/TextMarkupLayer'
import { CommentPanel } from './Panel'
import { loadToolStyles, syncCommentDefaults } from './style'
import { MarkupToolbar } from './Toolbar'
import { CYCLES, SECTIONS, TOOL_BY_ID, TOOLS, type ToolKind } from './tools'
import './markup-tools.css'

const LAYERS: Record<ToolKind, ComponentType<PageLayerProps>> = {
  textMarkup: TextMarkupLayer,
  replaceText: TextMarkupLayer,
  insertText: ClickLayer,
  note: ClickLayer,
  typewriter: ClickLayer,
  textbox: ShapeLayer,
  callout: ShapeLayer,
  attach: ClickLayer,
  rect: ShapeLayer,
  line: ShapeLayer,
  areaHighlight: ShapeLayer,
  poly: PolyLayer,
  pencil: PencilLayer,
  eraser: EraserLayer
}

const CURSORS: Partial<Record<ToolKind, string>> = {
  textMarkup: 'text',
  replaceText: 'text',
  insertText: 'text',
  typewriter: 'text'
}

const tools: ToolDefinition[] = TOOLS.map((t) => ({
  id: t.id,
  label: t.label,
  icon: t.icon,
  shortcut: t.shortcut,
  cursor: CURSORS[t.kind] ?? 'crosshair',
  layer: LAYERS[t.kind],
  toolbar: MarkupToolbar,
  onActivate: (ctx) => {
    void syncCommentDefaults(t)
    // Text already selected? Apply the markup to it straight away (like Acrobat).
    const doc = ctx.doc
    if (doc && (t.kind === 'textMarkup' || t.kind === 'replaceText')) {
      const sel = doc.state.selection
      if (sel.kind === 'text' && sel.ranges.some((r) => r.end > r.start)) void applyTextMarkup(doc, t, sel.ranges)
    }
  },
  onDeactivate: () => {
    cancelPolyDraft()
    cancelCalloutTip()
    endPencilSession()
    useTextDrag.setState({ drag: null })
  }
}))

const commands: CommandDefinition[] = [
  ...TOOLS.map(
    (t): CommandDefinition => ({
      id: t.id,
      label: t.menuLabel,
      icon: t.icon,
      shortcut: t.shortcut,
      keywords: [t.label, ...t.keywords, 'comment', 'annotate', 'markup'],
      checked: () => useApp.getState().toolId === t.id,
      run: () => setTool(t.id)
    })
  ),
  ...CYCLES.map(
    (c): CommandDefinition => ({
      id: c.id,
      label: c.label,
      shortcut: c.shortcut,
      keywords: ['cycle', 'next tool'],
      run: () => {
        const cur = useApp.getState().toolId
        const i = c.tools.indexOf(cur)
        setTool(c.tools[(i + 1) % c.tools.length])
      }
    })
  )
]

const menus: MenuContribution[] = SECTIONS.flatMap((sec, si) =>
  TOOLS.filter((t) => t.section === sec.id).map(
    (t, i): MenuContribution => ({ menu: 'comment', group: sec.menuGroup, command: t.id, order: 100 * (si + 1) + i, submenu: sec.submenu })
  )
)

function DefaultsLoader() {
  useEffect(() => {
    void loadToolStyles()
  }, [])
  return null
}

export default defineFeature({
  id: 'markup-tools',
  tools,
  commands,
  menus,
  toolGroups: [
    {
      id: 'comment',
      label: 'Add comments',
      icon: MessageSquarePlus,
      color: '#E68619',
      description: 'Highlight text, add sticky notes, text boxes, callouts, drawings and shapes',
      order: 60,
      category: 'review',
      homeTile: true,
      panel: CommentPanel,
      defaultTool: 'select',
      keywords: ['comment', 'annotate', 'markup', 'review', 'highlight', 'note', 'draw']
    }
  ],
  quickTools: [
    { id: 'comment.note', order: 10 },
    { id: 'comment.highlight', order: 20 },
    { id: 'comment.pencil', order: 30 }
  ],
  textSelectionActions: [
    { id: 'markup.highlight', label: 'Highlight', icon: Highlighter, order: 10, run: runSelectionMarkup('comment.highlight') },
    { id: 'markup.underline', label: 'Underline', icon: Underline, order: 20, run: runSelectionMarkup('comment.underline') },
    { id: 'markup.strikeout', label: 'Strikethrough', icon: Strikethrough, order: 30, run: runSelectionMarkup('comment.strikeout') },
    { id: 'markup.note', label: 'Add note to text', icon: MessageSquarePlus, order: 40, run: runSelectionMarkup('comment.highlight', { withNote: true }) }
  ],
  pageContextMenu: [
    {
      id: 'markup-tools',
      order: 20,
      items: ({ doc, pageIndex, point }) => {
        const note = TOOL_BY_ID.get('comment.note')!
        const page = doc.state.info.pages[pageIndex]
        if (!page) return []
        return [
          {
            id: 'markup-tools.addNote',
            label: 'Add Sticky Note',
            icon: StickyNote,
            run: () => void placeNote(doc, note, pageIndex, point, { width: page.width, height: page.height })
          }
        ]
      }
    }
  ],
  globals: [DefaultsLoader]
})

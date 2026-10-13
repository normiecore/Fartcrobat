import { useEffect, useState } from 'react'
import {
  ChevronDown,
  Crop,
  Droplet,
  Hash,
  Image as ImageIcon,
  LayoutGrid,
  Link,
  PanelTop,
  ScanText,
  TextCursorInput,
  Type,
  Wallpaper,
  X
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  getActiveDoc,
  openToolGroup,
  registry,
  runCommand,
  setTool,
  ToolPanelFrame,
  ToolRow,
  Section,
  useApp,
  useDocState,
  usePageVersion,
  type ContextMenuItem,
  type DocumentModel,
  type Icon
} from '@renderer/sdk'
import { PanelFormat } from './FormatControls'
import { commitSession, loadBlocks, useEditText } from './store'

interface Entry {
  id: string
  kind: 'tool' | 'command'
  label: string
  description?: string
  icon: Icon
  /** Related commands offered in a menu (e.g. Add / Update / Remove a watermark). */
  more?: { id: string; label: string }[]
}

const CONTENT: Entry[] = [
  {
    id: 'edit.content',
    kind: 'tool',
    label: 'Edit text & images',
    description: 'Click any text or image to change it',
    icon: TextCursorInput
  },
  {
    id: 'edit.addText',
    kind: 'tool',
    label: 'Add text',
    description: 'Click where the new text should go',
    icon: Type
  },
  { id: 'edit.addImage', kind: 'tool', label: 'Add image', icon: ImageIcon },
  { id: 'edit.link', kind: 'tool', label: 'Link', description: 'Add or edit links', icon: Link }
]

const marks = (kind: string, remove = true): Entry['more'] => [
  { id: `marks.${kind}.add`, label: 'Add…' },
  { id: `marks.${kind}.update`, label: 'Update…' },
  ...(remove ? [{ id: `marks.${kind}.remove`, label: 'Remove' }] : [])
]

const PAGES: Entry[] = [
  { id: 'marks.crop', kind: 'command', label: 'Crop pages', icon: Crop },
  {
    id: 'marks.headerFooter.add',
    kind: 'command',
    label: 'Header & footer',
    icon: PanelTop,
    more: marks('headerFooter')
  },
  { id: 'marks.watermark.add', kind: 'command', label: 'Watermark', icon: Droplet, more: marks('watermark') },
  {
    id: 'marks.background.add',
    kind: 'command',
    label: 'Background',
    icon: Wallpaper,
    more: marks('background')
  },
  {
    id: 'marks.bates.add',
    kind: 'command',
    label: 'Bates numbering',
    icon: Hash,
    more: [
      { id: 'marks.bates.add', label: 'Add…' },
      { id: 'marks.bates.remove', label: 'Remove' }
    ]
  },
  { id: 'organize.open', kind: 'command', label: 'Organize pages', icon: LayoutGrid },
  {
    id: 'ocr.recognize',
    kind: 'command',
    label: 'Recognize text (OCR)',
    description: 'Make scanned pages editable',
    icon: ScanText
  }
]

function available(e: Entry): boolean {
  return e.kind === 'tool'
    ? registry.tools.has(e.id)
    : registry.commands.has(e.id) || (e.id === 'marks.crop' && registry.tools.has('marks.crop'))
}

function run(id: string, kind: Entry['kind'] = 'command') {
  if (kind === 'tool') {
    setTool(id)
    return
  }
  void commitSession().then(() => {
    if (registry.commands.has(id)) void runCommand(id)
    else if (registry.tools.has(id)) setTool(id)
  })
}

/** A panel row that opens a small menu (Add / Update / Remove) when there is more than one action. */
function MenuRow({ entry, disabled }: { entry: Entry; disabled: boolean }) {
  const cmd = registry.commands.get(entry.id)
  const IconC = cmd?.icon ?? entry.icon
  const more = (entry.more ?? []).filter((m) => registry.commands.has(m.id))
  if (more.length < 2)
    return (
      <ToolRow
        icon={IconC}
        label={entry.label}
        description={entry.description}
        disabled={disabled}
        onClick={() => run(entry.id)}
      />
    )
  const items = (): ContextMenuItem[] => {
    const ctx = { doc: getActiveDoc() }
    return more.map((m) => {
      const c = registry.commands.get(m.id)!
      let enabled = true
      try {
        enabled = c.enabled ? c.enabled(ctx) : true
      } catch {
        enabled = false
      }
      return { id: m.id, label: m.label, disabled: !enabled, run: () => run(m.id) }
    })
  }
  return (
    <DropdownMenu
      items={items}
      trigger={(t) => (
        <button type="button" className="ui-tool-row" disabled={disabled} aria-haspopup="menu" {...t}>
          <IconC size={18} />
          <span className="ui-tool-row-text">
            <span className="ui-tool-row-label">{entry.label}</span>
            {entry.description && <span className="ui-tool-row-desc">{entry.description}</span>}
          </span>
          <ChevronDown size={14} className="fc-edit-text-row-chevron" />
        </button>
      )}
    />
  )
}

export function EditPanel({ doc }: { doc: DocumentModel | null }) {
  const toolId = useApp((s) => s.toolId)
  const editing = useEditText((s) => !!s.session)
  const content = CONTENT.filter(available)
  const pages = PAGES.filter(available)
  return (
    <ToolPanelFrame title="Edit a PDF">
      <div className="fc-edit-text-panel" data-fc-edit-text-keep>
        <Section title="Edit and add">
          {content.map((e) => {
            const tool = registry.tools.get(e.id)
            return (
              <ToolRow
                key={e.id}
                icon={tool?.icon ?? e.icon}
                label={e.label}
                description={e.description}
                active={toolId === e.id}
                disabled={!doc}
                onClick={() => run(e.id, e.kind)}
              />
            )
          })}
        </Section>
        <Section title={editing ? 'Format selected text' : 'Format'}>
          <PanelFormat />
        </Section>
        {pages.length > 0 && (
          <Section title="Pages">
            {pages.map((e) => (
              <MenuRow key={e.id} entry={e} disabled={!doc} />
            ))}
          </Section>
        )}
      </div>
    </ToolPanelFrame>
  )
}

/** Whether a page has editable text (null while unknown). */
function usePageHasText(doc: DocumentModel, page: number, enabled: boolean): boolean | null {
  const version = usePageVersion(doc, page)
  const [state, setState] = useState<{ key: string; has: boolean } | null>(null)
  const key = `${page}:${version}`
  useEffect(() => {
    if (!enabled) return
    let alive = true
    loadBlocks(doc, page).then(
      (blocks) => alive && setState({ key, has: blocks.length > 0 }),
      () => alive && setState(null)
    )
    return () => {
      alive = false
    }
  }, [doc, page, key, enabled])
  return state && state.key === key ? state.has : null
}

/** Contextual bar under the document toolbar while editing. */
export function EditToolbar({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const editing = useEditText((s) => !!s.session)
  const page = useDocState(doc, (s) => s.currentPage)
  const hasText = usePageHasText(doc, page, toolId === 'edit.content')
  const noText = toolId === 'edit.content' && !editing && hasText === false
  const hint =
    toolId === 'edit.addText'
      ? 'Click where you want to add text, or drag to set the width of a text box.'
      : editing
        ? 'Type to change the text. Drag the frame to move it. Click outside the box when you are done, or press Esc to cancel.'
        : noText
          ? 'This page has no editable text. If it is a scan, recognize its text first.'
          : 'Click any text on the page to edit it.'
  return (
    <div className="fc-edit-text-toolbar" data-fc-edit-text-keep>
      <div className="ui-segmented" role="radiogroup" aria-label="Edit mode">
        <button
          type="button"
          role="radio"
          aria-checked={toolId === 'edit.content'}
          className={toolId === 'edit.content' ? 'is-active' : ''}
          onClick={() => setTool('edit.content')}
        >
          <TextCursorInput size={14} /> Edit
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={toolId === 'edit.addText'}
          className={toolId === 'edit.addText' ? 'is-active' : ''}
          onClick={() => setTool('edit.addText')}
        >
          <Type size={14} /> Add text
        </button>
      </div>
      <span className="fc-edit-text-toolbar-hint" title={hint}>
        {hint}
      </span>
      {noText && registry.commands.has('ocr.recognize') && (
        <Button size="sm" icon={ScanText} onClick={() => void runCommand('ocr.recognize')}>
          Recognize text
        </Button>
      )}
      <Button
        size="sm"
        variant="quiet"
        icon={X}
        onClick={() => void commitSession().then(() => openToolGroup(null))}
      >
        Close
      </Button>
    </div>
  )
}

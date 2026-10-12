import { Crop, Droplet, Hash, Image as ImageIcon, LayoutGrid, Link, PanelTop, ScanText, TextCursorInput, Type, Wallpaper, X } from 'lucide-react'
import {
  Button,
  openToolGroup,
  registry,
  runCommand,
  setTool,
  ToolPanelFrame,
  ToolRow,
  Section,
  useApp,
  type DocumentModel,
  type Icon
} from '@renderer/sdk'
import { PanelFormat } from './FormatControls'
import { commitSession, useEditText } from './store'

interface Entry {
  id: string
  kind: 'tool' | 'command'
  label: string
  description?: string
  icon: Icon
}

const CONTENT: Entry[] = [
  { id: 'edit.content', kind: 'tool', label: 'Edit text & images', description: 'Click any text or image to change it', icon: TextCursorInput },
  { id: 'edit.addText', kind: 'tool', label: 'Add text', description: 'Click where the new text should go', icon: Type },
  { id: 'edit.addImage', kind: 'tool', label: 'Add image', icon: ImageIcon },
  { id: 'edit.link', kind: 'tool', label: 'Link', description: 'Add or edit links', icon: Link }
]

const PAGES: Entry[] = [
  { id: 'marks.crop', kind: 'command', label: 'Crop pages', icon: Crop },
  { id: 'marks.headerFooter.add', kind: 'command', label: 'Header & footer', icon: PanelTop },
  { id: 'marks.watermark.add', kind: 'command', label: 'Watermark', icon: Droplet },
  { id: 'marks.background.add', kind: 'command', label: 'Background', icon: Wallpaper },
  { id: 'marks.bates.add', kind: 'command', label: 'Bates numbering', icon: Hash },
  { id: 'organize.open', kind: 'command', label: 'Organize pages', icon: LayoutGrid },
  { id: 'ocr.recognize', kind: 'command', label: 'Recognize text (OCR)', description: 'Make scanned pages editable', icon: ScanText }
]

function available(e: Entry): boolean {
  return e.kind === 'tool' ? registry.tools.has(e.id) : registry.commands.has(e.id) || (e.id === 'marks.crop' && registry.tools.has('marks.crop'))
}

function run(e: Entry) {
  if (e.kind === 'tool') {
    setTool(e.id)
    return
  }
  void commitSession().then(() => {
    if (registry.commands.has(e.id)) void runCommand(e.id)
    else if (registry.tools.has(e.id)) setTool(e.id)
  })
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
                onClick={() => run(e)}
              />
            )
          })}
        </Section>
        <Section title={editing ? 'Format selected text' : 'Format'}>
          <PanelFormat />
        </Section>
        {pages.length > 0 && (
          <Section title="Pages">
            {pages.map((e) => {
              const cmd = registry.commands.get(e.id)
              return <ToolRow key={e.id} icon={cmd?.icon ?? e.icon} label={e.label} description={e.description} disabled={!doc} onClick={() => run(e)} />
            })}
          </Section>
        )}
      </div>
    </ToolPanelFrame>
  )
}

/** Contextual bar under the document toolbar while editing. */
export function EditToolbar() {
  const toolId = useApp((s) => s.toolId)
  const editing = useEditText((s) => !!s.session)
  const hint =
    toolId === 'edit.addText'
      ? 'Click where you want to add text, or drag to set the width of a text box.'
      : editing
        ? 'Type to change the text. Drag the frame to move it. Press Esc to cancel, or click outside the box when you are done.'
        : 'Click any text on the page to edit it.'
  return (
    <div className="fc-edit-text-toolbar" data-fc-edit-text-keep>
      <div className="ui-segmented" role="radiogroup" aria-label="Edit mode">
        <button type="button" role="radio" aria-checked={toolId === 'edit.content'} className={toolId === 'edit.content' ? 'is-active' : ''} onClick={() => setTool('edit.content')}>
          <TextCursorInput size={14} /> Edit
        </button>
        <button type="button" role="radio" aria-checked={toolId === 'edit.addText'} className={toolId === 'edit.addText' ? 'is-active' : ''} onClick={() => setTool('edit.addText')}>
          <Type size={14} /> Add text
        </button>
      </div>
      <span className="fc-edit-text-toolbar-hint">{hint}</span>
      <Button size="sm" variant="quiet" icon={X} onClick={() => void commitSession().then(() => openToolGroup(null))}>
        Close
      </Button>
    </div>
  )
}

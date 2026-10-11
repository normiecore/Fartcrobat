import {
  Clipboard,
  Copy,
  File,
  FileInput,
  FileOutput,
  FilePlus2,
  Hash,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  X
} from 'lucide-react'
import {
  Button,
  displayShortcut,
  openToolGroup,
  Section,
  ToolPanelFrame,
  ToolRow,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { deletePages, duplicatePages, insertFromClipboard, rotatePages } from './actions'
import { openExtractDialog } from './dialogs/ExtractDialog'
import { openInsertDialog } from './dialogs/InsertDialog'
import { openLabelsDialog } from './dialogs/LabelsDialog'
import { openReplaceFlow } from './dialogs/ReplaceDialog'
import { openSplitDialog } from './dialogs/SplitDialog'
import { countLabel, formatPageRange } from './ranges'
import { useOrgState } from './store'
import { isMac } from '@renderer/sdk'

function Body({ doc }: { doc: DocumentModel }) {
  const pages = useDocState(doc, (s) => s.info.pages)
  const org = useOrgState(doc)
  const index = new Map(pages.map((p, i) => [p.id, i]))
  const selected = [
    ...new Set(org.selected.map((id) => index.get(id)).filter((i): i is number => i !== undefined))
  ].sort((a, b) => a - b)
  const n = selected.length
  const gap = n ? selected[n - 1] + 1 : pages.length
  const none = n === 0
  return (
    <>
      <div className="fc-organize-pages-panel-summary">
        <b>{countLabel(pages.length)}</b>
        <span className="shell-muted">
          {n ? `${n} selected: ${formatPageRange(selected)}` : 'No pages selected'}
        </span>
      </div>
      <Section title="Selected pages">
        <ToolRow
          icon={RotateCcw}
          label="Rotate counterclockwise"
          disabled={none}
          onClick={() => void rotatePages(doc, selected, -90)}
        />
        <ToolRow
          icon={RotateCw}
          label="Rotate clockwise"
          shortcut={displayShortcut('Mod+Shift+R')}
          disabled={none}
          onClick={() => void rotatePages(doc, selected, 90)}
        />
        <ToolRow
          icon={Trash2}
          label="Delete"
          shortcut="Del"
          disabled={none || n >= pages.length}
          onClick={() => void deletePages(doc, selected)}
        />
        <ToolRow
          icon={Copy}
          label="Duplicate"
          disabled={none}
          onClick={() => void duplicatePages(doc, selected)}
        />
        <ToolRow
          icon={FileOutput}
          label="Extract…"
          description="Save pages as a new PDF"
          onClick={() => void openExtractDialog(doc, selected)}
        />
        <ToolRow
          icon={Replace}
          label="Replace…"
          description="Swap in pages from another file"
          onClick={() => void openReplaceFlow(doc, selected)}
        />
      </Section>
      <Section title="Insert">
        <ToolRow
          icon={File}
          label="From file…"
          shortcut={displayShortcut('Mod+Shift+I')}
          onClick={() => void openInsertDialog(doc, 'file', gap)}
        />
        <ToolRow
          icon={FilePlus2}
          label="Blank page…"
          onClick={() => void openInsertDialog(doc, 'blank', gap)}
        />
        <ToolRow icon={Clipboard} label="From clipboard" onClick={() => void insertFromClipboard(doc, gap)} />
        <ToolRow
          icon={FileInput}
          label="From an open document…"
          onClick={() => void openInsertDialog(doc, 'open', gap)}
        />
      </Section>
      <Section title="Document">
        <ToolRow
          icon={Scissors}
          label="Split…"
          description="Into several files"
          onClick={() => void openSplitDialog(doc)}
        />
        <ToolRow
          icon={Hash}
          label="Page labels…"
          description="Number pages i, ii, 1, 2…"
          onClick={() => void openLabelsDialog(doc, selected)}
        />
      </Section>
      <div className="fc-organize-pages-tips">
        <b>Tips</b>
        <ul>
          <li>Drag pages to reorder them. Hold {isMac ? '⌥ Option' : 'Ctrl'} to copy instead.</li>
          <li>Drop PDFs or images from your computer between pages to insert them.</li>
          <li>Shift+click selects a range; {isMac ? '⌘' : 'Ctrl'}+click adds pages.</li>
          <li>Double-click a page to open it.</li>
        </ul>
      </div>
    </>
  )
}

export function OrganizePanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame
      title="Organize pages"
      footer={
        <Button icon={X} onClick={() => openToolGroup(null)}>
          Close
        </Button>
      }
    >
      {doc ? <Body doc={doc} /> : <div className="shell-muted">Open a PDF to organize its pages.</div>}
    </ToolPanelFrame>
  )
}

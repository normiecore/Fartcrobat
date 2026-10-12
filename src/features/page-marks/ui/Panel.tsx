import {
  Crop,
  Eraser,
  FilePen,
  Hash,
  ImagePlus,
  Layers,
  PaintBucket,
  Plus,
  Scissors,
  Stamp
} from 'lucide-react'
import {
  displayShortcut,
  EmptyState,
  runCommand,
  Section,
  ToolPanelFrame,
  ToolRow,
  useApp,
  type DocumentModel,
  type Icon
} from '@renderer/sdk'
import { groupsOf, useListing } from '../store'
import { describePages, type MarkType } from '../shared'

function pagesOf(groups: { pages: number[] }[]): number[] {
  return [...new Set(groups.flatMap((g) => g.pages))].sort((a, b) => a - b)
}

function status(pages: number[], none: string): string {
  if (!pages.length) return none
  return `On ${pages.length === 1 ? 'page' : 'pages'} ${describePages(pages)}`
}

interface Entry {
  type: MarkType
  title: string
  addLabel: string
  updateLabel?: string
  removeLabel: string
  addDesc: string
  icon: Icon
  add: string
  update?: string
  remove: string
}

const ENTRIES: Entry[] = [
  {
    type: 'HeaderFooter',
    title: 'Header & footer',
    addLabel: 'Add header & footer',
    updateLabel: 'Update header & footer',
    removeLabel: 'Remove header & footer',
    addDesc: 'Page numbers, dates or text at the top and bottom of pages',
    icon: FilePen,
    add: 'marks.headerFooter.add',
    update: 'marks.headerFooter.update',
    remove: 'marks.headerFooter.remove'
  },
  {
    type: 'Watermark',
    title: 'Watermark',
    addLabel: 'Add watermark',
    updateLabel: 'Update watermark',
    removeLabel: 'Remove watermark',
    addDesc: 'Text such as “CONFIDENTIAL”, or an image, across the pages',
    icon: Stamp,
    add: 'marks.watermark.add',
    update: 'marks.watermark.update',
    remove: 'marks.watermark.remove'
  },
  {
    type: 'Background',
    title: 'Background',
    addLabel: 'Add background',
    updateLabel: 'Update background',
    removeLabel: 'Remove background',
    addDesc: 'A colour or image behind the page content',
    icon: PaintBucket,
    add: 'marks.background.add',
    update: 'marks.background.update',
    remove: 'marks.background.remove'
  },
  {
    type: 'Bates',
    title: 'Bates numbering',
    addLabel: 'Add Bates numbering',
    removeLabel: 'Remove Bates numbering',
    addDesc: 'Unique numbers on every page for legal documents',
    icon: Hash,
    add: 'marks.bates.add',
    remove: 'marks.bates.remove'
  }
]

export function PageMarksPanel({ doc }: { doc: DocumentModel | null }) {
  const listing = useListing(doc)
  const toolId = useApp((s) => s.toolId)
  return (
    <ToolPanelFrame title="Headers & watermarks">
      {!doc ? (
        <EmptyState icon={Layers} title="Open a PDF">
          Open a document to add headers, watermarks or backgrounds.
        </EmptyState>
      ) : (
        <div className="fc-page-marks-panel">
          {ENTRIES.map((e) => {
            const pages = pagesOf(groupsOf(listing, e.type))
            const has = pages.length > 0
            return (
              <Section key={e.type} title={e.title}>
                <ToolRow
                  icon={has ? Plus : e.icon}
                  label={e.addLabel}
                  description={e.addDesc}
                  onClick={() => void runCommand(e.add)}
                />
                {e.update && (
                  <ToolRow
                    icon={ImagePlus}
                    label={e.updateLabel}
                    description={status(pages, 'Nothing to update yet')}
                    disabled={!has}
                    onClick={() => void runCommand(e.update!)}
                  />
                )}
                <ToolRow
                  icon={Eraser}
                  label={e.removeLabel}
                  description={e.update ? undefined : status(pages, 'Nothing to remove yet')}
                  disabled={!has}
                  onClick={() => void runCommand(e.remove)}
                />
              </Section>
            )
          })}
          <Section title="Crop">
            <ToolRow
              icon={Crop}
              label="Crop pages"
              description="Drag a rectangle on a page"
              active={toolId === 'marks.crop'}
              onClick={() => void runCommand('marks.crop')}
            />
            <ToolRow
              icon={Scissors}
              label="Set page boxes…"
              description="Margins, white margins, trim and bleed"
              shortcut={displayShortcut('Mod+Shift+T')}
              onClick={() => void runCommand('marks.setPageBoxes')}
            />
            <ToolRow
              icon={Eraser}
              label="Remove crop"
              description={status(listing.croppedPages, 'No pages are cropped')}
              disabled={!listing.croppedPages.length}
              onClick={() => void runCommand('marks.removeCrop')}
            />
          </Section>
        </div>
      )}
    </ToolPanelFrame>
  )
}

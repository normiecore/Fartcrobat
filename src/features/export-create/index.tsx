import { ClipboardPaste, FileCode2, FileOutput, FilePlus2, FileSpreadsheet, FileText, FileType, Image, Images, Presentation, FilePlus } from 'lucide-react'
import { defineFeature, openToolGroup, type CommandContext, type CommandDefinition, type MenuContribution } from '@renderer/sdk'
import { convertHtml, convertOffice, createFromClipboard, createFromFileDialog, createFromHtmlDialog, createFromImagesDialog } from './createFlow'
import { CreateHost } from './CreateHost'
import { CreatePanel, CreateView } from './CreateView'
import { exportDocument } from './exportFlow'
import { ExportPanel } from './ExportPanel'
import { ConvertSettings } from './Settings'
import { FEATURE_ID, HTML_EXTENSIONS, OFFICE_EXTENSIONS, type ExportFormat } from './shared'
import { getState, loadSettings, setOptions, setState } from './state'
import './export-create.css'

const doc = (ctx: CommandContext) => ctx.doc!

function exportCommand(id: string, format: ExportFormat, label: string, icon: CommandDefinition['icon'], keywords: string[]): CommandDefinition {
  return {
    id,
    label,
    icon,
    keywords: ['export', 'save as', 'convert', ...keywords],
    run: async (ctx) => {
      await loadSettings()
      // The format becomes the one shown in Export a PDF too.
      if (getState().options.format !== format) setOptions({ format })
      await exportDocument(doc(ctx), format, { pages: Array.from({ length: doc(ctx).pageCount }, (_, i) => i) })
    }
  }
}

const commands: CommandDefinition[] = [
  {
    id: 'export.open',
    label: 'Export a PDF',
    icon: FileOutput,
    keywords: ['export', 'convert', 'save as', 'word', 'excel', 'powerpoint', 'image', 'html', 'text'],
    run: () => openToolGroup('export')
  },
  exportCommand('export.word', 'word', 'Microsoft Word Document…', FileText, ['word', 'docx', 'doc', 'editable']),
  exportCommand('export.excel', 'excel', 'Spreadsheet (Excel Workbook)…', FileSpreadsheet, ['excel', 'xlsx', 'table', 'spreadsheet']),
  exportCommand('export.powerpoint', 'powerpoint', 'Microsoft PowerPoint Presentation…', Presentation, ['powerpoint', 'pptx', 'slides']),
  exportCommand('export.image', 'image', 'Image…', Image, ['png', 'jpeg', 'jpg', 'tiff', 'picture']),
  exportCommand('export.html', 'html', 'HTML Web Page…', FileCode2, ['html', 'web page', 'website']),
  exportCommand('export.text', 'text', 'Text (Plain)…', FileType, ['txt', 'plain text']),
  {
    id: 'create.open',
    label: 'Create a PDF',
    icon: FilePlus,
    requiresDocument: false,
    keywords: ['create', 'new', 'convert to pdf', 'make pdf'],
    run: () => openToolGroup('create')
  },
  {
    id: 'create.fromFile',
    label: 'PDF from File…',
    icon: FilePlus,
    shortcut: 'Mod+N',
    requiresDocument: false,
    keywords: ['create', 'new pdf', 'convert to pdf', 'word to pdf', 'excel to pdf', 'image to pdf', 'combine'],
    run: () => createFromFileDialog()
  },
  {
    id: 'create.fromClipboard',
    label: 'PDF from Clipboard',
    icon: ClipboardPaste,
    requiresDocument: false,
    keywords: ['create', 'paste', 'screenshot', 'new pdf'],
    run: async () => {
      await createFromClipboard()
    }
  },
  {
    id: 'create.blank',
    label: 'Blank Page…',
    icon: FilePlus2,
    requiresDocument: false,
    keywords: ['create', 'new', 'empty', 'blank pdf', 'new document'],
    run: async () => {
      await loadSettings()
      setState({ source: 'blank' })
      openToolGroup('create')
    }
  },
  {
    id: 'create.fromImages',
    label: 'PDF from Images…',
    icon: Images,
    requiresDocument: false,
    keywords: ['create', 'jpg to pdf', 'png to pdf', 'scan', 'photos'],
    run: () => createFromImagesDialog()
  },
  {
    id: 'create.fromHtml',
    label: 'PDF from HTML File…',
    icon: FileCode2,
    requiresDocument: false,
    keywords: ['create', 'web page', 'html to pdf', 'website'],
    run: () => createFromHtmlDialog()
  }
]

const menus: MenuContribution[] = [
  ...['create.fromFile', 'create.fromClipboard', 'create.blank', 'create.fromImages', 'create.fromHtml'].map(
    (command, i): MenuContribution => ({ menu: 'file', group: 'create', command, order: 20 + i, submenu: 'Create' })
  ),
  ...['export.word', 'export.excel', 'export.powerpoint', 'export.image', 'export.html', 'export.text'].map(
    (command, i): MenuContribution => ({ menu: 'file', group: 'export', command, order: 500 + i, submenu: 'Export To' })
  ),
  { menu: 'tools', group: 'convert', command: 'create.open', order: 10 },
  { menu: 'tools', group: 'convert', command: 'export.open', order: 11 }
]

export default defineFeature({
  id: FEATURE_ID,
  commands,
  menus,
  toolGroups: [
    {
      id: 'export',
      label: 'Export a PDF',
      icon: FileOutput,
      color: '#0d66d0',
      description: 'Convert to Word, Excel, PowerPoint, images, HTML or text',
      order: 10,
      category: 'convert',
      homeTile: true,
      panel: ExportPanel,
      keywords: ['export', 'convert', 'save as', 'word', 'excel', 'powerpoint', 'jpg', 'png', 'html', 'text']
    },
    {
      id: 'create',
      label: 'Create a PDF',
      icon: FilePlus,
      color: '#d7373f',
      description: 'From Office files, images, web pages, the clipboard or blank pages',
      order: 30,
      category: 'create',
      homeTile: true,
      requiresDocument: false,
      panel: CreatePanel,
      documentView: CreateView,
      keywords: ['create', 'new', 'convert to pdf', 'word to pdf', 'image to pdf', 'blank page', 'clipboard']
    }
  ],
  settings: [{ id: 'convert', label: 'Convert', order: 60, component: ConvertSettings }],
  fileConverters: [
    { id: 'libreoffice', label: 'LibreOffice', extensions: OFFICE_EXTENSIONS, convert: (path) => convertOffice(path) },
    { id: 'html', label: 'Web page', extensions: HTML_EXTENSIONS, convert: (path) => convertHtml(path) }
  ],
  globals: [CreateHost]
})

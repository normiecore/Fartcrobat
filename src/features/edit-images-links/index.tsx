import { useEffect } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Crop,
  Download,
  TrianglesCenterlineDashedVertical,
  TrianglesCenterlineDashedHorizontal,
  ImagePlus,
  Link2,
  Link2Off,
  Replace,
  RotateCcw,
  RotateCw,
  Ruler,
  Trash2,
  Wand2
} from 'lucide-react'
import {
  defineFeature,
  getActiveDoc,
  rangeRects,
  setTool,
  useApp,
  type CommandContext,
  type CommandDefinition,
  type MenuContribution
} from '@renderer/sdk'
import type { Rect } from '@shared/geometry'
import './style.css'
import {
  ADD_IMAGE_TOOL,
  EDIT_CONTENT_TOOL,
  FEATURE_ID,
  LINK_TOOL,
  selectedImage,
  selectedLink,
  useUi
} from './common'
import { ImageLayer } from './ImageLayer'
import { AddImageLayer, AddImageToolbar, activateAddImage, chooseImageToAdd, clearPending } from './AddImageTool'
import { LinkToolLayer, LinkToolbar, deleteLink } from './LinkTool'
import { LinkBordersLayer } from './LinkBordersLayer'
import { GoToViewBar, createLinksFromUrls, openLinkDialog, removeAllLinks } from './LinkDialogs'
import {
  arrangeImage,
  copyImage,
  deleteImage,
  flipImage,
  openImageProperties,
  replaceImage,
  rotateImage,
  saveImageAs,
  startCrop
} from './imageActions'
import type { PageImage } from './engine'

const hasImage = (ctx: CommandContext) => !!selectedImage(ctx.doc) && !useUi.getState().crop
const withImage = (fn: (doc: NonNullable<CommandContext['doc']>, page: number, img: PageImage) => unknown) => (ctx: CommandContext) => {
  const s = selectedImage(ctx.doc)
  if (s && ctx.doc) void fn(ctx.doc, s.page, s.data)
}

const imageCommand = (
  id: string,
  label: string,
  icon: CommandDefinition['icon'],
  fn: (doc: NonNullable<CommandContext['doc']>, page: number, img: PageImage) => unknown,
  shortcut?: string | string[]
): CommandDefinition => ({ id, label, icon, shortcut, enabled: hasImage, run: withImage(fn), keywords: ['image', 'picture', 'photo', 'edit'] })

const commands: CommandDefinition[] = [
  {
    id: 'edit.image.add',
    label: 'Add Image…',
    icon: ImagePlus,
    keywords: ['image', 'picture', 'photo', 'logo', 'insert', 'place'],
    run: async (ctx) => {
      if (useApp.getState().toolId === ADD_IMAGE_TOOL) await chooseImageToAdd(ctx.doc)
      else setTool(ADD_IMAGE_TOOL)
    }
  },
  {
    id: 'edit.link.tool',
    label: 'Add/Edit Web or Document Link',
    icon: Link2,
    keywords: ['link', 'hyperlink', 'url', 'web', 'go to page'],
    checked: () => useApp.getState().toolId === LINK_TOOL,
    run: () => setTool(LINK_TOOL)
  },
  {
    id: 'edit.autoLinks',
    label: 'Create Links from URLs…',
    icon: Wand2,
    keywords: ['link', 'hyperlink', 'url', 'web', 'automatic', 'detect', 'email'],
    run: (ctx) => createLinksFromUrls(ctx.doc!)
  },
  {
    id: 'edit.removeAllLinks',
    label: 'Remove All Links…',
    icon: Link2Off,
    keywords: ['link', 'hyperlink', 'delete', 'clear'],
    run: (ctx) => removeAllLinks(ctx.doc!)
  },
  {
    id: 'edit.deleteImage',
    label: 'Delete Image',
    icon: Trash2,
    shortcut: ['Delete', 'Backspace'],
    hidden: true,
    enabled: hasImage,
    run: withImage(deleteImage)
  },
  {
    id: 'edit.deleteLink',
    label: 'Delete Link',
    icon: Trash2,
    shortcut: ['Delete', 'Backspace'],
    hidden: true,
    enabled: (ctx) => !!selectedLink(ctx.doc),
    run: (ctx) => {
      const s = selectedLink(ctx.doc)
      if (s && ctx.doc) void deleteLink(ctx.doc, s.page, s.data)
    }
  },
  imageCommand('edit.image.rotateCW', 'Rotate Image Clockwise', RotateCw, (d, p, i) => rotateImage(d, p, i, 90)),
  imageCommand('edit.image.rotateCCW', 'Rotate Image Counterclockwise', RotateCcw, (d, p, i) => rotateImage(d, p, i, -90)),
  imageCommand('edit.image.flipH', 'Flip Image Horizontally', TrianglesCenterlineDashedVertical, (d, p, i) => flipImage(d, p, i, 'horizontal')),
  imageCommand('edit.image.flipV', 'Flip Image Vertically', TrianglesCenterlineDashedHorizontal, (d, p, i) => flipImage(d, p, i, 'vertical')),
  imageCommand('edit.image.crop', 'Crop Image', Crop, startCrop),
  imageCommand('edit.image.replace', 'Replace Image…', Replace, replaceImage),
  imageCommand('edit.image.properties', 'Image Position and Size…', Ruler, openImageProperties),
  imageCommand('edit.image.copy', 'Copy Image', ClipboardCopy, copyImage, 'Mod+C'),
  imageCommand('edit.image.saveAs', 'Save Image As…', Download, saveImageAs),
  imageCommand('edit.image.bringToFront', 'Bring to Front', ArrowUpToLine, (d, p, i) => arrangeImage(d, p, i, 'front'), ['Mod+Shift+]', 'Mod+Shift+}']),
  imageCommand('edit.image.bringForward', 'Bring Forward', ChevronUp, (d, p, i) => arrangeImage(d, p, i, 'forward'), 'Mod+]'),
  imageCommand('edit.image.sendBackward', 'Send Backward', ChevronDown, (d, p, i) => arrangeImage(d, p, i, 'backward'), 'Mod+['),
  imageCommand('edit.image.sendToBack', 'Send to Back', ArrowDownToLine, (d, p, i) => arrangeImage(d, p, i, 'back'), ['Mod+Shift+[', 'Mod+Shift+{'])
]

// Tools: next to "Edit a PDF" / "Edit Text & Images" / "Add Text" (edit-text's group), with the
// link commands in a Link submenu like Acrobat's Edit PDF > Link. Edit: an Image submenu after
// edit-text's "Edit Text & Images" and "Add Text".
const menus: MenuContribution[] = [
  { menu: 'tools', group: 'edit', command: 'edit.image.add', order: 23 },
  ...['edit.link.tool', 'edit.autoLinks', 'edit.removeAllLinks'].map((command, i) => ({
    menu: 'tools' as const,
    group: 'edit',
    command,
    order: 24 + i,
    submenu: 'Link'
  })),
  ...[
    'edit.image.rotateCW',
    'edit.image.rotateCCW',
    'edit.image.flipH',
    'edit.image.flipV',
    'edit.image.crop',
    'edit.image.replace',
    'edit.image.properties',
    'edit.image.bringToFront',
    'edit.image.bringForward',
    'edit.image.sendBackward',
    'edit.image.sendToBack',
    'edit.image.copy',
    'edit.image.saveAs',
    'edit.deleteImage'
  ].map((command, i) => ({ menu: 'edit' as const, group: 'editpdf', command, order: 410 + i, submenu: 'Image' }))
]

/** Clears image/link selections and transient modes when their tool is no longer active. */
function SelectionGuard() {
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
        if (s.toolId === prev.toolId && s.activeDocId === prev.activeDocId) return
        const doc = getActiveDoc()
        if (s.toolId !== EDIT_CONTENT_TOOL) {
          if (useUi.getState().crop) useUi.setState({ crop: null })
          if (doc && selectedImage(doc)) doc.clearSelection()
        }
        if (s.toolId !== LINK_TOOL && doc && selectedLink(doc)) doc.clearSelection()
        if (s.toolId !== ADD_IMAGE_TOOL && useUi.getState().pending) clearPending()
        if (s.activeDocId !== prev.activeDocId && useUi.getState().goToView) {
          // navigating to another document cancels "Create Go to View"
          const req = useUi.getState().goToView!
          useUi.setState({ goToView: null })
          req.onCancel()
        }
      }),
    []
  )
  return null
}

export default defineFeature({
  id: FEATURE_ID,
  commands,
  menus,
  tools: [
    {
      id: ADD_IMAGE_TOOL,
      label: 'Add image',
      icon: ImagePlus,
      cursor: 'crosshair',
      layer: AddImageLayer,
      toolbar: AddImageToolbar,
      onActivate: () => void activateAddImage(),
      onDeactivate: () => clearPending()
    },
    {
      id: LINK_TOOL,
      label: 'Add/Edit Web or Document Link',
      icon: Link2,
      cursor: 'crosshair',
      layer: LinkToolLayer,
      toolbar: LinkToolbar
    }
  ],
  pageLayers: [
    { id: 'edit-images', order: 60, component: ImageLayer, when: ({ toolId }) => toolId === EDIT_CONTENT_TOOL },
    { id: 'link-borders', order: 35, component: LinkBordersLayer, when: ({ toolId }) => toolId !== LINK_TOOL }
  ],
  textSelectionActions: [
    {
      id: 'create-link',
      label: 'Create link',
      icon: Link2,
      order: 60,
      run: async (doc, sel) => {
        const first = sel.ranges[0]
        if (!first) return
        const t = await doc.pageText(first.page)
        const rects = sel.ranges.filter((r) => r.page === first.page).flatMap((r) => rangeRects(t, r.start, r.end))
        if (!rects.length) return
        const rect: Rect = [
          Math.min(...rects.map((r) => r[0])) - 1,
          Math.min(...rects.map((r) => r[1])) - 1,
          Math.max(...rects.map((r) => r[2])) + 1,
          Math.max(...rects.map((r) => r[3])) + 1
        ]
        doc.clearSelection()
        await openLinkDialog(doc, first.page, { rect })
      }
    }
  ],
  globals: [GoToViewBar, SelectionGuard]
})


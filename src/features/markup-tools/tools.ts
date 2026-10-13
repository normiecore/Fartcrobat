import {
  Brush,
  Captions,
  Cloud,
  Ellipse,
  Eraser,
  Highlighter,
  LineSquiggle,
  MessageSquareText,
  MoveUpRight,
  Paperclip,
  Pencil,
  Pentagon,
  Replace,
  Slash,
  Spline,
  Square,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline
} from 'lucide-react'
import type { Icon } from '@renderer/sdk'

/** How a tool is used on the page. */
export type ToolKind =
  | 'textMarkup'
  | 'replaceText'
  | 'insertText'
  | 'note'
  | 'typewriter'
  | 'textbox'
  | 'callout'
  | 'attach'
  | 'pencil'
  | 'eraser'
  | 'rect'
  | 'line'
  | 'poly'
  | 'areaHighlight'

/** Toolbar controls a tool offers. */
export type StyleProp =
  | 'color'
  | 'fill'
  | 'opacity'
  | 'width'
  | 'lineStyle'
  | 'cloudy'
  | 'ends'
  | 'fontSize'
  | 'fontColor'
  | 'font'
  | 'icon'
  | 'attachIcon'
  | 'eraserSize'

export type Section = 'markup' | 'comment' | 'drawing'

export interface MarkupTool {
  /** Tool and command id (cross-feature contract). */
  id: string
  /** Short key used for stored defaults. */
  key: string
  kind: ToolKind
  /** Name in the panel, tooltips and the quick toolbar. */
  label: string
  /** Name in the Comment menu and "Find text or tools". */
  menuLabel: string
  /** Undo label of the change the tool makes. */
  undoLabel: string
  icon: Icon
  /** Acrobat's single-key shortcut (shown in the panel and tooltips). */
  shortcut?: string
  /** More shortcuts for the same tool (e.g. Acrobat's Ctrl+6 for sticky notes). */
  moreShortcuts?: string[]
  section: Section
  /** PDF annotation subtype the tool creates (for 'comments:defaults:<type>'). */
  annotType: string
  props: StyleProp[]
  /** One-line instruction shown in the tool options bar. */
  hint: string
  keywords: string[]
  /** Text markup subtype for textMarkup tools. */
  markup?: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'
  /** Shape subtype for rect / line / poly tools. */
  shape?: 'Square' | 'Circle' | 'Line' | 'Polygon' | 'PolyLine'
  /** Opens a text editor for the new comment right after it is placed. */
  edits?: boolean
}

const markupProps: StyleProp[] = ['color', 'opacity']
const shapeProps: StyleProp[] = ['color', 'fill', 'width', 'lineStyle', 'cloudy', 'opacity']
const lineProps: StyleProp[] = ['color', 'width', 'lineStyle', 'ends', 'opacity']
const textBoxProps: StyleProp[] = ['fontColor', 'fill', 'width', 'lineStyle', 'font', 'fontSize', 'opacity']

export const TOOLS: MarkupTool[] = [
  // ---- Text markup
  {
    id: 'comment.highlight',
    key: 'highlight',
    kind: 'textMarkup',
    markup: 'Highlight',
    label: 'Highlight text',
    menuLabel: 'Highlight Text',
    undoLabel: 'Add Highlight',
    icon: Highlighter,
    shortcut: 'U',
    section: 'markup',
    annotType: 'Highlight',
    props: markupProps,
    hint: 'Drag across text to highlight it. Double-click a word to highlight just that word.',
    keywords: ['marker', 'mark', 'yellow', 'annotate']
  },
  {
    id: 'comment.underline',
    key: 'underline',
    kind: 'textMarkup',
    markup: 'Underline',
    label: 'Underline text',
    menuLabel: 'Underline Text',
    undoLabel: 'Add Underline',
    icon: Underline,
    section: 'markup',
    annotType: 'Underline',
    props: markupProps,
    hint: 'Drag across text to underline it.',
    keywords: ['underline', 'mark']
  },
  {
    id: 'comment.strikeout',
    key: 'strikeout',
    kind: 'textMarkup',
    markup: 'StrikeOut',
    label: 'Strikethrough text',
    menuLabel: 'Strikethrough Text',
    undoLabel: 'Add Strikethrough',
    icon: Strikethrough,
    section: 'markup',
    annotType: 'StrikeOut',
    props: markupProps,
    hint: 'Drag across text to cross it out.',
    keywords: ['cross out', 'strike', 'delete text']
  },
  {
    id: 'comment.squiggly',
    key: 'squiggly',
    kind: 'textMarkup',
    markup: 'Squiggly',
    label: 'Squiggly underline',
    menuLabel: 'Squiggly Underline',
    undoLabel: 'Add Squiggly Underline',
    icon: LineSquiggle,
    section: 'markup',
    annotType: 'Squiggly',
    props: markupProps,
    hint: 'Drag across text to add a wavy underline.',
    keywords: ['wavy', 'squiggle', 'spelling']
  },
  {
    id: 'comment.insertText',
    key: 'insertText',
    kind: 'insertText',
    label: 'Insert text',
    menuLabel: 'Insert Text at Cursor',
    undoLabel: 'Add Inserted Text',
    icon: TextCursorInput,
    section: 'markup',
    annotType: 'Caret',
    props: markupProps,
    hint: 'Click between two characters where text should be added, then type the new text.',
    keywords: ['caret', 'insert', 'add text', 'edit suggestion'],
    edits: true
  },
  {
    id: 'comment.replaceText',
    key: 'replaceText',
    kind: 'replaceText',
    label: 'Replace text',
    menuLabel: 'Replace Text',
    undoLabel: 'Replace Text',
    icon: Replace,
    section: 'markup',
    annotType: 'StrikeOut',
    props: markupProps,
    hint: 'Drag across the text to replace, then type the new text.',
    keywords: ['replace', 'change text', 'edit suggestion', 'cross out'],
    edits: true
  },
  // ---- Comments
  {
    id: 'comment.note',
    key: 'note',
    kind: 'note',
    label: 'Add sticky note',
    menuLabel: 'Add Sticky Note',
    undoLabel: 'Add Sticky Note',
    icon: StickyNote,
    shortcut: 'S',
    moreShortcuts: ['Mod+6'],
    section: 'comment',
    annotType: 'Text',
    props: ['color', 'icon', 'opacity'],
    hint: 'Click where the note should go (or press Enter for the middle of the view), then type your comment.',
    keywords: ['note', 'comment', 'sticky', 'popup'],
    edits: true
  },
  {
    id: 'comment.typewriter',
    key: 'typewriter',
    kind: 'typewriter',
    label: 'Add text comment',
    menuLabel: 'Add Text Comment',
    undoLabel: 'Add Text Comment',
    icon: Type,
    section: 'comment',
    annotType: 'FreeText',
    props: ['fontColor', 'font', 'fontSize', 'opacity'],
    hint: 'Click anywhere on the page (or press Enter for the middle of the view) and start typing.',
    keywords: ['typewriter', 'type', 'add text', 'free text'],
    edits: true
  },
  {
    id: 'comment.textbox',
    key: 'textbox',
    kind: 'textbox',
    label: 'Add text box',
    menuLabel: 'Add Text Box',
    undoLabel: 'Add Text Box',
    icon: Captions,
    shortcut: 'X',
    section: 'comment',
    annotType: 'FreeText',
    props: textBoxProps,
    hint: 'Drag to draw a text box (or click, or press Enter, for a standard size), then type.',
    keywords: ['text box', 'free text', 'box'],
    edits: true
  },
  {
    id: 'comment.callout',
    key: 'callout',
    kind: 'callout',
    label: 'Add callout',
    menuLabel: 'Add Callout',
    undoLabel: 'Add Callout',
    icon: MessageSquareText,
    section: 'comment',
    annotType: 'FreeText',
    props: [...textBoxProps.slice(0, 4), 'ends', ...textBoxProps.slice(4)],
    hint: 'Click what the arrow should point at, then click or drag where the text box goes.',
    keywords: ['callout', 'leader', 'pointer', 'text box'],
    edits: true
  },
  {
    id: 'comment.attachFile',
    key: 'attachFile',
    kind: 'attach',
    label: 'Attach file',
    menuLabel: 'Attach File',
    undoLabel: 'Add File Attachment',
    icon: Paperclip,
    section: 'comment',
    annotType: 'FileAttachment',
    props: ['color', 'attachIcon'],
    hint: 'Click where the attachment icon should go (or press Enter for the middle of the view), then choose the file.',
    keywords: ['attach', 'attachment', 'file', 'embed', 'paperclip']
  },
  // ---- Drawing
  {
    id: 'comment.pencil',
    key: 'pencil',
    kind: 'pencil',
    label: 'Draw free form',
    menuLabel: 'Draw Free Form',
    undoLabel: 'Add Drawing',
    icon: Pencil,
    shortcut: 'D',
    section: 'drawing',
    annotType: 'Ink',
    props: ['color', 'width', 'opacity'],
    hint: 'Draw with the mouse or pen. Strokes made within 1.5 seconds become one drawing.',
    keywords: ['pencil', 'ink', 'draw', 'freehand', 'pen', 'scribble']
  },
  {
    id: 'comment.eraser',
    key: 'eraser',
    kind: 'eraser',
    label: 'Erase free form drawing',
    menuLabel: 'Erase Drawing',
    undoLabel: 'Erase Drawing',
    icon: Eraser,
    section: 'drawing',
    annotType: 'Ink',
    props: ['eraserSize'],
    hint: 'Drag over pencil drawings to erase the parts you touch.',
    keywords: ['eraser', 'erase', 'rubber', 'ink']
  },
  {
    id: 'comment.rectangle',
    key: 'rectangle',
    kind: 'rect',
    shape: 'Square',
    label: 'Draw rectangle',
    menuLabel: 'Rectangle',
    undoLabel: 'Add Rectangle',
    icon: Square,
    section: 'drawing',
    annotType: 'Square',
    props: shapeProps,
    hint: 'Drag to draw a rectangle. Hold Shift for a square.',
    keywords: ['rectangle', 'square', 'box', 'shape']
  },
  {
    id: 'comment.oval',
    key: 'oval',
    kind: 'rect',
    shape: 'Circle',
    label: 'Draw oval',
    menuLabel: 'Oval',
    undoLabel: 'Add Oval',
    icon: Ellipse,
    section: 'drawing',
    annotType: 'Circle',
    props: shapeProps,
    hint: 'Drag to draw an oval. Hold Shift for a circle.',
    keywords: ['oval', 'ellipse', 'circle', 'shape']
  },
  {
    id: 'comment.line',
    key: 'line',
    kind: 'line',
    shape: 'Line',
    label: 'Draw line',
    menuLabel: 'Line',
    undoLabel: 'Add Line',
    icon: Slash,
    section: 'drawing',
    annotType: 'Line',
    props: lineProps,
    hint: 'Drag to draw a line. Hold Shift to snap to 45°.',
    keywords: ['line', 'shape', 'rule']
  },
  {
    id: 'comment.arrow',
    key: 'arrow',
    kind: 'line',
    shape: 'Line',
    label: 'Draw arrow',
    menuLabel: 'Arrow',
    undoLabel: 'Add Arrow',
    icon: MoveUpRight,
    section: 'drawing',
    annotType: 'Line',
    props: lineProps,
    hint: 'Drag from the tail to the tip of the arrow. Hold Shift to snap to 45°.',
    keywords: ['arrow', 'pointer', 'shape']
  },
  {
    id: 'comment.polygon',
    key: 'polygon',
    kind: 'poly',
    shape: 'Polygon',
    label: 'Draw polygon',
    menuLabel: 'Polygon',
    undoLabel: 'Add Polygon',
    icon: Pentagon,
    section: 'drawing',
    annotType: 'Polygon',
    props: shapeProps,
    hint: 'Click to add corners. Double-click, press Enter or click the first corner to finish. Esc cancels.',
    keywords: ['polygon', 'shape', 'outline']
  },
  {
    id: 'comment.polyline',
    key: 'polyline',
    kind: 'poly',
    shape: 'PolyLine',
    label: 'Draw connected lines',
    menuLabel: 'Connected Lines',
    undoLabel: 'Add Connected Lines',
    icon: Spline,
    section: 'drawing',
    annotType: 'PolyLine',
    props: lineProps,
    hint: 'Click to add points. Double-click or press Enter to finish. Esc cancels.',
    keywords: ['polyline', 'connected lines', 'path']
  },
  {
    id: 'comment.cloud',
    key: 'cloud',
    kind: 'poly',
    shape: 'Polygon',
    label: 'Draw cloud',
    menuLabel: 'Cloud',
    undoLabel: 'Add Cloud',
    icon: Cloud,
    shortcut: 'Q',
    section: 'drawing',
    annotType: 'Polygon',
    props: ['color', 'fill', 'width', 'opacity'],
    hint: 'Click around the area to mark. Double-click, press Enter or click the first corner to finish.',
    keywords: ['cloud', 'revision cloud', 'cloudy', 'polygon']
  },
  {
    id: 'comment.areaHighlight',
    key: 'areaHighlight',
    kind: 'areaHighlight',
    label: 'Highlight area',
    menuLabel: 'Highlight Area',
    undoLabel: 'Add Area Highlight',
    icon: Brush,
    section: 'drawing',
    annotType: 'Highlight',
    props: markupProps,
    hint: 'Drag a rectangle to highlight an area, such as part of a scanned page.',
    keywords: ['area highlight', 'scanned', 'image highlight', 'rectangle highlight']
  }
]

export const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

export const SECTIONS: { id: Section; label: string; menuGroup: string; submenu?: string }[] = [
  { id: 'markup', label: 'Text markup', menuGroup: 'markup' },
  { id: 'comment', label: 'Comments', menuGroup: 'comment' },
  { id: 'drawing', label: 'Drawing', menuGroup: 'drawing', submenu: 'Drawing Markups' }
]

/** Shift+U / Shift+D / Shift+X cycle through these, like Acrobat. */
export const CYCLES: { id: string; label: string; shortcut: string; tools: string[] }[] = [
  {
    id: 'comment.cycleTextMarkup',
    label: 'Next Text Markup Tool',
    shortcut: 'Shift+U',
    tools: ['comment.highlight', 'comment.underline', 'comment.strikeout', 'comment.squiggly']
  },
  {
    id: 'comment.cycleDrawing',
    label: 'Next Drawing Tool',
    shortcut: 'Shift+D',
    // Acrobat's order
    tools: [
      'comment.cloud',
      'comment.arrow',
      'comment.line',
      'comment.rectangle',
      'comment.oval',
      'comment.polyline',
      'comment.polygon',
      'comment.pencil',
      'comment.eraser'
    ]
  },
  {
    id: 'comment.cycleTextBox',
    label: 'Next Text Box Tool',
    shortcut: 'Shift+X',
    tools: ['comment.textbox', 'comment.callout', 'comment.typewriter']
  }
]

/** Tools from other features listed in the panel's "Stamps & measure" section when registered. */
export const FOREIGN_TOOLS = ['stamps.stamp', 'measure.distance', 'measure.perimeter', 'measure.area']

/** Comment commands from the comments feature listed at the bottom of the panel when registered. */
export const FOREIGN_COMMANDS = ['comments.export', 'comments.import', 'comments.summarize', 'comments.toggleVisibility']

import { useEffect, type ComponentType } from 'react'
import {
  Bookmark,
  BookmarkPlus,
  FileSearch,
  GalleryVerticalEnd,
  Info,
  Layers,
  PanelRight,
  Paperclip,
  Pause,
  Play,
  Square,
  Volume2
} from 'lucide-react'
import {
  defineFeature,
  displayShortcut,
  showError,
  useApp,
  type CommandContext,
  type CommandDefinition,
  type DocumentModel,
  type MenuContribution
} from '@renderer/sdk'
import { scheduleMenuUpdate } from '@renderer/app/commands'
import './styles.css'
import {
  addBookmarkForCurrentView,
  rememberNavPanel,
  showPanel,
  toggleNavigationPanes,
  NAV_PANELS
} from './actions'
import { AttachmentsPanel } from './AttachmentsPanel'
import { BookmarksPanel } from './BookmarksPanel'
import { applyInitialView } from './initialView'
import { LayersPanel } from './LayersPanel'
import { openDocumentProperties } from './PropertiesDialog'
import {
  activateReadOutLoud,
  deactivateReadOutLoud,
  readAloud,
  ReadingSettings,
  ReadOutLoudBar,
  stopReading,
  togglePause,
  useReadAloud
} from './readOutLoud'
import { SearchPanel } from './SearchPanel'
import { SEARCH_FOCUS_EVENT, useBookmarkUi } from './state'
import { ThumbnailsPanel } from './ThumbnailsPanel'

const doc = (ctx: CommandContext) => ctx.doc!

/** The right rail reuses panel instances across tabs; key them by document so local state resets. */
function keyed(Panel: ComponentType<{ doc: DocumentModel }>): ComponentType<{ doc: DocumentModel }> {
  const Keyed = ({ doc: d }: { doc: DocumentModel }) => <Panel key={d.id} doc={d} />
  Keyed.displayName = `Keyed(${Panel.name})`
  return Keyed
}

function togglePanel(id: string) {
  if (useApp.getState().rightPanelId === id) useApp.setState({ rightPanelId: null })
  else showPanel(id)
}

const panelOpen = (id: string) => () => useApp.getState().rightPanelId === id

const commands: CommandDefinition[] = [
  {
    id: 'file.properties',
    label: 'Document Properties…',
    icon: Info,
    shortcut: 'Mod+D',
    keywords: [
      'metadata',
      'info',
      'title',
      'author',
      'fonts',
      'security',
      'initial view',
      'custom properties'
    ],
    run: (ctx) => openDocumentProperties(doc(ctx))
  },
  {
    id: 'nav.addBookmark',
    label: 'Add Bookmark',
    icon: BookmarkPlus,
    shortcut: 'Mod+B',
    keywords: ['new bookmark', 'outline', 'table of contents'],
    run: (ctx) => addBookmarkForCurrentView(doc(ctx))
  },
  {
    id: 'search.advanced',
    label: 'Advanced Search',
    icon: FileSearch,
    shortcut: 'Mod+Shift+F',
    keywords: ['find', 'search', 'all results', 'whole words'],
    run: () => {
      showPanel('search')
      // The panel focuses its box when it mounts; if it was already open, ask it to.
      requestAnimationFrame(() => window.dispatchEvent(new Event(SEARCH_FOCUS_EVENT)))
    }
  },

  // ---- View > Show/Hide
  {
    id: 'view.showHide.navigationPanes',
    label: 'Navigation Panes',
    icon: PanelRight,
    checked: () => (NAV_PANELS as readonly string[]).includes(useApp.getState().rightPanelId ?? ''),
    run: () => toggleNavigationPanes()
  },
  {
    id: 'view.showHide.thumbnails',
    label: 'Page Thumbnails',
    icon: GalleryVerticalEnd,
    checked: panelOpen('thumbnails'),
    run: () => togglePanel('thumbnails')
  },
  {
    id: 'view.showHide.bookmarks',
    label: 'Bookmarks',
    icon: Bookmark,
    checked: panelOpen('bookmarks'),
    run: () => togglePanel('bookmarks')
  },
  {
    id: 'view.showHide.attachments',
    label: 'Attachments',
    icon: Paperclip,
    checked: panelOpen('attachments'),
    run: () => togglePanel('attachments')
  },
  {
    id: 'view.showHide.layers',
    label: 'Layers',
    icon: Layers,
    checked: panelOpen('layers'),
    run: () => togglePanel('layers')
  },

  // ---- View > Read Out Loud
  {
    id: 'view.readOutLoud.activate',
    label: () => (useReadAloud.getState().active ? 'Deactivate Read Out Loud' : 'Activate Read Out Loud'),
    icon: Volume2,
    shortcut: 'Mod+Shift+Y',
    keywords: ['speech', 'text to speech', 'tts', 'speak', 'accessibility'],
    run: async () => {
      if (useReadAloud.getState().active) deactivateReadOutLoud()
      else await activateReadOutLoud({ hint: true })
    }
  },
  {
    id: 'view.readOutLoud.page',
    label: 'Read This Page Only',
    icon: Play,
    shortcut: 'Mod+Shift+V',
    keywords: ['speech', 'text to speech', 'speak'],
    run: (ctx) => readAloud(doc(ctx), 'page')
  },
  {
    id: 'view.readOutLoud.toEnd',
    label: 'Read To End of Document',
    shortcut: 'Mod+Shift+B',
    keywords: ['speech', 'text to speech', 'speak'],
    run: (ctx) => readAloud(doc(ctx), 'end')
  },
  {
    id: 'view.readOutLoud.pause',
    label: () => (useReadAloud.getState().status === 'paused' ? 'Resume' : 'Pause'),
    icon: Pause,
    shortcut: 'Mod+Shift+C',
    requiresDocument: false,
    enabled: () => useReadAloud.getState().status !== 'idle',
    run: () => togglePause()
  },
  {
    id: 'view.readOutLoud.stop',
    label: 'Stop',
    icon: Square,
    shortcut: 'Mod+Shift+E',
    requiresDocument: false,
    enabled: () => useReadAloud.getState().status !== 'idle',
    run: () => stopReading()
  }
]

/**
 * Menus build one submenu per (group, label), so the panes share the group of the comments
 * feature's "Show/Hide Comments" entry: everything lands in a single View > Show/Hide submenu.
 */
const SHOW_HIDE_GROUP = 'comments-showhide'

const menus: MenuContribution[] = [
  { menu: 'file', group: 'properties', command: 'file.properties', order: 700 },
  { menu: 'edit', group: 'find', command: 'search.advanced', order: 310 },
  { menu: 'document', group: 'bookmarks', command: 'nav.addBookmark', order: 600 },
  ...['navigationPanes', 'thumbnails', 'bookmarks', 'attachments', 'layers'].map(
    (id, i): MenuContribution => ({
      menu: 'view',
      group: SHOW_HIDE_GROUP,
      command: `view.showHide.${id}`,
      order: 440 + i,
      submenu: 'Show/Hide'
    })
  ),
  ...['activate', 'page', 'toEnd', 'pause', 'stop'].map((id, i): MenuContribution => ({
    menu: 'view',
    group: 'readOutLoud',
    command: `view.readOutLoud.${id}`,
    order: 600 + i,
    submenu: 'Read Out Loud'
  }))
]

/** Always mounted: the Read Out Loud status bar and the "last navigation pane" tracker. */
function NavigationGlobal() {
  useEffect(() => {
    rememberNavPanel(useApp.getState().rightPanelId)
    return useApp.subscribe((s, p) => {
      if (s.rightPanelId !== p.rightPanelId) {
        rememberNavPanel(s.rightPanelId)
        // keep the View > Show/Hide check marks in the native menu current
        scheduleMenuUpdate()
      }
      if (s.docs !== p.docs) {
        // forget the bookmark panel state of closed documents
        const open = new Set(s.docs.map((d) => d.id))
        const byDoc = useBookmarkUi.getState().byDoc
        if (Object.keys(byDoc).some((id) => !open.has(id))) {
          useBookmarkUi.setState({
            byDoc: Object.fromEntries(Object.entries(byDoc).filter(([id]) => open.has(id)))
          })
        }
      }
    })
  }, [])
  return <ReadOutLoudBar />
}

export default defineFeature({
  id: 'navigation',
  commands,
  menus,
  rightPanels: [
    {
      id: 'thumbnails',
      label: 'Page Thumbnails',
      icon: GalleryVerticalEnd,
      order: 10,
      component: keyed(ThumbnailsPanel)
    },
    { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark, order: 20, component: keyed(BookmarksPanel) },
    {
      id: 'attachments',
      label: 'Attachments',
      icon: Paperclip,
      order: 60,
      component: keyed(AttachmentsPanel)
    },
    { id: 'layers', label: 'Layers', icon: Layers, order: 70, component: keyed(LayersPanel) },
    { id: 'search', label: 'Advanced Search', icon: FileSearch, order: 80, component: keyed(SearchPanel) }
  ],
  textSelectionActions: [
    {
      id: 'navigation.addBookmark',
      label: 'Add Bookmark',
      icon: BookmarkPlus,
      order: 90,
      run: (d) => addBookmarkForCurrentView(d)
    }
  ],
  pageContextMenu: [
    {
      id: 'navigation',
      order: 90,
      items: ({ doc: d, pageIndex, point }) => [
        {
          id: 'navigation-add-bookmark',
          label: 'Add Bookmark Here',
          icon: BookmarkPlus,
          run: () =>
            void addBookmarkForCurrentView(d, {
              target: {
                page: pageIndex,
                x: null,
                y: Math.max(0, Math.round(point[1] - 24)),
                zoom: d.state.zoomMode === 'custom' ? d.state.zoom : null
              }
            })
        },
        {
          id: 'navigation-properties',
          label: 'Document Properties…',
          icon: Info,
          shortcut: displayShortcut('Mod+D'),
          run: () => openDocumentProperties(d)
        }
      ]
    }
  ],
  settings: [{ id: 'reading', label: 'Reading', order: 70, component: ReadingSettings }],
  globals: [NavigationGlobal],
  onDocumentOpen: (d) => {
    void applyInitialView(d).catch((err) => {
      if (!d.isClosed) showError(err, "Could not apply the document's initial view")
    })
  }
})

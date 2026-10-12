import type { PageLayoutMode, ZoomMode } from '@shared/types'
import { invoke, openRightPanel, registry, useApp, type DocumentModel } from '@renderer/sdk'
import { navOps } from './actions'
import type { InitialLayout, InitialView } from './types'

const LAYOUTS: Record<Exclude<InitialLayout, 'default'>, { layout: PageLayoutMode; cover: boolean }> = {
  single: { layout: 'single', cover: false },
  continuous: { layout: 'continuous', cover: false },
  'two-up': { layout: 'two-page', cover: false },
  'two-up-continuous': { layout: 'two-page-continuous', cover: false },
  'two-up-cover': { layout: 'two-page', cover: true },
  'two-up-continuous-cover': { layout: 'two-page-continuous', cover: true }
}

const PANELS: Partial<Record<InitialView['navigationTab'], string>> = {
  bookmarks: 'bookmarks',
  thumbnails: 'thumbnails',
  attachments: 'attachments',
  layers: 'layers'
}

async function waitForView(doc: DocumentModel, timeout = 4000): Promise<boolean> {
  const start = performance.now()
  while (!doc.view && !doc.isClosed && performance.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 30))
  }
  return !!doc.view
}

/** Honours the document's Initial View (Document Properties > Initial View) when it opens. */
export async function applyInitialView(doc: DocumentModel) {
  const props = await navOps(doc).properties()
  const iv = props.initialView
  const isDefault =
    iv.navigationTab === 'page' &&
    iv.pageLayout === 'default' &&
    iv.magnification === 'default' &&
    iv.openToPage === 0
  if (isDefault || doc.isClosed) return

  const panel = PANELS[iv.navigationTab]
  if (panel && registry.rightPanels.some((p) => p.id === panel) && useApp.getState().activeDocId === doc.id)
    openRightPanel(panel)

  if (iv.pageLayout !== 'default') {
    const l = LAYOUTS[iv.pageLayout]
    doc.set({ layout: l.layout, coverPage: l.cover })
  }

  // "Restore last view settings" wins over the document's initial page and zoom, like in Acrobat.
  const prefs = useApp.getState().prefs
  if (prefs.restoreLastView && doc.state.filePath) {
    const remembered = await invoke('store:get', `view:${doc.state.filePath}`).catch(() => null)
    if (remembered) return
  }
  const mag = iv.magnification
  if (mag !== 'default') {
    if (typeof mag === 'number') doc.set({ zoom: Math.max(0.08, Math.min(64, mag)), zoomMode: 'custom' })
    else {
      const mode: ZoomMode = mag === 'fit-height' ? 'fit-page' : mag
      doc.set({ zoomMode: mode })
    }
  }
  if (iv.openToPage > 0 && iv.openToPage < doc.pageCount && (await waitForView(doc))) {
    // let a fit zoom settle before scrolling to the page
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    doc.view?.goToPage(iv.openToPage, { fromHistory: true })
  }
}

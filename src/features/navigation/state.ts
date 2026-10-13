import { create } from 'zustand'
import { invoke, showError } from '@renderer/sdk'

// ---- bookmarks panel UI state, per document (survives switching panels and tabs) --------------------

export interface BookmarkUiState {
  expanded: Set<number>
  /** Expanded state was seeded from the PDF's open flags. */
  initialized: boolean
  selected: number | null
  /** Bookmark whose title is being edited inline. */
  editing: number | null
}

const emptyBookmarkUi = (): BookmarkUiState => ({
  expanded: new Set(),
  initialized: false,
  selected: null,
  editing: null
})

export const useBookmarkUi = create<{ byDoc: Record<string, BookmarkUiState> }>(() => ({ byDoc: {} }))

export function bookmarkUi(docId: string): BookmarkUiState {
  return useBookmarkUi.getState().byDoc[docId] ?? emptyBookmarkUi()
}

export function setBookmarkUi(
  docId: string,
  patch: Partial<BookmarkUiState> | ((s: BookmarkUiState) => Partial<BookmarkUiState>)
) {
  useBookmarkUi.setState((st) => {
    const cur = st.byDoc[docId] ?? emptyBookmarkUi()
    const p = typeof patch === 'function' ? patch(cur) : patch
    return { byDoc: { ...st.byDoc, [docId]: { ...cur, ...p } } }
  })
}

// ---- settings stored with invoke('store:…') ----------------------------------------------------------

export type ThumbSize = 0 | 1 | 2

export interface ReadingSettings {
  /** SpeechSynthesisVoice.voiceURI, or '' for the system default. */
  voice: string
  rate: number
  pitch: number
  volume: number
}

export const DEFAULT_READING: ReadingSettings = { voice: '', rate: 1, pitch: 1, volume: 1 }

interface NavSettings {
  loaded: boolean
  thumbSize: ThumbSize
  reading: ReadingSettings
}

export const useNavSettings = create<NavSettings>(() => ({
  loaded: false,
  thumbSize: 1,
  reading: { ...DEFAULT_READING }
}))

let loading: Promise<void> | null = null

export function loadNavSettings(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const [size, reading] = await Promise.all([
          invoke('store:get', 'navigation:thumbSize'),
          invoke('store:get', 'navigation:reading')
        ])
        useNavSettings.setState({
          thumbSize: size === 0 || size === 1 || size === 2 ? size : 1,
          reading: { ...DEFAULT_READING, ...((reading as Partial<ReadingSettings> | undefined) ?? {}) }
        })
      } catch (err) {
        showError(err, 'Could not load your navigation and reading settings')
      } finally {
        useNavSettings.setState({ loaded: true })
      }
    })()
  }
  return loading
}

export function setThumbSize(size: ThumbSize) {
  useNavSettings.setState({ thumbSize: size })
  void invoke('store:set', 'navigation:thumbSize', size).catch((err) =>
    showError(err, 'Could not save the thumbnail size')
  )
}

export function setReadingSettings(patch: Partial<ReadingSettings>) {
  const reading = { ...useNavSettings.getState().reading, ...patch }
  useNavSettings.setState({ reading })
  void invoke('store:set', 'navigation:reading', reading).catch((err) =>
    showError(err, 'Could not save reading settings')
  )
}

// ---- search panel focus request -----------------------------------------------------------------------

export const SEARCH_FOCUS_EVENT = 'fartcrobat:navigation:focus-search'

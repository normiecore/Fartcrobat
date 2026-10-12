import { useEffect, useRef, useState } from 'react'
import { Crosshair, Link2 } from 'lucide-react'
import type { Rect } from '@shared/geometry'
import {
  Button,
  ColorButton,
  Dialog,
  Field,
  NumberInput,
  Radio,
  Select,
  TextInput,
  getActiveDoc,
  invoke,
  openDialog,
  platform,
  showError,
  toast,
  useApp,
  withProgress,
  type DocumentModel,
  type PageText
} from '@renderer/sdk'
import type { LinkAction, LinkAppearance, LinkItem } from './engine'
import { LINK_TOOL, errorCode, ops, selectLink, useUi } from './common'
import { fileSpecToPath } from './filespec'

const APPEARANCE_KEY = 'edit-images-links:linkAppearance'
const DEFAULT_APPEARANCE: LinkAppearance = { visible: false, width: 1, style: 'solid', color: '#0000FF', highlight: 'invert' }
const isWindows = platform === 'win32'

async function rememberedAppearance(): Promise<LinkAppearance> {
  try {
    const v = (await invoke('store:get', APPEARANCE_KEY)) as Partial<LinkAppearance> | undefined
    return { ...DEFAULT_APPEARANCE, ...(v ?? {}) }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** Text of the characters whose centre lies inside a page rectangle. */
export function textInRect(t: PageText, r: Rect): string {
  let out = ''
  for (let i = 0; i < t.text.length; i++) {
    const c = t.text[i]
    if (c === '\n') {
      if (out && !out.endsWith(' ')) out += ' '
      continue
    }
    const k = i * 8
    const x = (t.quads[k] + t.quads[k + 2] + t.quads[k + 4] + t.quads[k + 6]) / 4
    const y = (t.quads[k + 1] + t.quads[k + 3] + t.quads[k + 5] + t.quads[k + 7]) / 4
    if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) out += c
  }
  return out.trim()
}

/** A web or e-mail address found in a piece of text, as a link target. */
export function addressIn(text: string): string | null {
  const url = /\b(?:(?:https?|ftp):\/\/|www\.)[^\s<>"]+/i.exec(text)
  if (url) {
    const u = url[0].replace(/[.,;:!?'")\]]+$/, '')
    return /^www\./i.test(u) ? `http://${u}` : u
  }
  const mail = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/.exec(text)
  return mail ? `mailto:${mail[0]}` : null
}

/** Turns what the user typed into a link target: adds https:// or mailto: when missing. */
export function normalizeAddress(v: string): string {
  const t = v.trim()
  if (!t) return ''
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(t)) return `mailto:${t}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t
  return `https://${t}`
}

type ActionKind = 'uri' | 'page' | 'file' | 'keep'

interface DialogResult {
  appearance: LinkAppearance
  action: LinkAction | null
  /** The user wants to pick the destination view by navigating ("Create Go to View"). */
  chooseView: boolean
  remove?: boolean
}

function LinkDialogBody({
  mode,
  link,
  pageCount,
  initialUri,
  appearance: initialAppearance,
  close
}: {
  mode: 'create' | 'edit'
  link: LinkItem | null
  pageCount: number
  initialUri: string
  appearance: LinkAppearance
  close: (r?: DialogResult) => void
}) {
  const a0 = link?.action
  const [ap, setAp] = useState<LinkAppearance>(initialAppearance)
  const [kind, setKind] = useState<ActionKind>(
    a0 ? (a0.type === 'uri' || a0.type === 'page' || a0.type === 'file' ? a0.type : 'keep') : initialUri ? 'uri' : 'uri'
  )
  const [uri, setUri] = useState(a0?.type === 'uri' ? a0.uri : initialUri)
  const [pageNum, setPageNum] = useState(a0?.type === 'page' ? a0.page + 1 : Math.min(pageCount, (getActiveDoc()?.state.currentPage ?? 0) + 1))
  const [file, setFile] = useState(a0?.type === 'file' ? fileSpecToPath(a0.path, isWindows) : '')
  const set = (patch: Partial<LinkAppearance>) => setAp((v) => ({ ...v, ...patch }))
  const uriRef = useRef<HTMLDivElement>(null)
  // Focus the web address (the dialog itself focuses its first field after its children mount).
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (kind === 'uri') uriRef.current?.querySelector('input')?.focus()
    }, 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const error =
    kind === 'uri' && !uri.trim()
      ? 'Enter a web address'
      : kind === 'page' && !(Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= pageCount)
        ? `Choose a page between 1 and ${pageCount}`
        : kind === 'file' && !file.trim()
          ? 'Choose a file'
          : null

  const build = (): LinkAction | null => {
    switch (kind) {
      case 'uri':
        return { type: 'uri', uri: normalizeAddress(uri) }
      case 'page': {
        // keep the original view (position and zoom) when only the page number is unchanged
        if (a0?.type === 'page' && a0.page === pageNum - 1) return a0
        return { type: 'page', page: pageNum - 1, x: null, y: null, zoom: null, fit: 'XYZ' }
      }
      case 'file':
        return { type: 'file', path: file.trim() }
      default:
        return null
    }
  }
  const submit = () => {
    if (error) return
    close({ appearance: ap, action: build(), chooseView: false })
  }
  const browse = async () => {
    const paths = await invoke('file:openDialog', { title: 'Choose the file the link opens', filters: [{ name: 'All files', extensions: ['*'] }] })
    if (paths.length) setFile(paths[0])
  }

  return (
    <Dialog
      title={mode === 'create' ? 'Create Link' : 'Link Properties'}
      onClose={() => close()}
      onSubmit={submit}
      width={520}
      className="fc-edit-images-links-dialog"
      footer={
        <>
          {mode === 'edit' && (
            <Button variant="quiet" className="fc-edit-images-links-footer-left" onClick={() => close({ appearance: ap, action: null, chooseView: false, remove: true })}>
              Delete link
            </Button>
          )}
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!!error} onClick={submit}>
            {mode === 'create' ? 'Create link' : 'Save'}
          </Button>
        </>
      }
    >
      <section className="fc-edit-images-links-section">
        <h4>Link appearance</h4>
        <div className="fc-edit-images-links-grid">
          <Field label="Link type">
            <Select<'invisible' | 'visible'>
              value={ap.visible ? 'visible' : 'invisible'}
              onChange={(v) => set({ visible: v === 'visible' })}
              aria-label="Link type"
              options={[
                { value: 'invisible', label: 'Invisible rectangle' },
                { value: 'visible', label: 'Visible rectangle' }
              ]}
            />
          </Field>
          <Field label="Highlight style">
            <Select<LinkAppearance['highlight']>
              value={ap.highlight}
              onChange={(v) => set({ highlight: v })}
              options={[
                { value: 'none', label: 'None' },
                { value: 'invert', label: 'Invert' },
                { value: 'outline', label: 'Outline' },
                { value: 'push', label: 'Inset' }
              ]}
            />
          </Field>
          {ap.visible && (
            <>
              <Field label="Line thickness">
                <Select<string>
                  value={String(ap.width >= 3 ? 3 : ap.width >= 2 ? 2 : 1)}
                  onChange={(v) => set({ width: Number(v) })}
                  options={[
                    { value: '1', label: 'Thin' },
                    { value: '2', label: 'Medium' },
                    { value: '3', label: 'Thick' }
                  ]}
                />
              </Field>
              <Field label="Line style">
                <Select<LinkAppearance['style']>
                  value={ap.style}
                  onChange={(v) => set({ style: v })}
                  options={[
                    { value: 'solid', label: 'Solid' },
                    { value: 'dashed', label: 'Dashed' },
                    { value: 'underline', label: 'Underline' }
                  ]}
                />
              </Field>
              <Field label="Color">
                <ColorButton value={ap.color} onChange={(v) => set({ color: v ?? '#000000' })} title="Link colour" />
              </Field>
            </>
          )}
        </div>
      </section>
      <section className="fc-edit-images-links-section">
        <h4>Link action</h4>
        <div className="fc-edit-images-links-actions" role="radiogroup" aria-label="Link action">
          <Radio name="fc-eil-action" checked={kind === 'uri'} onChange={() => setKind('uri')} label="Open a web page" />
          {kind === 'uri' && (
            <div className="fc-edit-images-links-indent" ref={uriRef}>
              <TextInput
                aria-label="Web address"
                placeholder="https://example.com or name@example.com"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
              />
            </div>
          )}
          <Radio name="fc-eil-action" checked={kind === 'page'} onChange={() => setKind('page')} label="Go to a page view" />
          {kind === 'page' && (
            <div className="fc-edit-images-links-indent fc-edit-images-links-row">
              <span>Page</span>
              <NumberInput value={pageNum} min={1} max={pageCount} onChange={(v) => setPageNum(Math.round(v))} aria-label="Page number" />
              <span className="fc-edit-images-links-muted">of {pageCount}</span>
              <Button
                size="sm"
                icon={Crosshair}
                title="Scroll and zoom to the exact place the link should open"
                onClick={() => close({ appearance: ap, action: null, chooseView: true })}
              >
                Choose the view…
              </Button>
            </div>
          )}
          <Radio name="fc-eil-action" checked={kind === 'file'} onChange={() => setKind('file')} label="Open a file" />
          {kind === 'file' && (
            <div className="fc-edit-images-links-indent fc-edit-images-links-row">
              <TextInput aria-label="File" placeholder="Path of the file to open" value={file} onChange={(e) => setFile(e.target.value)} />
              <Button size="sm" onClick={() => void browse()}>
                Browse…
              </Button>
            </div>
          )}
          {a0 && (a0.type === 'named' || a0.type === 'other') && (
            <Radio name="fc-eil-action" checked={kind === 'keep'} onChange={() => setKind('keep')} label={`Keep the current action (${link?.target})`} />
          )}
        </div>
        {error && kind !== 'keep' && <div className="fc-edit-images-links-hint">{error}</div>}
      </section>
    </Dialog>
  )
}

/** Opens the Create Link dialog for a new rectangle, or Link Properties for an existing link. */
export async function openLinkDialog(doc: DocumentModel, page: number, target: { rect: Rect } | { link: LinkItem }) {
  const link = 'link' in target ? target.link : null
  let initialUri = ''
  if (!link) {
    try {
      initialUri = addressIn(textInRect(await doc.pageText(page), (target as { rect: Rect }).rect)) ?? ''
    } catch {}
  }
  const appearance = link ? link.appearance : await rememberedAppearance()
  const r = await openDialog<DialogResult>((close) => (
    <LinkDialogBody
      mode={link ? 'edit' : 'create'}
      link={link}
      pageCount={doc.pageCount}
      initialUri={initialUri}
      appearance={appearance}
      close={close}
    />
  ))
  if (!r) return
  void invoke('store:set', APPEARANCE_KEY, r.appearance).catch(() => {})
  const o = ops(doc)
  if (r.remove && link) {
    try {
      await o.deleteLink(page, link.id)
      doc.clearSelection()
    } catch (err) {
      showError(err, 'Could not delete the link')
    }
    return
  }
  const save = async (action: LinkAction | null) => {
    try {
      const made = link
        ? await o.updateLink(page, link.id, { appearance: r.appearance, ...(action ? { action } : {}) })
        : await o.createLink(page, (target as { rect: Rect }).rect, { appearance: r.appearance, action: action! })
      // links are shown selected only while the link tool is active
      if (useApp.getState().toolId === LINK_TOOL) selectLink(doc, page, made)
      return made
    } catch (err) {
      showError(err, link ? 'Could not change the link' : 'Could not create the link')
      return null
    }
  }
  if (r.chooseView) {
    useUi.setState({
      goToView: {
        docId: doc.id,
        onSet: async (d) => {
          await save({ type: 'page', page: d.page, x: d.x, y: d.y, zoom: d.zoom, fit: 'XYZ' })
        },
        onCancel: () => {
          if (!link) toast('The link was not created.')
        }
      }
    })
    return
  }
  if (!link && !r.action) return
  await save(r.action)
}

/** The current view of a document as a link destination (page, top-left point, zoom). */
export function currentView(doc: DocumentModel): { page: number; x: number; y: number; zoom: number } {
  const page = doc.state.currentPage
  const zoom = Math.round(doc.state.zoom * 100)
  const vp = doc.view?.getViewportElement()
  if (vp && doc.view) {
    const b = vp.getBoundingClientRect()
    const hit = doc.view.hitTest(b.left + 2, b.top + 2)
    if (hit && hit.pageIndex === page) return { page, x: Math.max(0, hit.point[0]), y: Math.max(0, hit.point[1]), zoom }
  }
  return { page, x: 0, y: 0, zoom }
}

/** Acrobat's "Create Go to View": a floating bar shown while the user navigates to the target. */
export function GoToViewBar() {
  const req = useUi((s) => s.goToView)
  const activeId = useApp((s) => s.activeDocId)
  if (!req || req.docId !== activeId) return null
  const finish = (set: boolean) => {
    const doc = getActiveDoc()
    useUi.setState({ goToView: null })
    if (set && doc) void req.onSet(currentView(doc))
    else req.onCancel()
  }
  return (
    <div className="fc-edit-images-links-gotoview" role="dialog" aria-label="Create Go to View">
      <Link2 size={18} />
      <div>
        <b>Create Go to View</b>
        <div className="fc-edit-images-links-muted">Scroll and zoom to the place the link should open, then click Set Link.</div>
      </div>
      <Button variant="primary" onClick={() => finish(true)}>
        Set Link
      </Button>
      <Button onClick={() => finish(false)}>Cancel</Button>
    </div>
  )
}

// ---- Create links from URLs / Remove all links -------------------------------------------

type RangeKind = 'all' | 'current' | 'range'

function RangeDialog({
  title,
  intro,
  okLabel,
  danger,
  pageCount,
  currentPage,
  close
}: {
  title: string
  intro: string
  okLabel: string
  danger?: boolean
  pageCount: number
  currentPage: number
  close: (pages?: number[]) => void
}) {
  const [kind, setKind] = useState<RangeKind>('all')
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(pageCount)
  const valid = kind !== 'range' || (from >= 1 && to <= pageCount && from <= to)
  const submit = () => {
    if (!valid) return
    if (kind === 'all') close(Array.from({ length: pageCount }, (_, i) => i))
    else if (kind === 'current') close([currentPage])
    else close(Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i))
  }
  return (
    <Dialog
      title={title}
      onClose={() => close()}
      onSubmit={submit}
      width={440}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!valid} onClick={submit}>
            {okLabel}
          </Button>
        </>
      }
    >
      <p className="fc-edit-images-links-muted">{intro}</p>
      <div className="fc-edit-images-links-actions" role="radiogroup" aria-label="Pages">
        <Radio name="fc-eil-range" checked={kind === 'all'} onChange={() => setKind('all')} label="All pages" />
        <Radio name="fc-eil-range" checked={kind === 'current'} onChange={() => setKind('current')} label={`Current page (${currentPage + 1})`} />
        <Radio name="fc-eil-range" checked={kind === 'range'} onChange={() => setKind('range')} label="Pages" />
        {kind === 'range' && (
          <div className="fc-edit-images-links-indent fc-edit-images-links-row">
            <span>From</span>
            <NumberInput value={from} min={1} max={pageCount} onChange={(v) => setFrom(Math.round(v))} aria-label="From page" />
            <span>to</span>
            <NumberInput value={to} min={1} max={pageCount} onChange={(v) => setTo(Math.round(v))} aria-label="To page" />
          </div>
        )}
      </div>
    </Dialog>
  )
}

function askPages(doc: DocumentModel, title: string, intro: string, okLabel: string, danger = false) {
  return openDialog<number[]>((close) => (
    <RangeDialog
      title={title}
      intro={intro}
      okLabel={okLabel}
      danger={danger}
      pageCount={doc.pageCount}
      currentPage={doc.state.currentPage}
      close={close}
    />
  ))
}

/** Tools > Edit PDF > Create Links from URLs (Acrobat Pro). */
export async function createLinksFromUrls(doc: DocumentModel) {
  const pages = await askPages(
    doc,
    'Create Links from URLs',
    'Turns every web address (https://…, www.…) and e-mail address in the text into a clickable link. Addresses that already have a link are left alone.',
    'Create links'
  )
  if (!pages?.length) return
  try {
    const found = await withProgress('Looking for web addresses…', (report) => ops(doc, report).findUrls(pages))
    if (!found.length) {
      toast('No web addresses without links were found.')
      return
    }
    const n = await ops(doc).createLinksFromUrls(pages)
    toast(`Created ${n} ${n === 1 ? 'link' : 'links'}`, { kind: 'success' })
  } catch (err) {
    if (errorCode(err) === 'NO_CHANGE') toast((err as Error).message)
    else showError(err, 'Could not create the links')
  }
}

/** Tools > Edit PDF > Remove All Links. */
export async function removeAllLinks(doc: DocumentModel) {
  const pages = await askPages(doc, 'Remove All Links', 'Deletes every link on the chosen pages. You can undo this.', 'Remove links', true)
  if (!pages?.length) return
  try {
    const n = await ops(doc).removeAllLinks(pages)
    doc.clearSelection()
    toast(`Removed ${n} ${n === 1 ? 'link' : 'links'}`, { kind: 'success' })
  } catch (err) {
    if (errorCode(err) === 'NO_CHANGE') toast((err as Error).message)
    else showError(err, 'Could not remove the links')
  }
}

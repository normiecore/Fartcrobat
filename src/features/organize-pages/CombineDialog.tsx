import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  FilePlus2,
  FileText,
  Files,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import {
  Button,
  Checkbox,
  Dialog,
  DropdownMenu,
  EngineClient,
  EmptyState,
  IconButton,
  openDialog,
  pathForFile,
  showError,
  stripExtension,
  TextInput,
  toast,
  useApp,
  withProgress,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import type { ClientOps } from '@engine/define'
import type organizeOps from './engine'
import { openAsNewDocument } from './actions'
import { chooseFiles, loadFile, loadOpenDocument, withPassword, type LoadedFile } from './files'
import { countLabel, formatPageRange, parsePageRange } from './ranges'

type Ops = ClientOps<typeof organizeOps>

export interface CombineItem {
  id: string
  name: string
  path: string | null
  size: number
  modified: number
  pageCount: number
  status: 'loading' | 'ready'
  thumb: string | null
  /** Pages to use, as typed ("" = all pages). */
  range: string
  expanded: boolean
}

let nextId = 1

function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(t: number) {
  if (!t) return ''
  return new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "Binder1.pdf", "Binder2.pdf"... like Acrobat. */
export function binderName(titles: string[]): string {
  let max = 0
  for (const t of titles) {
    const m = /^Binder(\d+)\.pdf$/i.exec(t)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `Binder${max + 1}.pdf`
}

function pngUrl(png: Uint8Array) {
  return URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
}

/** Lazily rendered page previews of one file (click to include/exclude a page). */
function PageStrip({
  ops,
  item,
  onToggle
}: {
  ops: Ops
  item: CombineItem
  onToggle: (page: number) => void
}) {
  const [thumbs, setThumbs] = useState<(string | null)[]>([])
  const max = Math.min(item.pageCount, 300)
  useEffect(() => {
    let alive = true
    const urls: string[] = []
    void (async () => {
      for (let i = 0; i < max && alive; i++) {
        try {
          const r = await ops.scratchThumbnail(item.id, i, 96)
          if (!alive) return
          const url = pngUrl(r.png)
          urls.push(url)
          setThumbs((t) => {
            const next = [...t]
            next[i] = url
            return next
          })
        } catch {
          return
        }
      }
    })()
    return () => {
      alive = false
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [ops, item.id, max])
  const parsed = item.range.trim() ? parsePageRange(item.range, item.pageCount) : null
  const included = new Set(parsed?.ok ? parsed.pages : Array.from({ length: item.pageCount }, (_, i) => i))
  return (
    <div className="fc-organize-pages-strip" role="group" aria-label={`Page previews of ${item.name}`}>
      {Array.from({ length: max }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`fc-organize-pages-strip-page ${included.has(i) ? 'is-included' : ''}`}
          aria-pressed={included.has(i)}
          title={
            included.has(i)
              ? `Page ${i + 1} is included — click to leave it out`
              : `Page ${i + 1} is left out — click to include it`
          }
          onClick={() => onToggle(i)}
        >
          {thumbs[i] ? (
            <img src={thumbs[i]!} alt="" draggable={false} />
          ) : (
            <span className="fc-organize-pages-strip-blank" />
          )}
          <span>{i + 1}</span>
        </button>
      ))}
      {item.pageCount > max && (
        <div className="shell-muted">Type a page range above to choose among all {item.pageCount} pages.</div>
      )}
    </div>
  )
}

function CombineFiles({ close }: { close: () => void }) {
  const [items, setItems] = useState<CombineItem[]>([])
  const [ready, setReady] = useState(false)
  const [bookmarks, setBookmarks] = useState(true)
  const [keepBookmarks, setKeepBookmarks] = useState(true)
  const [dropping, setDropping] = useState(false)
  const [dragIndex, setDragIndex] = useState<{ from: number; to: number } | null>(null)
  const engineRef = useRef<EngineClient | null>(null)
  const opsRef = useRef<Ops | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const listRef = useRef<HTMLDivElement>(null)
  const docs = useApp((s) => s.docs)

  useEffect(() => {
    const engine = new EngineClient()
    engineRef.current = engine
    opsRef.current = engine.ops<typeof organizeOps>('organize-pages')
    let alive = true
    engine
      .ready()
      .then(() => alive && setReady(true))
      .catch((err) => showError(err, 'Could not start the combine engine'))
    return () => {
      alive = false
      engine.terminate()
      for (const it of itemsRef.current) if (it.thumb) URL.revokeObjectURL(it.thumb)
    }
  }, [])

  const update = (id: string, patch: Partial<CombineItem>) =>
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)))

  const addLoaded = useCallback(async (load: () => Promise<LoadedFile>, name: string) => {
    const ops = opsRef.current
    if (!ops) return
    const id = `f${nextId++}`
    setItems((list) => [
      ...list,
      {
        id,
        name,
        path: null,
        size: 0,
        modified: 0,
        pageCount: 0,
        status: 'loading',
        thumb: null,
        range: '',
        expanded: false
      }
    ])
    try {
      const file = await load()
      const opened = await withPassword(file.name, (pw) =>
        ops.openScratch(id, file.bytes, file.engineName, pw)
      )
      if (!opened) {
        setItems((list) => list.filter((it) => it.id !== id))
        return
      }
      update(id, {
        name: file.name,
        path: file.path,
        size: file.size,
        modified: file.modified,
        pageCount: opened.result.pageCount,
        status: 'ready'
      })
      const t = await ops.scratchThumbnail(id, 0, 160)
      update(id, { thumb: pngUrl(t.png) })
    } catch (err) {
      setItems((list) => list.filter((it) => it.id !== id))
      showError(err, `Could not add ${name}`)
    }
  }, [])

  const addPaths = useCallback(
    async (paths: string[]) => {
      for (const p of paths) await addLoaded(() => loadFile(p), p.split(/[\\/]/).pop() ?? p)
    },
    [addLoaded]
  )

  const addFiles = async () => {
    const paths = await chooseFiles('Add Files to Combine', true)
    if (paths.length) await addPaths(paths)
  }

  const addOpen = (doc: DocumentModel) => void addLoaded(() => loadOpenDocument(doc), doc.state.title)

  const remove = (id: string) => {
    const it = items.find((x) => x.id === id)
    if (it?.thumb) URL.revokeObjectURL(it.thumb)
    void opsRef.current?.closeScratch(id).catch(() => {})
    setItems((list) => list.filter((x) => x.id !== id))
  }

  const clear = () => {
    for (const it of items) remove(it.id)
  }

  const move = (from: number, to: number) => {
    setItems((list) => {
      if (to < 0 || to >= list.length || from === to) return list
      const next = [...list]
      const [x] = next.splice(from, 1)
      next.splice(to, 0, x)
      return next
    })
  }

  const sortBy = (key: 'name' | 'date', dir: 1 | -1) =>
    setItems((list) =>
      [...list].sort(
        (a, b) =>
          (key === 'name'
            ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            : a.modified - b.modified) * dir
      )
    )

  const togglePage = (it: CombineItem, page: number) => {
    const parsed = it.range.trim() ? parsePageRange(it.range, it.pageCount) : null
    const set = new Set(parsed?.ok ? parsed.pages : Array.from({ length: it.pageCount }, (_, i) => i))
    if (set.has(page)) set.delete(page)
    else set.add(page)
    const pages = [...set].sort((a, b) => a - b)
    const text = pages.length === it.pageCount ? '' : formatPageRange(pages)
    update(it.id, { range: pages.length ? text : '' })
    if (!pages.length)
      toast(
        `Every page of ${it.name} was left out, so all pages are used again. Remove the file instead to leave it out.`
      )
  }

  // Row drag-and-drop reordering.
  const startRowDrag = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    const list = listRef.current
    if (!list) return
    let to = index
    setDragIndex({ from: index, to })
    const onMove = (ev: PointerEvent) => {
      const rows = [...list.querySelectorAll<HTMLElement>('[data-combine-row]')]
      to = rows.length
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect()
        if (ev.clientY < r.top + r.height / 2) {
          to = i
          break
        }
      }
      const lr = list.getBoundingClientRect()
      if (ev.clientY < lr.top + 30) list.scrollTop -= 12
      else if (ev.clientY > lr.bottom - 30) list.scrollTop += 12
      setDragIndex({ from: index, to })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragIndex(null)
      const target = to > index ? to - 1 : to
      move(index, target)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const readyItems = items.filter((it) => it.status === 'ready')
  const ranges = new Map(
    readyItems.map((it) => [it.id, it.range.trim() ? parsePageRange(it.range, it.pageCount) : null])
  )
  const badRange = readyItems.find((it) => ranges.get(it.id)?.ok === false)
  const totalPages = readyItems.reduce((n, it) => {
    const r = ranges.get(it.id)
    return n + (r ? (r.ok ? r.pages.length : 0) : it.pageCount)
  }, 0)
  const loading = items.some((it) => it.status === 'loading')
  const canCombine = ready && readyItems.length > 0 && !badRange && !loading && totalPages > 0

  const combine = async () => {
    if (!canCombine) return
    const engine = engineRef.current!
    try {
      const bytes = await withProgress('Combining files…', (report) =>
        engine.ops<typeof organizeOps>('organize-pages', { onProgress: report }).combine(
          readyItems.map((it) => {
            const r = ranges.get(it.id)
            return {
              key: it.id,
              fileName: it.name,
              pages: r?.ok ? r.pages : undefined,
              title: stripExtension(it.name)
            }
          }),
          { bookmarks, keepBookmarks }
        )
      )
      const name = binderName(useApp.getState().docs.map((d) => d.state.title))
      close()
      const doc = await openAsNewDocument(bytes, name)
      if (doc)
        toast(`Combined ${countLabel(readyItems.length, 'file', 'files')} into ${name}`, { kind: 'success' })
    } catch (err) {
      showError(err, 'Could not combine the files')
    }
  }

  const openItems: ContextMenuItem[] = docs.length
    ? [
        ...docs.map((d) => ({ id: d.id, label: d.state.title, icon: FileText, run: () => addOpen(d) })),
        ...(docs.length > 1
          ? [
              { id: 'sep', label: '', separator: true },
              { id: 'all', label: 'All open files', icon: Files, run: () => docs.forEach(addOpen) }
            ]
          : [])
      ]
    : [{ id: 'none', label: 'No files are open', disabled: true }]

  return (
    <Dialog
      title="Combine Files"
      onClose={close}
      width={880}
      className="fc-organize-pages-combine"
      footer={
        <>
          <div className="fc-organize-pages-combine-options">
            <Checkbox checked={bookmarks} onChange={setBookmarks} label="Add a bookmark for each file" />
            <Checkbox
              checked={keepBookmarks}
              onChange={setKeepBookmarks}
              label="Keep the files' own bookmarks"
            />
          </div>
          <span className="fc-organize-pages-spacer" />
          <span className="shell-muted fc-organize-pages-combine-total">
            {readyItems.length
              ? `${countLabel(readyItems.length, 'file', 'files')} · ${countLabel(totalPages)}`
              : ''}
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!canCombine} onClick={() => void combine()}>
            Combine
          </Button>
        </>
      }
    >
      <div className="fc-organize-pages-combine-bar">
        <Button variant="primary" icon={Plus} onClick={() => void addFiles()} disabled={!ready}>
          Add files…
        </Button>
        <DropdownMenu
          items={openItems}
          trigger={(p) => (
            <Button icon={FilePlus2} {...p} disabled={!ready}>
              Add open files <ChevronDown size={14} />
            </Button>
          )}
        />
        <span className="fc-organize-pages-spacer" />
        <DropdownMenu
          align="right"
          items={[
            { id: 'name-asc', label: 'Name (A to Z)', run: () => sortBy('name', 1) },
            { id: 'name-desc', label: 'Name (Z to A)', run: () => sortBy('name', -1) },
            { id: 'date-desc', label: 'Date modified (newest first)', run: () => sortBy('date', -1) },
            { id: 'date-asc', label: 'Date modified (oldest first)', run: () => sortBy('date', 1) }
          ]}
          trigger={(p) => (
            <Button variant="quiet" icon={ArrowUpDown} {...p} disabled={items.length < 2}>
              Sort
            </Button>
          )}
        />
        <Button variant="quiet" icon={Trash2} onClick={clear} disabled={!items.length}>
          Remove all
        </Button>
      </div>
      <div
        ref={listRef}
        className={`fc-organize-pages-combine-list ${dropping ? 'is-dropping' : ''}`}
        role="list"
        aria-label="Files to combine"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
          setDropping(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDropping(false)
          const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean)
          if (paths.length) void addPaths(paths)
        }}
      >
        {items.length === 0 ? (
          <EmptyState icon={Files} title="Add the files you want to combine">
            Drop PDFs, images or Office files here, or click <b>Add files…</b>. Drag them into the order you
            want, then click <b>Combine</b>.
          </EmptyState>
        ) : (
          items.map((it, i) => {
            const r = ranges.get(it.id)
            return (
              <div
                key={it.id}
                data-combine-row
                role="listitem"
                className={`fc-organize-pages-combine-row ${dragIndex?.from === i ? 'is-dragging' : ''} ${dragIndex && dragIndex.to === i && dragIndex.from !== i ? 'is-drop-before' : ''} ${dragIndex && dragIndex.to === items.length && i === items.length - 1 ? 'is-drop-after' : ''}`}
                onKeyDown={(e) => {
                  if (!e.altKey) return
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    move(i, i - 1)
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    move(i, i + 1)
                  }
                }}
              >
                <div className="fc-organize-pages-combine-main">
                  <span
                    className="fc-organize-pages-grip"
                    title="Drag to reorder (or Alt+Up/Down)"
                    onPointerDown={(e) => startRowDrag(e, i)}
                  >
                    <GripVertical size={16} />
                  </span>
                  <span className="fc-organize-pages-combine-index">{i + 1}</span>
                  <div className="fc-organize-pages-combine-thumb">
                    {it.thumb ? (
                      <img src={it.thumb} alt="" draggable={false} />
                    ) : it.status === 'loading' ? (
                      <Loader2 size={18} className="fc-organize-pages-spin" />
                    ) : (
                      <FileText size={18} />
                    )}
                  </div>
                  <div className="fc-organize-pages-combine-info">
                    <div className="fc-organize-pages-combine-name" title={it.path ?? it.name}>
                      {it.name}
                    </div>
                    <div className="shell-muted">
                      {it.status === 'loading'
                        ? 'Opening…'
                        : [countLabel(it.pageCount), formatSize(it.size), formatDate(it.modified)]
                            .filter(Boolean)
                            .join(' · ')}
                    </div>
                  </div>
                  {it.status === 'ready' && it.pageCount > 1 && (
                    <Button
                      size="sm"
                      variant="quiet"
                      aria-expanded={it.expanded}
                      onClick={() => update(it.id, { expanded: !it.expanded })}
                      title="Choose which pages to use"
                    >
                      {r?.ok ? `Pages ${it.range.trim()}` : `All ${countLabel(it.pageCount)}`}{' '}
                      {it.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </Button>
                  )}
                  <IconButton
                    icon={ChevronUp}
                    size={16}
                    label={`Move ${it.name} up`}
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                  />
                  <IconButton
                    icon={ChevronDown}
                    size={16}
                    label={`Move ${it.name} down`}
                    disabled={i === items.length - 1}
                    onClick={() => move(i, i + 1)}
                  />
                  <IconButton icon={X} size={16} label={`Remove ${it.name}`} onClick={() => remove(it.id)} />
                </div>
                {it.expanded && it.status === 'ready' && it.pageCount > 1 && opsRef.current && (
                  <div className="fc-organize-pages-combine-pages">
                    <div className="fc-organize-pages-range-row">
                      <span>Pages:</span>
                      <TextInput
                        aria-label={`Pages of ${it.name}`}
                        value={it.range}
                        placeholder={`All (1-${it.pageCount})`}
                        onChange={(e) => update(it.id, { range: e.target.value })}
                      />
                      {r && !r.ok && <span className="ui-field-error">{r.error}</span>}
                      {it.range && (
                        <Button size="sm" variant="quiet" onClick={() => update(it.id, { range: '' })}>
                          Use all pages
                        </Button>
                      )}
                    </div>
                    <PageStrip ops={opsRef.current} item={it} onToggle={(p) => togglePage(it, p)} />
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </Dialog>
  )
}

/** Tools > Combine Files (works without an open document). */
export async function openCombineDialog(): Promise<void> {
  await openDialog((close) => <CombineFiles close={() => close()} />)
}

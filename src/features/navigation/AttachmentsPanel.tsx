import { useCallback, useEffect, useState } from 'react'
import {
  Download,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import {
  ask,
  basename,
  Button,
  EmptyState,
  IconButton,
  invoke,
  pathForFile,
  prompt,
  readFile,
  saveBytesAs,
  showContextMenu,
  showError,
  toast,
  useDocState,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import { annotOps, navOps, showPage, undoToast } from './actions'
import type { AttachmentList } from './types'
import { formatBytes, formatDate, mimeTypeFor } from './util'

/** File types that could run code: never opened straight from a PDF (Acrobat blocks them too). */
const BLOCKED = new Set([
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'msp',
  'scr',
  'pif',
  'cpl',
  'dll',
  'js',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'sh',
  'bash',
  'zsh',
  'command',
  'app',
  'jar',
  'lnk',
  'reg',
  'hta',
  'appimage',
  'deb',
  'rpm',
  'run',
  'py',
  'pl',
  'rb',
  'url',
  'desktop',
  'iso',
  'dmg',
  'pkg',
  'scpt',
  'workflow',
  'docm',
  'xlsm',
  'pptm'
])

type Selected =
  | { kind: 'file'; key: string }
  | { kind: 'annot'; id: number; page: number; rect: [number, number, number, number] | null }
  | null

function iconFor(name: string) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg'].includes(ext)) return FileImage
  if (['csv', 'xls', 'xlsx', 'ods'].includes(ext)) return FileSpreadsheet
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'html', 'htm', 'xml', 'json'].includes(ext))
    return FileText
  return FileIcon
}

function extensionOf(name: string) {
  return (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()
}

export function AttachmentsPanel({ doc }: { doc: DocumentModel }) {
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const [list, setList] = useState<AttachmentList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selected>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    let alive = true
    navOps(doc)
      .attachments()
      .then((l) => {
        if (!alive) return
        setList(l)
        setError(null)
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [doc, docVersion])

  // Forget a selection whose file is gone (deleted, undone, or its page removed).
  useEffect(() => {
    if (!list) return
    setSelected((sel) => {
      if (!sel) return sel
      if (sel.kind === 'file') return list.files.some((f) => f.key === sel.key) ? sel : null
      // a comment keeps its id when its page moves; follow it
      const a = list.annotations.find((x) => x.id === sel.id)
      if (!a) return null
      return a.page === sel.page && String(a.rect) === String(sel.rect)
        ? sel
        : { kind: 'annot', id: a.id, page: a.page, rect: a.rect }
    })
  }, [list])

  const nameOf = useCallback(
    (sel: NonNullable<Selected>): string => {
      if (sel.kind === 'file') return list?.files.find((f) => f.key === sel.key)?.fileName ?? sel.key
      return list?.annotations.find((a) => a.id === sel.id)?.fileName ?? 'attachment'
    },
    [list]
  )

  const dataOf = (sel: NonNullable<Selected>): Promise<Uint8Array> =>
    sel.kind === 'file'
      ? navOps(doc).attachmentData(sel.key)
      : navOps(doc).annotationFileData(sel.page, sel.id)

  const open = async (sel: NonNullable<Selected>) => {
    const name = nameOf(sel)
    if (BLOCKED.has(extensionOf(name))) {
      toast(`For your safety, “${name}” can't be opened from the PDF. Use Save As to keep a copy.`, {
        kind: 'warning',
        timeout: 7000
      })
      return
    }
    const answer = await ask({
      title: 'Open attachment',
      message: (
        <>
          Open <b>{name}</b> with its default app? Only open attachments from people you trust.
        </>
      ),
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'open', label: 'Open', variant: 'primary' }
      ]
    })
    if (answer !== 'open') return
    try {
      const bytes = await dataOf(sel)
      const path = await invoke('file:tempPath', name)
      await invoke('file:write', path, bytes)
      const failure = await invoke('shell:openPath', path)
      if (failure) showError(failure, `Could not open ${name}`)
    } catch (err) {
      showError(err, `Could not open ${name}`)
    }
  }

  const saveAs = async (sel: NonNullable<Selected>) => {
    const name = nameOf(sel)
    try {
      const bytes = await dataOf(sel)
      const ext = extensionOf(name)
      const filters = [
        ...(ext ? [{ name: `${ext.toUpperCase()} files`, extensions: [ext] }] : []),
        { name: 'All files', extensions: ['*'] }
      ]
      const path = await saveBytesAs(bytes, name, filters, 'Save Attachment')
      if (path) toast(`Saved ${basename(path)}`, { kind: 'success' })
    } catch (err) {
      showError(err, `Could not save ${name}`)
    }
  }

  const attachPaths = async (paths: string[]) => {
    const added: string[] = []
    for (const path of paths) {
      const name = basename(path)
      try {
        const [bytes, stat] = await Promise.all([readFile(path), invoke('file:stat', path).catch(() => null)])
        const key = await navOps(doc).addAttachment(name, bytes, {
          mimeType: mimeTypeFor(name),
          modified: stat ? new Date(stat.mtimeMs).toISOString() : undefined
        })
        added.push(key)
      } catch (err) {
        showError(err, `Could not attach ${name}`)
      }
    }
    if (added.length) {
      setSelected({ kind: 'file', key: added[added.length - 1] })
      undoToast(doc, added.length === 1 ? `Attached ${added[0]}` : `Attached ${added.length} files`)
    }
  }

  const addFiles = async () => {
    try {
      const paths = await invoke('file:openDialog', {
        title: 'Add Files',
        multiple: true,
        filters: [{ name: 'All files', extensions: ['*'] }]
      })
      if (paths.length) await attachPaths(paths)
    } catch (err) {
      showError(err, 'Could not add the file')
    }
  }

  const isLocked = (sel: Selected) =>
    sel?.kind === 'annot' && !!list?.annotations.find((a) => a.id === sel.id)?.locked

  const remove = async (sel: NonNullable<Selected>) => {
    const name = nameOf(sel)
    if (isLocked(sel)) {
      toast(`The comment holding ${name} is locked. Unlock it in its properties to delete it.`, {
        kind: 'warning'
      })
      return
    }
    try {
      if (sel.kind === 'file') await navOps(doc).deleteAttachment(sel.key)
      else {
        await annotOps(doc).delete([sel.id], sel.page)
        const cur = doc.state.selection
        if (cur.kind === 'annotations' && cur.ids.includes(sel.id)) doc.clearSelection()
      }
      setSelected(null)
      undoToast(doc, `Deleted ${name}`)
    } catch (err) {
      showError(err, `Could not delete ${name}`)
    }
  }

  const editDescription = async (sel: NonNullable<Selected>) => {
    if (sel.kind !== 'file') return
    const file = list?.files.find((f) => f.key === sel.key)
    if (!file) return
    const v = await prompt({
      title: 'Edit Description',
      label: `Description of ${file.fileName}`,
      initial: file.description,
      okLabel: 'Save'
    })
    if (v === null || v.trim() === file.description) return
    try {
      await navOps(doc).setAttachmentDescription(sel.key, v)
    } catch (err) {
      showError(err, 'Could not change the description')
    }
  }

  /** Scrolls to the comment holding the file and selects it, like clicking it on the page. */
  const showAnnotation = (sel: Extract<Selected, { kind: 'annot' }>) => {
    if (sel.page >= doc.pageCount) return
    doc.setSelection({ kind: 'annotations', page: sel.page, ids: [sel.id] })
    if (sel.rect && doc.view) doc.view.scrollToRect(sel.page, sel.rect, { center: true })
    else showPage(doc, sel.page)
  }

  const menuFor = (sel: NonNullable<Selected>): ContextMenuItem[] => [
    { id: 'open', label: 'Open Attachment', icon: FolderOpen, run: () => void open(sel) },
    { id: 'save', label: 'Save Attachment…', icon: Download, run: () => void saveAs(sel) },
    ...(sel.kind === 'file'
      ? [
          { id: 'desc', label: 'Edit Description…', icon: Pencil, run: () => void editDescription(sel) },
          { id: 'sep', label: '', separator: true },
          {
            id: 'delete',
            label: 'Delete Attachment',
            icon: Trash2,
            danger: true,
            run: () => void remove(sel)
          }
        ]
      : [
          { id: 'goto', label: `Show on Page ${sel.page + 1}`, run: () => showAnnotation(sel) },
          { id: 'sep', label: '', separator: true },
          {
            id: 'delete',
            label: 'Delete Comment and File',
            icon: Trash2,
            danger: true,
            disabled: isLocked(sel),
            run: () => void remove(sel)
          }
        ])
  ]

  const isSel = (s: Selected) =>
    !!selected &&
    !!s &&
    ((selected.kind === 'file' && s.kind === 'file' && selected.key === s.key) ||
      (selected.kind === 'annot' && s.kind === 'annot' && selected.id === s.id))

  const rowProps = (sel: NonNullable<Selected>) => ({
    role: 'option' as const,
    'aria-selected': isSel(sel),
    tabIndex: 0,
    className: `fc-navigation-att-row ${isSel(sel) ? 'is-selected' : ''}`,
    onClick: () => {
      setSelected(sel)
      if (sel.kind === 'annot') showAnnotation(sel)
    },
    onDoubleClick: () => void open(sel),
    onFocus: () => setSelected(sel),
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void open(sel)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        void remove(sel)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const sib =
          e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling
        if (sib instanceof HTMLElement && sib.classList.contains('fc-navigation-att-row')) sib.focus()
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        showContextMenu(r.left + 24, r.bottom - 4, menuFor(sel))
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      setSelected(sel)
      showContextMenu(e.clientX, e.clientY, menuFor(sel))
    }
  })

  const empty = list && !list.files.length && !list.annotations.length

  return (
    <div
      className={`fc-navigation-panel fc-navigation-attachments ${dropping ? 'is-drop-target' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean)
        if (paths.length) void attachPaths(paths)
      }}
    >
      <div className="fc-navigation-toolbar" role="toolbar" aria-label="Attachment actions">
        <IconButton icon={Plus} label="Add file…" onClick={() => void addFiles()} />
        <IconButton
          icon={FolderOpen}
          label="Open attachment"
          disabled={!selected}
          onClick={() => selected && void open(selected)}
        />
        <IconButton
          icon={Download}
          label="Save attachment…"
          disabled={!selected}
          onClick={() => selected && void saveAs(selected)}
        />
        <IconButton
          icon={Pencil}
          label="Edit description…"
          disabled={selected?.kind !== 'file'}
          onClick={() => selected && void editDescription(selected)}
        />
        <IconButton
          icon={Trash2}
          label="Delete attachment"
          disabled={!selected || isLocked(selected)}
          onClick={() => selected && void remove(selected)}
        />
      </div>
      {error ? (
        <EmptyState icon={Paperclip} title="Attachments could not be read">
          {error}
        </EmptyState>
      ) : !list ? (
        <div className="fc-navigation-loading">Loading attachments…</div>
      ) : empty ? (
        <EmptyState icon={Paperclip} title="No attachments">
          <p>Attach spreadsheets, images or any other file to keep them with this PDF.</p>
          <Button variant="primary" icon={Plus} onClick={() => void addFiles()}>
            Add file…
          </Button>
          <p className="fc-navigation-hint">You can also drop files here.</p>
        </EmptyState>
      ) : (
        <div className="fc-navigation-att-list" role="listbox" aria-label="Attachments">
          {list.files.map((f) => {
            const sel = { kind: 'file' as const, key: f.key }
            const Icon = iconFor(f.fileName)
            return (
              <div key={f.key} {...rowProps(sel)} data-name={f.fileName}>
                <Icon size={20} className="fc-navigation-att-icon" />
                <div className="fc-navigation-att-text">
                  <div className="fc-navigation-att-name">{f.fileName}</div>
                  <div className="fc-navigation-att-meta">
                    {formatBytes(f.size)}
                    {f.modified ? ` · ${formatDate(f.modified)}` : ''}
                  </div>
                  {f.description && <div className="fc-navigation-att-desc">{f.description}</div>}
                </div>
              </div>
            )
          })}
          {list.annotations.length > 0 && (
            <div className="fc-navigation-att-section" role="presentation">
              In comments
            </div>
          )}
          {list.annotations.map((a) => {
            const sel = { kind: 'annot' as const, id: a.id, page: a.page, rect: a.rect }
            const Icon = iconFor(a.fileName)
            return (
              <div key={`a${a.id}`} {...rowProps(sel)} data-name={a.fileName}>
                <Icon size={20} className="fc-navigation-att-icon" />
                <div className="fc-navigation-att-text">
                  <div className="fc-navigation-att-name">{a.fileName}</div>
                  <div className="fc-navigation-att-meta">
                    <MessageSquare size={11} /> Page {a.page + 1} · {formatBytes(a.size)}
                  </div>
                  {a.description && a.description !== a.fileName && (
                    <div className="fc-navigation-att-desc">{a.description}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The update notification in the bottom right corner: a new version is available, downloading,
 * ready to install, or its download failed. With a document open it sits in the corner of the
 * document area, so it never covers the page controls in the right rail or an open right panel;
 * on Home, or when side panes leave the document area too narrow for it, in the corner of the
 * window. It stays under dialogs and menus, and out of Read Mode.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowDownCircle, CheckCircle2, X } from 'lucide-react'
import type { UpdateStatus } from '@shared/updates'
import { Button, IconButton, useApp, type Icon } from '@renderer/sdk'
import { cardTitle, cardView, percentOf, progressLabel } from './format'
import { updateAction, useUpdates } from './store'

const P = 'fc-updates'

/** The card's width and its margins in the document area (updates.css). */
const CARD_SPACE = 340 + 2 * 22

export function UpdateCard() {
  const status = useUpdates((s) => s.status)
  const hasDoc = useApp((s) => s.activeDocId !== null)
  // Read Mode applies to a document (Home keeps its chrome), as in the shell.
  const readMode = useApp((s) => s.readMode) && hasDoc
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [hostTooNarrow, setHostTooNarrow] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)

  // The shell renders the document area when a document is open and Home when none is: find it
  // again when that changes (switching between documents keeps the same element).
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('.shell-viewer-wrap')
    if (el !== host) setHost(el)
  }, [host, hasDoc])

  // A small window with panes open on both sides leaves too little room for the card there.
  useLayoutEffect(() => {
    if (!host) return
    const measure = () => setHostTooNarrow(host.clientWidth < CARD_SPACE)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])

  const update = status?.update
  const view = update && !readMode ? cardView(status) : null

  // Each view has its own buttons, so the one that had the focus goes when the view changes. Read
  // before React replaces them: whether the focus was on the card.
  const lastView = useRef(view)
  const refocus = useRef(false)
  if (lastView.current !== view) {
    refocus.current = !!sectionRef.current?.contains(document.activeElement)
    lastView.current = view
  }
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    // Unless the focus went somewhere else meanwhile, it moves on to the new view's main button.
    const active = document.activeElement
    if (active && active !== document.body) return
    sectionRef.current?.querySelector<HTMLElement>('[data-focus]')?.focus()
  }, [view])

  const card = view && status && (
    <section
      ref={sectionRef}
      className={`${P}-card ${host && !hostTooNarrow ? '' : 'is-window'}`}
      role="region"
      aria-label="Update"
      data-view={view}
    >
      {view === 'available' && <Available status={status} />}
      {view === 'downloading' && <Downloading status={status} />}
      {view === 'ready' && <Ready status={status} />}
      {view === 'downloadError' && <DownloadError status={status} />}
    </section>
  )
  return (
    <>
      {/* Always in place, so screen readers announce each change of the card. */}
      <div className={`${P}-live ui-visually-hidden`} aria-live="polite" aria-atomic="true">
        {view && update ? cardTitle(view, update.version) : ''}
      </div>
      {card && (host && !hostTooNarrow ? createPortal(card, host) : card)}
    </>
  )
}

function Head({
  icon: IconC,
  tone,
  title,
  sub,
  close
}: {
  icon: Icon
  tone: string
  title: string
  sub?: ReactNode
  close?: ReactNode
}) {
  return (
    <div className={`${P}-head`}>
      <span className={`${P}-icon is-${tone}`} aria-hidden>
        <IconC size={20} />
      </span>
      <div className={`${P}-text`}>
        <div className={`${P}-title`}>{title}</div>
        {sub && <div className={`${P}-sub`}>{sub}</div>}
      </div>
      {close}
    </div>
  )
}

function CloseButton({ title }: { title?: string }) {
  return (
    <IconButton
      className={`${P}-close`}
      icon={X}
      label="Close"
      title={title ?? 'Close'}
      size={16}
      onClick={() => updateAction('feature:updates:dismiss')}
    />
  )
}

function Available({ status }: { status: UpdateStatus }) {
  const noteId = useId()
  const notify = status.capability === 'notify'
  return (
    <>
      <Head
        icon={ArrowDownCircle}
        tone="accent"
        title={cardTitle('available', status.update!.version)}
        sub={`You have ${status.currentVersion}.`}
        close={<CloseButton />}
      />
      <div className={`${P}-actions`}>
        <Button
          variant="primary"
          size="sm"
          data-focus
          aria-describedby={notify ? noteId : undefined}
          onClick={() => updateAction('feature:updates:download')}
        >
          Download
        </Button>
        <Button variant="quiet" size="sm" onClick={() => updateAction('feature:updates:openReleasePage')}>
          What&apos;s new
        </Button>
      </div>
      {notify && (
        <div id={noteId} className={`${P}-note`}>
          Opens the download page on GitHub.
        </div>
      )}
    </>
  )
}

function Downloading({ status }: { status: UpdateStatus }) {
  const version = status.update!.version
  const percent = percentOf(status.progress)
  const label = progressLabel(status.progress)
  return (
    <>
      <Head
        icon={ArrowDownCircle}
        tone="accent"
        title={cardTitle('downloading', version)}
        close={<CloseButton title="Hide. The download continues." />}
      />
      <div
        className={`${P}-bar`}
        role="progressbar"
        aria-label={`Downloading Fartcrobat ${version}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
      >
        <div className={`${P}-bar-fill`} style={{ width: `${percent}%` }} />
      </div>
      <div className={`${P}-progress`}>
        <span className={`${P}-progress-text`}>{label}</span>
        <Button size="sm" variant="quiet" data-focus onClick={() => updateAction('feature:updates:cancel')}>
          Cancel
        </Button>
      </div>
    </>
  )
}

function Ready({ status }: { status: UpdateStatus }) {
  const noteId = useId()
  return (
    <>
      <Head
        icon={CheckCircle2}
        tone="success"
        title={cardTitle('ready', status.update!.version)}
        sub="Restart Fartcrobat to finish."
      />
      <div className={`${P}-actions`}>
        <Button variant="primary" size="sm" onClick={() => updateAction('feature:updates:restart')}>
          Restart now
        </Button>
        {/* Gets the focus when the download finishes under it: harmless if Enter was meant for Cancel. */}
        <Button
          variant="quiet"
          size="sm"
          data-focus
          title="It installs the next time you quit."
          aria-describedby={noteId}
          onClick={() => updateAction('feature:updates:dismiss')}
        >
          Later
        </Button>
      </div>
      <div id={noteId} className={`${P}-note`}>
        Later: it installs the next time you quit.
      </div>
    </>
  )
}

function DownloadError({ status }: { status: UpdateStatus }) {
  const title = cardTitle('downloadError', status.update!.version)
  return (
    <>
      <Head
        icon={AlertCircle}
        tone="danger"
        title={title}
        sub={status.error && status.error !== title ? status.error : undefined}
        close={<CloseButton />}
      />
      <div className={`${P}-actions`}>
        <Button variant="primary" size="sm" data-focus onClick={() => updateAction('feature:updates:download')}>
          Try again
        </Button>
        <Button variant="quiet" size="sm" onClick={() => updateAction('feature:updates:openReleasePage')}>
          Download from GitHub
        </Button>
      </div>
    </>
  )
}

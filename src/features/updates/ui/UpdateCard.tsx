/**
 * The update notification in the bottom right corner: a new version is available, downloading,
 * ready to install, or its download failed. With a document open it sits in the corner of the
 * document area, so it never covers the page controls in the right rail or an open right panel;
 * on Home, in the corner of the window. It stays under dialogs and menus, and out of Read Mode.
 */
import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowDownCircle, CheckCircle2, X } from 'lucide-react'
import type { UpdateStatus } from '@shared/updates'
import { Button, IconButton, useApp, type Icon } from '@renderer/sdk'
import { cardView, percentOf, progressLabel } from './format'
import { updateAction, useUpdates } from './store'

const P = 'fc-updates'

export function UpdateCard() {
  const status = useUpdates((s) => s.status)
  const hasDoc = useApp((s) => s.activeDocId !== null)
  // Read Mode applies to a document (Home keeps its chrome), as in the shell.
  const readMode = useApp((s) => s.readMode) && hasDoc
  const [host, setHost] = useState<HTMLElement | null>(null)

  // The shell renders the document area when a document is open and Home when none is: find it
  // again when that changes (switching between documents keeps the same element).
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('.shell-viewer-wrap')
    if (el !== host) setHost(el)
  }, [host, hasDoc])

  const view = cardView(status)
  if (!view || !status?.update || readMode) return null
  const card = (
    <section
      className={`${P}-card ${host ? '' : 'is-window'}`}
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
  return host ? createPortal(card, host) : card
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
        {/* Announced when the flow moves on (available, downloading, ready...). */}
        <div className={`${P}-title`} aria-live="polite">
          {title}
        </div>
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
        title={`Fartcrobat ${status.update!.version} is available.`}
        sub={`You have ${status.currentVersion}.`}
        close={<CloseButton />}
      />
      <div className={`${P}-actions`}>
        <Button
          variant="primary"
          size="sm"
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
        title={`Downloading Fartcrobat ${version}…`}
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
        <Button size="sm" variant="quiet" onClick={() => updateAction('feature:updates:cancel')}>
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
        title={`Fartcrobat ${status.update!.version} is ready to install.`}
        sub="Restart Fartcrobat to finish."
      />
      <div className={`${P}-actions`}>
        <Button variant="primary" size="sm" onClick={() => updateAction('feature:updates:restart')}>
          Restart now
        </Button>
        <Button
          variant="quiet"
          size="sm"
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
  const title = `Couldn't download Fartcrobat ${status.update!.version}.`
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
        <Button variant="primary" size="sm" onClick={() => updateAction('feature:updates:download')}>
          Try again
        </Button>
        <Button variant="quiet" size="sm" onClick={() => updateAction('feature:updates:openReleasePage')}>
          Download from GitHub
        </Button>
      </div>
    </>
  )
}

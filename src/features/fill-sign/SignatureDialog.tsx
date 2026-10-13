import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eraser, ImageUp, Keyboard, PenLine } from 'lucide-react'
import { authorName, Button, Checkbox, Dialog, invoke, openDialog, readFile, showError, TextInput } from '@renderer/sdk'
import type { SignatureKind } from './shared'
import type { SignatureImage } from './state'
import { cleanSignatureImage, DrawPad, INK_COLORS, loadImage, mimeFor, renderTyped, SIGNATURE_FONTS } from './imageTools'

export interface SignatureResult {
  image: SignatureImage
  save: boolean
}

type Tab = 'type' | 'draw' | 'image'

const TABS: { id: Tab; label: string; icon: typeof Keyboard }[] = [
  { id: 'type', label: 'Type', icon: Keyboard },
  { id: 'draw', label: 'Draw', icon: PenLine },
  { id: 'image', label: 'Image', icon: ImageUp }
]

export function initialsOf(name: string): string {
  return name
    .split(/[\s\-.]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .slice(0, 4)
}

/** Opens the create-signature dialog. Resolves with the new image, or null when cancelled. */
export function openSignatureDialog(kind: SignatureKind, opts: { saveDefault?: boolean; forceSave?: boolean } = {}) {
  return openDialog<SignatureResult>((close) => (
    <SignatureDialog kind={kind} saveDefault={opts.saveDefault ?? true} forceSave={!!opts.forceSave} onDone={(r) => close(r ?? undefined)} />
  )).then((r) => r ?? null)
}

function SignatureDialog({
  kind,
  saveDefault,
  forceSave,
  onDone
}: {
  kind: SignatureKind
  saveDefault: boolean
  forceSave: boolean
  onDone: (r: SignatureResult | null) => void
}) {
  const noun = kind === 'signature' ? 'signature' : 'initials'
  const [tab, setTab] = useState<Tab>('type')
  const [name, setName] = useState(() => {
    const n = authorName()
    const usable = n && n !== 'Author' ? n : ''
    return kind === 'initials' ? initialsOf(usable) : usable
  })
  const [font, setFont] = useState<string>(SIGNATURE_FONTS[0].family)
  const [color, setColor] = useState<string>(INK_COLORS[0].value)
  const [save, setSave] = useState(saveDefault || forceSave)
  const [drawn, setDrawn] = useState(false)
  const [picked, setPicked] = useState<SignatureImage | null>(null)
  const [busy, setBusy] = useState(false)
  const padRef = useRef<DrawPad | null>(null)

  const ready = tab === 'type' ? !!name.trim() : tab === 'draw' ? drawn : !!picked

  const apply = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      let image: SignatureImage | null = null
      if (tab === 'type') image = await renderTyped(name, font, color)
      else if (tab === 'draw') image = padRef.current?.toImage() ?? null
      else image = picked
      if (!image) {
        showError(new Error(`There is nothing to use as your ${noun} yet.`))
        return
      }
      onDone({ image, save })
    } catch (err) {
      showError(err, `Could not create your ${noun}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={kind === 'signature' ? 'Add signature' : 'Add initials'}
      width={660}
      onClose={() => onDone(null)}
      onSubmit={() => void apply()}
      className="fc-fill-sign-dialog"
      footer={
        <>
          <span className="fc-fill-sign-dialog-save">
            {forceSave ? (
              <span className="shell-muted">Your {noun} will be saved on this computer.</span>
            ) : (
              <Checkbox checked={save} onChange={setSave} label={`Save ${noun}`} />
            )}
          </span>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void apply()}>
            {forceSave ? 'Save' : 'Done'}
          </Button>
        </>
      }
    >
      <div className="fc-fill-sign-tabs-row">
        <div className="fc-fill-sign-tabs" role="tablist" aria-label="How to create it">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`fc-fill-sign-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`fc-fill-sign-tabpanel-${t.id}`}
              className={tab === t.id ? 'is-active' : ''}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                e.preventDefault()
                const i = TABS.findIndex((x) => x.id === tab)
                const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
                setTab(next.id)
                document.getElementById(`fc-fill-sign-tab-${next.id}`)?.focus()
              }}
            >
              <t.icon size={16} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        {tab !== 'image' && (
          <div className="fc-fill-sign-inks" role="radiogroup" aria-label="Ink colour">
            {INK_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={color === c.value}
                title={c.label}
                aria-label={c.label}
                className={`fc-fill-sign-ink ${color === c.value ? 'is-active' : ''}`}
                style={{ background: c.value }}
                onClick={() => {
                  setColor(c.value)
                  padRef.current?.setColor(c.value)
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div id={`fc-fill-sign-tabpanel-${tab}`} role="tabpanel" aria-labelledby={`fc-fill-sign-tab-${tab}`} className="fc-fill-sign-tabpanel">
        {tab === 'type' && (
          <TypePanel kind={kind} name={name} setName={setName} font={font} setFont={setFont} color={color} />
        )}
        {tab === 'draw' && <DrawPanel color={color} padRef={padRef} onChange={setDrawn} noun={noun} />}
        {tab === 'image' && <ImagePanel picked={picked} setPicked={setPicked} noun={noun} />}
      </div>
    </Dialog>
  )
}

function TypePanel({
  kind,
  name,
  setName,
  font,
  setFont,
  color
}: {
  kind: SignatureKind
  name: string
  setName: (v: string) => void
  font: string
  setFont: (v: string) => void
  color: string
}) {
  const sample = name.trim() || (kind === 'signature' ? 'Your name' : 'YN')
  return (
    <>
      <label className="ui-field">
        <span className="ui-field-label">{kind === 'signature' ? 'Type your name' : 'Type your initials'}</span>
        <TextInput
          data-autofocus
          value={name}
          maxLength={kind === 'signature' ? 80 : 8}
          placeholder={kind === 'signature' ? 'e.g. Jane Doe' : 'e.g. JD'}
          aria-label={kind === 'signature' ? 'Your name' : 'Your initials'}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="fc-fill-sign-fonts" role="radiogroup" aria-label="Handwriting style">
        {SIGNATURE_FONTS.map((f) => (
          <button
            key={f.family}
            type="button"
            role="radio"
            aria-checked={font === f.family}
            aria-label={f.label}
            title={f.label}
            className={`fc-fill-sign-font ${font === f.family ? 'is-active' : ''} ${name.trim() ? '' : 'is-placeholder'}`}
            style={{ fontFamily: `"${f.family}", cursive`, color }}
            onClick={() => setFont(f.family)}
          >
            {sample}
          </button>
        ))}
      </div>
    </>
  )
}

function DrawPanel({
  color,
  padRef,
  onChange,
  noun
}: {
  color: string
  padRef: React.RefObject<DrawPad | null>
  onChange: (hasInk: boolean) => void
  noun: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [empty, setEmpty] = useState(true)
  const colorRef = useRef(color)
  colorRef.current = color

  useLayoutEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
    c.width = Math.round(r.width * dpr)
    c.height = Math.round(r.height * dpr)
    padRef.current = new DrawPad(c, 3.2 * dpr)
    onChange(false)
    return () => {
      padRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pos = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const
  }

  return (
    <div className="fc-fill-sign-drawwrap">
      <canvas
        ref={canvasRef}
        className="fc-fill-sign-drawpad"
        aria-label={`Drawing area: draw your ${noun} with the mouse, a pen or your finger`}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drawing.current = true
          const [x, y] = pos(e)
          padRef.current?.begin(x, y, colorRef.current)
          setEmpty(false)
          onChange(true)
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
          for (const ev of events) {
            const [x, y] = pos(ev)
            padRef.current?.extend(x, y)
          }
        }}
        onPointerUp={() => {
          drawing.current = false
          padRef.current?.end()
        }}
        onPointerCancel={() => {
          drawing.current = false
          padRef.current?.end()
        }}
      />
      <div className="fc-fill-sign-drawline" aria-hidden />
      {empty && <div className="fc-fill-sign-drawhint">Draw your {noun} here</div>}
      <Button
        size="sm"
        variant="quiet"
        icon={Eraser}
        className="fc-fill-sign-clear"
        disabled={empty}
        onClick={() => {
          padRef.current?.clear()
          setEmpty(true)
          onChange(false)
        }}
      >
        Clear
      </Button>
    </div>
  )
}

function ImagePanel({
  picked,
  setPicked,
  noun
}: {
  picked: SignatureImage | null
  setPicked: (v: SignatureImage | null) => void
  noun: string
}) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const chooseRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    chooseRef.current?.focus()
  }, [])

  const takeBytes = async (bytes: Uint8Array, name: string) => {
    setBusy(true)
    try {
      const img = await loadImage(bytes, mimeFor(name))
      const cleaned = cleanSignatureImage(img)
      if (!cleaned) throw new Error(`No ${noun} was found in this image. Use a picture with dark ink on a light background.`)
      setPicked(cleaned)
    } catch (err) {
      showError(err, 'Could not use this image')
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    try {
      const paths = await invoke('file:openDialog', {
        title: `Choose an image of your ${noun}`,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
        multiple: false
      })
      if (!paths.length) return
      await takeBytes(await readFile(paths[0]), paths[0])
    } catch (err) {
      showError(err, 'Could not open the image')
    }
  }

  return (
    <div
      className={`fc-fill-sign-drop ${over ? 'is-over' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (!file) return
        void file.arrayBuffer().then((buf) => takeBytes(new Uint8Array(buf), file.name))
      }}
    >
      {picked ? (
        <img className="fc-fill-sign-picked" src={picked.dataUrl} alt={`Your ${noun}`} />
      ) : (
        <div className="fc-fill-sign-drop-hint">
          <ImageUp size={28} />
          <div>Drag a photo or scan of your {noun} here</div>
          <div className="shell-muted">The paper background is removed automatically.</div>
        </div>
      )}
      <Button ref={chooseRef} size="sm" icon={ImageUp} disabled={busy} onClick={() => void choose()}>
        {picked ? 'Choose another image…' : 'Choose image…'}
      </Button>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Pause, Play, Square, Volume2 } from 'lucide-react'
import { create } from 'zustand'
import {
  Button,
  displayShortcut,
  Field,
  IconButton,
  Select,
  Slider,
  toast,
  useApp,
  type DocumentModel
} from '@renderer/sdk'
import { scheduleMenuUpdate } from '@renderer/app/commands'
import { loadNavSettings, setReadingSettings, useNavSettings } from './state'
import { speechChunks } from './util'

export type ReadStatus = 'idle' | 'speaking' | 'paused'

interface ReadState {
  active: boolean
  status: ReadStatus
  docId: string | null
  page: number
  pageCount: number
  mode: 'page' | 'end'
}

export const useReadAloud = create<ReadState>(() => ({
  active: false,
  status: 'idle',
  docId: null,
  page: 0,
  pageCount: 0,
  mode: 'page'
}))

useReadAloud.subscribe((s, p) => {
  if (s.active !== p.active || s.status !== p.status) scheduleMenuUpdate()
})

const NO_VOICES =
  'Read Out Loud needs a text-to-speech voice, and none is installed on this computer. On Linux, install speech-dispatcher and espeak-ng; on Windows and macOS, add a voice in the system speech settings. Then restart Fartcrobat.'

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

/** Voices, waiting briefly for the list to load (it is filled asynchronously). */
export async function loadVoices(timeout = 1500): Promise<SpeechSynthesisVoice[]> {
  const s = synth()
  if (!s) return []
  const now = s.getVoices()
  if (now.length) return now
  return new Promise((resolve) => {
    const done = () => {
      s.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(s.getVoices())
    }
    const timer = setTimeout(done, timeout)
    s.addEventListener('voiceschanged', done)
  })
}

let token = 0

function speak(text: string, voices: SpeechSynthesisVoice[], my: number): Promise<void> {
  const s = synth()!
  const settings = useNavSettings.getState().reading
  return new Promise((resolve, reject) => {
    if (my !== token) return resolve()
    const u = new SpeechSynthesisUtterance(text)
    const voice = voices.find((v) => v.voiceURI === settings.voice)
    if (voice) {
      u.voice = voice
      u.lang = voice.lang
    }
    u.rate = settings.rate
    u.pitch = settings.pitch
    u.volume = settings.volume
    u.onend = () => resolve()
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') resolve()
      else
        reject(
          new Error(
            e.error === 'synthesis-unavailable' || e.error === 'voice-unavailable'
              ? NO_VOICES
              : `Speech failed (${e.error})`
          )
        )
    }
    s.speak(u)
  })
}

/** Turns Read Out Loud on. Returns false (after telling the user) when speech is unavailable. */
export async function activateReadOutLoud(opts: { hint?: boolean } = {}): Promise<boolean> {
  if (useReadAloud.getState().active) return true
  await loadNavSettings()
  const voices = await loadVoices()
  if (!synth() || !voices.length) {
    toast(NO_VOICES, { kind: 'warning', timeout: 12000 })
    return false
  }
  useReadAloud.setState({ active: true })
  if (opts.hint)
    toast(
      `Read Out Loud is on. ${displayShortcut('Mod+Shift+V')} reads this page, ${displayShortcut('Mod+Shift+B')} reads to the end.`,
      {
        timeout: 5000
      }
    )
  return true
}

export function deactivateReadOutLoud() {
  stopReading()
  useReadAloud.setState({ active: false })
}

export function stopReading() {
  token++
  synth()?.cancel()
  useReadAloud.setState({ status: 'idle' })
}

export function togglePause() {
  const s = synth()
  const st = useReadAloud.getState()
  if (!s || st.status === 'idle') return
  if (st.status === 'paused') {
    s.resume()
    useReadAloud.setState({ status: 'speaking' })
  } else {
    s.pause()
    useReadAloud.setState({ status: 'paused' })
  }
}

/** Reads the current page, or from the current page to the end of the document. */
export async function readAloud(doc: DocumentModel, mode: 'page' | 'end') {
  if (!(await activateReadOutLoud())) return
  stopReading()
  const my = ++token
  const voices = await loadVoices()
  const start = doc.state.currentPage
  const end = mode === 'end' ? doc.pageCount : start + 1
  useReadAloud.setState({ status: 'speaking', docId: doc.id, page: start, pageCount: doc.pageCount, mode })
  let spoke = false
  try {
    for (let p = start; p < end; p++) {
      if (my !== token || doc.isClosed) return
      if (p !== start) doc.view?.goToPage(p)
      useReadAloud.setState({ page: p })
      const text = await doc.core.text.plain(p)
      const chunks = speechChunks(text)
      for (const chunk of chunks) {
        if (my !== token) return
        await speak(chunk, voices, my)
        spoke = true
      }
    }
    if (my === token && !spoke) {
      toast(
        mode === 'page'
          ? 'There is no text on this page to read. If it is a scanned page, use Scan & OCR first.'
          : 'There is no text to read from this page to the end of the document.',
        { kind: 'warning' }
      )
    }
  } catch (err) {
    if (my === token)
      toast(err instanceof Error ? err.message : String(err), { kind: 'error', timeout: 10000 })
  } finally {
    if (my === token) useReadAloud.setState({ status: 'idle' })
  }
}

/** Floating status shown while reading (Pause / Stop). */
export function ReadOutLoudBar() {
  const st = useReadAloud()
  const docs = useApp((s) => s.docs)
  // Stop when the document being read is closed.
  useEffect(() => {
    if (st.status !== 'idle' && st.docId && !docs.some((d) => d.id === st.docId)) stopReading()
  }, [docs, st.status, st.docId])
  if (st.status === 'idle') return null
  return (
    <div className="fc-navigation-readbar" role="status" aria-live="polite">
      <Volume2 size={16} className="fc-navigation-readbar-icon" />
      <span>
        {st.status === 'paused' ? 'Paused' : 'Reading'} page {st.page + 1}
        {st.mode === 'end' ? ` of ${st.pageCount}` : ''}
      </span>
      <IconButton
        icon={st.status === 'paused' ? Play : Pause}
        label={st.status === 'paused' ? 'Resume' : 'Pause'}
        shortcut={displayShortcut('Mod+Shift+C')}
        onClick={togglePause}
      />
      <IconButton
        icon={Square}
        label="Stop"
        shortcut={displayShortcut('Mod+Shift+E')}
        onClick={stopReading}
      />
    </div>
  )
}

/** Preferences > Reading. */
export function ReadingSettings() {
  const reading = useNavSettings((s) => s.reading)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null)
  useEffect(() => {
    void loadNavSettings()
    let alive = true
    void loadVoices(2000).then((v) => alive && setVoices(v))
    return () => {
      alive = false
    }
  }, [])
  const test = async () => {
    const v = voices ?? (await loadVoices())
    if (!v.length) {
      toast(NO_VOICES, { kind: 'warning', timeout: 12000 })
      return
    }
    stopReading()
    const my = ++token
    try {
      await speak('This is how Fartcrobat reads your documents out loud.', v, my)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { kind: 'error' })
    }
  }
  return (
    <div className="fc-navigation-reading-prefs">
      <h4 className="fc-navigation-props-heading">Read Out Loud</h4>
      {voices !== null && !voices.length && (
        <p className="fc-navigation-hint fc-navigation-warn">{NO_VOICES}</p>
      )}
      <Field label="Voice">
        <Select<string>
          value={reading.voice}
          onChange={(v) => setReadingSettings({ voice: v })}
          options={[
            { value: '', label: 'Default voice' },
            ...(voices ?? []).map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))
          ]}
        />
      </Field>
      <Field label="Speed">
        <Slider
          value={reading.rate}
          min={0.5}
          max={2}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => setReadingSettings({ rate: v })}
        />
      </Field>
      <Field label="Pitch">
        <Slider
          value={reading.pitch}
          min={0.5}
          max={2}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(v) => setReadingSettings({ pitch: v })}
        />
      </Field>
      <Field label="Volume">
        <Slider
          value={reading.volume}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setReadingSettings({ volume: v })}
        />
      </Field>
      <div className="fc-navigation-reading-test">
        <Button icon={Volume2} onClick={() => void test()}>
          Test voice
        </Button>
      </div>
      <p className="fc-navigation-hint">
        Use View › Read Out Loud, or {displayShortcut('Mod+Shift+V')} to read the current page and{' '}
        {displayShortcut('Mod+Shift+B')} to read to the end.
      </p>
    </div>
  )
}

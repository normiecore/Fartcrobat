import { useEffect, useState } from 'react'
import { Button, Checkbox, Field, invoke, Select, setPrefs, showError, TextInput, toast, useApp, usePrefs } from '@renderer/sdk'
import { FONT_SIZES } from './appearance'
import { DEFAULT_KINDS, TEXT_BOX_KINDS } from './shared'
import { defaultsKey, setCommentPrefs, useCommentPrefs } from './state'

/** Preferences > Commenting. */
export function CommentingSettings() {
  const prefs = usePrefs()
  const userName = useApp((s) => s.systemInfo?.userName ?? '')
  const cp = useCommentPrefs()
  const [fontSize, setFontSize] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    invoke('store:get', defaultsKey('FreeText'))
      .then((v) => {
        const size = (v as { fontSize?: number } | undefined)?.fontSize
        if (alive) setFontSize(typeof size === 'number' ? size : 12)
      })
      .catch(() => alive && setFontSize(12))
    return () => {
      alive = false
    }
  }, [])

  const saveFontSize = async (size: number) => {
    setFontSize(size)
    try {
      // text boxes, callouts and typewriter text all start at this size
      for (const kind of TEXT_BOX_KINDS) {
        const key = defaultsKey(kind)
        const prev = ((await invoke('store:get', key)) as Record<string, unknown> | undefined) ?? {}
        await invoke('store:set', key, { ...prev, fontSize: size })
      }
    } catch (err) {
      showError(err, 'Could not save the default font size')
    }
  }

  const resetDefaults = async () => {
    try {
      for (const kind of DEFAULT_KINDS) await invoke('store:set', defaultsKey(kind), undefined)
      setFontSize(12)
      toast('Comment tools are back to their standard colours and sizes.', { kind: 'success' })
    } catch (err) {
      showError(err, 'Could not reset the defaults')
    }
  }

  return (
    <div className="prefs-grid fc-comments-settings">
      <Field label="Your name (shown as the author of your comments)" hint={!prefs.authorName.trim() && userName ? `Leave empty to use “${userName}”.` : undefined}>
        <TextInput value={prefs.authorName} placeholder={userName || 'e.g. Jane Smith'} onChange={(e) => void setPrefs({ authorName: e.target.value })} />
      </Field>
      <Field label="Default font size for text boxes">
        <Select
          value={String(fontSize ?? 12)}
          disabled={fontSize === null}
          onChange={(v) => void saveFontSize(parseFloat(v))}
          options={FONT_SIZES.map((s) => ({ value: String(s), label: `${s} pt` }))}
        />
      </Field>
      <div className="prefs-checks">
        <Checkbox
          checked={cp.hoverPopups}
          onChange={(v) => void setCommentPrefs({ hoverPopups: v })}
          label="Show comment pop-ups when the pointer rests on a comment"
        />
        <Checkbox
          checked={cp.openPopupOnCreate}
          onChange={(v) => void setCommentPrefs({ openPopupOnCreate: v })}
          label="Open the pop-up note when adding a sticky note"
        />
      </div>
      <div className="fc-comments-settings-reset">
        <div>
          <b>Default appearance</b>
          <div className="shell-muted">Colours, line widths and fonts you saved with “Make Properties Default”.</div>
        </div>
        <Button onClick={() => void resetDefaults()}>Reset</Button>
      </div>
    </div>
  )
}

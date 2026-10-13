import { Button, Checkbox, ColorButton, setPrefs, usePrefs } from '@renderer/sdk'
import { DEFAULT_SETTINGS, setFormsSettings, useFormsSettings } from './settings'

/** Preferences > Forms. */
export function FormsSettingsSection() {
  const prefs = usePrefs()
  const s = useFormsSettings()
  return (
    <div className="fc-forms-fill-settings">
      <div className="prefs-checks">
        <Checkbox
          checked={prefs.highlightFormFields}
          onChange={(v) => void setPrefs({ highlightFormFields: v })}
          label="Highlight form fields (Highlight existing fields)"
        />
        <Checkbox
          checked={s.showMessageBar}
          onChange={(v) => void setFormsSettings({ showMessageBar: v })}
          label="Show the message bar when a document has form fields"
        />
        <Checkbox
          checked={s.autoCalculate}
          onChange={(v) => void setFormsSettings({ autoCalculate: v })}
          label="Automatically calculate field values"
        />
      </div>
      <div className="fc-forms-fill-settings-row">
        <ColorButton
          value={s.highlightColor}
          title="Field highlight colour"
          onChange={(v) => v && void setFormsSettings({ highlightColor: v })}
        />
        <span>Field highlight colour</span>
      </div>
      <div className="fc-forms-fill-settings-row">
        <ColorButton
          value={s.requiredColor}
          title="Required field outline colour"
          onChange={(v) => v && void setFormsSettings({ requiredColor: v })}
        />
        <span>Required fields outline colour</span>
      </div>
      <p className="fc-forms-fill-settings-note">
        Form scripts (number, date and phone formats, validation and calculations) run inside Fartcrobat with no
        access to your computer or the internet.
      </p>
      <Button
        size="sm"
        onClick={() => {
          void setFormsSettings({ ...DEFAULT_SETTINGS })
          void setPrefs({ highlightFormFields: true })
        }}
      >
        Restore defaults
      </Button>
    </div>
  )
}

import { Calculator, Download, Eraser, Highlighter, Upload } from 'lucide-react'
import { defineFeature, registry, setPrefs, showError, toast, useApp, type CommandContext } from '@renderer/sdk'
import { formController } from './controller'
import { clearForm, exportFormData, importFormData } from './dataCommands'
import { FieldLayer } from './FieldLayer'
import { FormsGlobal } from './MessageBar'
import { FormsSettingsSection } from './SettingsSection'
import './forms-fill.css'

function hasForm(ctx: CommandContext): boolean {
  const doc = ctx.doc
  if (!doc) return false
  return doc.state.info.hasForm || formController(doc).fieldsById.size > 0
}

export default defineFeature({
  id: 'forms-fill',
  pageLayers: [
    {
      id: 'form-fields',
      order: 50,
      component: FieldLayer,
      when: ({ toolId }) => toolId === 'select' || toolId.startsWith('fillsign.') || !!registry.tools.get(toolId)?.allowDefaultInteractions
    }
  ],
  commands: [
    {
      id: 'forms.highlightFields',
      label: 'Highlight Existing Fields',
      icon: Highlighter,
      requiresDocument: false,
      checked: () => useApp.getState().prefs.highlightFormFields,
      run: () => setPrefs({ highlightFormFields: !useApp.getState().prefs.highlightFormFields }),
      keywords: ['form', 'fields', 'highlight', 'show fields']
    },
    {
      id: 'forms.reset',
      label: 'Clear Form',
      icon: Eraser,
      enabled: hasForm,
      run: ({ doc }) => clearForm(doc!),
      keywords: ['reset form', 'clear fields', 'empty form']
    },
    {
      id: 'forms.exportData',
      label: 'Export Data…',
      icon: Download,
      enabled: hasForm,
      run: ({ doc }) => exportFormData(doc!),
      keywords: ['form data', 'xfdf', 'fdf', 'json', 'export form']
    },
    {
      id: 'forms.importData',
      label: 'Import Data…',
      icon: Upload,
      enabled: hasForm,
      run: ({ doc }) => importFormData(doc!),
      keywords: ['form data', 'xfdf', 'fdf', 'json', 'import form', 'fill from file']
    },
    {
      id: 'forms.calculateNow',
      label: 'Calculate Fields Now',
      icon: Calculator,
      enabled: hasForm,
      run: async ({ doc }) => {
        try {
          const n = await formController(doc!).calculateNow()
          toast(n ? `Updated ${n} calculated field${n === 1 ? '' : 's'}.` : 'All calculated fields are up to date.', { kind: 'success', timeout: 2500 })
        } catch (err) {
          showError(err, 'Could not calculate the fields')
        }
      },
      keywords: ['recalculate', 'totals', 'form']
    }
  ],
  menus: [
    { menu: 'forms', group: 'fill', command: 'forms.highlightFields', order: 100 },
    { menu: 'forms', group: 'fill', command: 'forms.calculateNow', order: 110 },
    { menu: 'forms', group: 'data', command: 'forms.importData', order: 200, submenu: 'Manage Form Data' },
    { menu: 'forms', group: 'data', command: 'forms.exportData', order: 210, submenu: 'Manage Form Data' },
    { menu: 'forms', group: 'data', command: 'forms.reset', order: 220, submenu: 'Manage Form Data' }
  ],
  settings: [{ id: 'forms', label: 'Forms', order: 40, component: FormsSettingsSection }],
  globals: [FormsGlobal],
  onDocumentOpen: (doc) => {
    formController(doc)
  }
})

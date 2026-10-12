import { Crosshair, FileSpreadsheet, ImagePlus, Pentagon, Ruler, Scale, Spline, Stamp } from 'lucide-react'
import { defineFeature, openToolGroup, setTool, useApp, type DocumentModel } from '@renderer/sdk'
import { openCustomStampDialog } from './CustomStampDialog'
import { exportMeasurementsCsv, openScaleDialog } from './MeasureControls'
import { MeasureLayer } from './MeasureLayer'
import { MeasurePanel, MeasureToolbar } from './MeasurePanel'
import { currentScale, loadMeasureSettings, measureOps, useMeasure } from './measureStore'
import { StampLayer } from './StampLayer'
import { StampPanel, StampToolbar } from './StampPanel'
import { loadStamps } from './stampStore'
import './styles.css'

/**
 * Keeps measurements correct after other tools edit them (move, resize, recolour): the engine
 * recalculates the value and redraws labels, merged into the same undo step.
 */
function watchMeasurements(doc: DocumentModel) {
  const pending = new Set<number>()
  let running = false
  const flush = async () => {
    running = true
    try {
      while (pending.size && !doc.isClosed) {
        const page = pending.values().next().value!
        pending.delete(page)
        try {
          await measureOps(doc).refreshMeasurements(page)
        } catch (err) {
          console.warn('Could not refresh measurements', err)
        }
      }
    } finally {
      running = false
    }
  }
  doc.onChange((cs) => {
    // Undo/redo restore a consistent state; never add to history while redo is possible.
    if (cs.all || cs.structure || !cs.pages.length || cs.journal.canRedo) return
    for (const p of cs.pages) pending.add(p)
    if (!running) void flush()
  })
}

const resetLive = () => useMeasure.setState({ live: null })

const measureTool = (id: string, label: string, icon: typeof Ruler) => ({
  id,
  label,
  icon,
  cursor: 'crosshair',
  layer: MeasureLayer,
  toolbar: MeasureToolbar,
  onActivate: () => {
    resetLive()
    void loadMeasureSettings()
  },
  onDeactivate: () => {
    resetLive()
    if (id === 'measure.distance') useMeasure.setState({ calibrating: false })
  }
})

export default defineFeature({
  id: 'stamps-measure',
  tools: [
    {
      id: 'stamps.stamp',
      label: 'Add stamp',
      icon: Stamp,
      shortcut: 'K',
      cursor: 'copy',
      layer: StampLayer,
      toolbar: StampToolbar,
      onActivate: () => void loadStamps()
    },
    measureTool('measure.distance', 'Measure distance', Ruler),
    measureTool('measure.perimeter', 'Measure perimeter', Spline),
    measureTool('measure.area', 'Measure area', Pentagon)
  ],
  toolGroups: [
    {
      id: 'stamp',
      label: 'Add a stamp',
      icon: Stamp,
      color: '#D9480F',
      description: 'Stamp pages with Approved, Sign Here, date stamps or your own pictures',
      order: 140,
      category: 'review',
      panel: StampPanel,
      defaultTool: 'stamps.stamp',
      keywords: ['stamp', 'approved', 'draft', 'confidential', 'sign here', 'dynamic stamp', 'custom stamp']
    },
    {
      id: 'measure',
      label: 'Measure objects',
      icon: Ruler,
      color: '#0B7285',
      description: 'Measure distances, perimeters and areas to scale',
      order: 150,
      category: 'review',
      panel: MeasurePanel,
      defaultTool: 'measure.distance',
      keywords: ['measure', 'distance', 'area', 'perimeter', 'scale', 'ruler', 'dimension']
    }
  ],
  commands: [
    {
      id: 'stamps.addStamp',
      label: 'Add Stamp',
      icon: Stamp,
      shortcut: 'K',
      keywords: ['stamp', 'approved', 'sign here'],
      run: () => setTool('stamps.stamp')
    },
    {
      id: 'stamps.showPalette',
      label: 'Show Stamps Palette',
      icon: Stamp,
      run: () => openToolGroup('stamp')
    },
    {
      id: 'stamps.createCustom',
      label: 'Create Custom Stamp…',
      icon: ImagePlus,
      requiresDocument: false,
      keywords: ['logo', 'image stamp'],
      run: async () => {
        await openCustomStampDialog()
      }
    },
    { id: 'measure.distanceTool', label: 'Distance Tool', icon: Ruler, keywords: ['measure', 'length'], run: () => setTool('measure.distance') },
    { id: 'measure.perimeterTool', label: 'Perimeter Tool', icon: Spline, keywords: ['measure'], run: () => setTool('measure.perimeter') },
    { id: 'measure.areaTool', label: 'Area Tool', icon: Pentagon, keywords: ['measure', 'square'], run: () => setTool('measure.area') },
    {
      id: 'measure.setScale',
      label: 'Set Scale Ratio…',
      icon: Scale,
      keywords: ['measure', 'scale', 'ratio'],
      run: async ({ doc }) => {
        const d = doc!
        const stored = await measureOps(d).getScale()
        await openScaleDialog(d, stored ?? currentScale(d, useApp.getState().prefs.measurementUnits))
      }
    },
    {
      id: 'measure.calibrate',
      label: 'Calibrate Scale…',
      icon: Crosshair,
      keywords: ['measure', 'scale'],
      run: () => {
        useMeasure.setState({ calibrating: true, live: null })
        setTool('measure.distance')
        openToolGroup('measure')
      }
    },
    {
      id: 'measure.export',
      label: 'Export Measurements…',
      icon: FileSpreadsheet,
      keywords: ['csv', 'spreadsheet', 'excel', 'measure'],
      run: ({ doc }) => exportMeasurementsCsv(doc!)
    }
  ],
  menus: [
    { menu: 'comment', group: 'stamps', command: 'stamps.addStamp', order: 700, submenu: 'Stamps' },
    { menu: 'comment', group: 'stamps', command: 'stamps.showPalette', order: 701, submenu: 'Stamps' },
    { menu: 'comment', group: 'stamps', command: 'stamps.createCustom', order: 702, submenu: 'Stamps' },
    { menu: 'tools', group: 'measure', command: 'measure.distanceTool', order: 500, submenu: 'Measure' },
    { menu: 'tools', group: 'measure', command: 'measure.perimeterTool', order: 501, submenu: 'Measure' },
    { menu: 'tools', group: 'measure', command: 'measure.areaTool', order: 502, submenu: 'Measure' },
    { menu: 'tools', group: 'measure', command: 'measure.setScale', order: 503, submenu: 'Measure' },
    { menu: 'tools', group: 'measure', command: 'measure.calibrate', order: 504, submenu: 'Measure' },
    { menu: 'tools', group: 'measure', command: 'measure.export', order: 505, submenu: 'Measure' }
  ],
  onDocumentOpen: watchMeasurements
})

import { useEffect, useState, type CSSProperties } from 'react'
import type { FieldInfo } from '@engine/ops/forms'
import type formOps from '@engine/ops/forms'
import { useApp, useDocState, usePageVersion, type PageGeometry, type PageLayerProps } from '@renderer/sdk'
import type fillOps from './engine'
import type { WidgetExtra } from './engine'
import { formController } from './controller'
import { useFormsSettings } from './settings'
import { ButtonControl, CheckControl, ComboControl, ListControl, SignatureControl, TextControl, type ControlProps } from './controls'

/** Geometry of a field control: an unrotated box plus the CSS rotation of its content. */
export interface FieldBox {
  style: CSSProperties
  /** Unrotated size in CSS pixels. */
  width: number
  height: number
  /** CSS pixels per point. */
  scale: number
}

export function fieldBox(f: FieldInfo, geometry: PageGeometry, pageRotation: number, extra?: WidgetExtra): FieldBox {
  const css = geometry.rectToCss(f.rect)
  const angle = (((pageRotation + geometry.rotation - (extra?.rotation ?? 0)) % 360) + 360) % 360
  const swap = angle === 90 || angle === 270
  const width = swap ? css.height : css.width
  const height = swap ? css.width : css.height
  return {
    style: {
      left: css.left + (css.width - width) / 2,
      top: css.top + (css.height - height) / 2,
      width,
      height,
      transform: angle ? `rotate(${angle}deg)` : undefined
    },
    width,
    height,
    scale: geometry.scale
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return `rgba(204, 215, 255, ${alpha})`
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
}

/**
 * Page layer 'form-fields': an interactive control over every form widget. Controls are
 * transparent (the PDF appearance shows through) until they are focused.
 */
export function FieldLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const version = usePageVersion(doc, pageIndex)
  const pageRotation = useDocState(doc, (s) => s.info.pages[pageIndex]?.rotation ?? 0)
  const permissions = useDocState(doc, (s) => s.info.permissions)
  const highlight = useApp((s) => s.prefs.highlightFormFields)
  const pageColors = useApp((s) => s.prefs.pageColors)
  const highlightColor = useFormsSettings((s) => s.highlightColor)
  const requiredColor = useFormsSettings((s) => s.requiredColor)
  const [state, setState] = useState<{ fields: FieldInfo[]; extras: Map<number, WidgetExtra>; displays: Map<number, string> }>({
    fields: [],
    extras: new Map(),
    displays: new Map()
  })
  const ctl = formController(doc)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const fields = await doc.ops<typeof formOps>('forms').list(pageIndex)
      const extras = fields.length ? await doc.ops<typeof fillOps>('forms-fill').pageExtras(pageIndex) : []
      const displays = await formattedValues(fields)
      if (!alive) return
      for (const e of extras) ctl.extras.set(e.id, e)
      setState({ fields, extras: new Map(extras.map((e) => [e.id, e])), displays })
    }
    // Text the field shows when it is not being edited (its format script applied), like the appearance.
    const formattedValues = async (fields: FieldInfo[]) => {
      const out = new Map<number, string>()
      const formatted = fields.filter((f) => f.type === 'text' && f.scripts.format && f.value && !f.password)
      if (!formatted.length) return out
      try {
        const rt = await ctl.runtime()
        for (const f of formatted) {
          const shown = rt.format(f.name, f.value).display
          if (shown !== f.value) out.set(f.id, shown)
        }
      } catch (err) {
        console.warn('Could not format the form fields', err)
      }
      return out
    }
    load().catch((err) => {
      // A page deleted while its fields were loading: its layer is about to go away.
      if ((err as { code?: string })?.code === 'BAD_PAGE') return
      if (alive && !doc.isClosed) ctl.loadFailed(err)
    })
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version, ctl])

  if (!state.fields.length) return null
  const canFill = permissions.form !== false || permissions.annotate !== false
  const inverted = pageColors !== 'document'
  const style = {
    '--fc-forms-fill-highlight': inverted ? hexToRgba(highlightColor, 0.35) : highlightColor,
    '--fc-forms-fill-required': requiredColor
  } as CSSProperties
  return (
    <div
      className={`viewer-layer fc-forms-fill-layer ${highlight ? 'is-highlighted' : ''} ${inverted ? 'is-inverted' : ''}`}
      style={style}
      data-page-index={pageIndex}
    >
      {state.fields.map((f) => {
        const extra = state.extras.get(f.id)
        if (f.hidden || extra?.noView) return null
        const props: ControlProps = {
          doc,
          ctl,
          field: f,
          extra,
          box: fieldBox(f, geometry, pageRotation, extra),
          readOnly: f.readOnly || !canFill,
          display: state.displays.get(f.id)
        }
        switch (f.type) {
          case 'text':
            return <TextControl key={f.id} {...props} />
          case 'checkbox':
          case 'radio':
            return <CheckControl key={f.id} {...props} />
          case 'combo':
            return <ComboControl key={f.id} {...props} />
          case 'list':
            return <ListControl key={f.id} {...props} />
          case 'button':
            return <ButtonControl key={f.id} {...props} />
          case 'signature':
            return <SignatureControl key={f.id} {...props} />
          default:
            return null
        }
      })}
    </div>
  )
}

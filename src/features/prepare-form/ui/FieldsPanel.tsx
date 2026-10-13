import { useEffect, useRef, useState } from 'react'
import { Calculator, Eye, GripVertical, PencilLine } from 'lucide-react'
import {
  Button,
  Checkbox,
  EmptyState,
  openToolGroup,
  setTool,
  showContextMenu,
  useApp,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { TYPE_LABELS, type PFField, type TabOrder } from '../model'
import {
  deleteFields,
  enterFormEditing,
  fieldSelection,
  isFormTool,
  renameField,
  selectFields,
  setTabOrder
} from './actions'
import { openCalculationOrder } from './CalcOrderDialog'
import { useAllFields } from './hooks'
import { TYPE_ICONS } from './icons'
import { fieldMenu } from './menus'
import { openProperties } from './PropertiesDialog'
import { usePF } from './state'

const ORDER_LABELS: Record<TabOrder, string> = {
  row: 'Row order',
  column: 'Column order',
  structure: 'Manual order',
  unspecified: 'Document order'
}

/** Right panel "Fields": every field by page in tab order. */
export function FieldsPanel({ doc }: { doc: DocumentModel }) {
  const { fields, tabs, loaded } = useAllFields(doc)
  const toolId = useApp((s) => s.toolId)
  const selection = useDocState(doc, (s) => s.selection)
  const showTabs = usePF((s) => s.showTabNumbers)
  const sel = fieldSelection(selection)
  const editing = isFormTool(toolId)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: number; after: boolean } | null>(null)

  const pages = [...new Set(fields.map((f) => f.page))].sort((a, b) => a - b)

  const focusField = (f: PFField, additive = false) => {
    if (!editing) enterFormEditing()
    const ids =
      additive && sel?.page === f.page
        ? sel.ids.includes(f.id)
          ? sel.ids.filter((x) => x !== f.id)
          : [...sel.ids, f.id]
        : [f.id]
    selectFields(doc, f.page, ids)
    doc.view?.scrollToRect(f.page, f.rect, { center: true })
  }

  const reorder = (page: number, fromId: number, toId: number, after: boolean) => {
    const ids = fields.filter((f) => f.page === page).map((f) => f.id)
    const rest = ids.filter((id) => id !== fromId)
    let idx = rest.indexOf(toId)
    if (idx < 0) return
    if (after) idx++
    rest.splice(idx, 0, fromId)
    if (rest.every((id, i) => id === ids[i])) return
    void setTabOrder(doc, page, 'structure', rest)
  }

  const moveBy = (f: PFField, d: number) => {
    const ids = fields.filter((x) => x.page === f.page).map((x) => x.id)
    const i = ids.indexOf(f.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void setTabOrder(doc, f.page, 'structure', ids)
  }

  if (loaded && !fields.length) {
    return (
      <div className="fc-prepare-form-panel">
        <EmptyState icon={TYPE_ICONS.text} title="No form fields">
          Add text fields, check boxes, signature fields and more with Prepare a form.
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={() => openToolGroup('prepareform')}>
              Prepare a form
            </Button>
          </div>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="fc-prepare-form-panel">
      <div className="fc-prepare-form-panel-bar">
        <span className="shell-muted">
          {fields.length} field{fields.length === 1 ? '' : 's'}
        </span>
        <Button
          size="sm"
          icon={editing ? Eye : PencilLine}
          onClick={() => (editing ? setTool('select') : enterFormEditing())}
          aria-pressed={!editing}
        >
          {editing ? 'Preview' : 'Edit fields'}
        </Button>
      </div>
      <div className="fc-prepare-form-panel-list">
        {pages.map((page) => {
          const order = tabs.find((t) => t.page === page)?.order ?? 'unspecified'
          return (
            <section key={page} className="fc-prepare-form-page">
              <div className="fc-prepare-form-page-head">
                <h4>Page {doc.state.info.pages[page]?.label ?? page + 1}</h4>
                <select
                  className="ui-input ui-select fc-prepare-form-order"
                  aria-label={`Tab order on page ${page + 1}`}
                  value={order}
                  onChange={(e) => void setTabOrder(doc, page, e.target.value as TabOrder)}
                >
                  {(['row', 'column', 'structure', 'unspecified'] as TabOrder[]).map((o) => (
                    <option key={o} value={o}>
                      {ORDER_LABELS[o]}
                    </option>
                  ))}
                </select>
              </div>
              <ul role="listbox" aria-label={`Fields on page ${page + 1}`} aria-multiselectable>
                {fields
                  .filter((f) => f.page === page)
                  .map((f) => {
                    const Icon = TYPE_ICONS[f.type]
                    const isSel = sel?.page === page && sel.ids.includes(f.id)
                    const drop =
                      dropTarget?.id === f.id ? (dropTarget.after ? 'is-drop-after' : 'is-drop-before') : ''
                    return (
                      <li
                        key={f.id}
                        role="option"
                        aria-selected={isSel}
                        tabIndex={0}
                        className={`fc-prepare-form-field ${isSel ? 'is-selected' : ''} ${drop} ${dragId === f.id ? 'is-dragging' : ''}`}
                        draggable={renaming !== f.id}
                        data-field-name={f.name}
                        title={`${TYPE_LABELS[f.type]}${f.tooltip ? ` — ${f.tooltip}` : ''}. Drag to change the tab order.`}
                        onClick={(e) => focusField(f, e.shiftKey || e.ctrlKey || e.metaKey)}
                        onDoubleClick={() => setRenaming(f.id)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          if (!isSel) focusField(f)
                          const ids = isSel && sel ? sel.ids : [f.id]
                          showContextMenu(e.clientX, e.clientY, fieldMenu(doc, page, ids, f.id))
                        }}
                        onKeyDown={(e) => {
                          if (renaming === f.id) return
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            openProperties(doc, [f.id])
                          } else if (e.key === 'F2') {
                            e.preventDefault()
                            setRenaming(f.id)
                          } else if (e.key === 'Delete' || e.key === 'Backspace') {
                            e.preventDefault()
                            e.stopPropagation()
                            void deleteFields(doc, isSel && sel ? sel.ids : [f.id])
                          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
                            e.preventDefault()
                            e.stopPropagation()
                            moveBy(f, e.key === 'ArrowUp' ? -1 : 1)
                          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                            e.preventDefault()
                            e.stopPropagation()
                            const el = e.currentTarget
                            const all = [
                              ...(el
                                .closest('.fc-prepare-form-panel-list')
                                ?.querySelectorAll<HTMLElement>('.fc-prepare-form-field') ?? [])
                            ]
                            const next = all[all.indexOf(el) + (e.key === 'ArrowUp' ? -1 : 1)]
                            next?.focus()
                          } else if (e.key === ' ') {
                            e.preventDefault()
                            focusField(f, e.shiftKey || e.ctrlKey)
                          }
                        }}
                        onDragStart={(e) => {
                          setDragId(f.id)
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('application/x-fartcrobat-field', String(f.id))
                        }}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropTarget(null)
                        }}
                        onDragOver={(e) => {
                          const from = fields.find((x) => x.id === dragId)
                          if (!from || from.page !== page || from.id === f.id) return
                          e.preventDefault()
                          const r = e.currentTarget.getBoundingClientRect()
                          setDropTarget({ id: f.id, after: e.clientY > r.top + r.height / 2 })
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragId !== null && dropTarget)
                            reorder(page, dragId, dropTarget.id, dropTarget.after)
                          setDragId(null)
                          setDropTarget(null)
                        }}
                      >
                        <GripVertical size={14} className="fc-prepare-form-grip" aria-hidden />
                        {showTabs && <span className="fc-prepare-form-field-num">{f.tabIndex + 1}</span>}
                        <Icon size={16} aria-hidden />
                        {renaming === f.id ? (
                          <RenameInput
                            initial={f.name}
                            onDone={async (name) => {
                              setRenaming(null)
                              if (name && name !== f.name) await renameField(doc, f.id, name)
                            }}
                          />
                        ) : (
                          <span className="fc-prepare-form-field-name">{f.name}</span>
                        )}
                        {f.required && (
                          <span className="fc-prepare-form-req" title="Required">
                            *
                          </span>
                        )}
                        {f.calculate.kind !== 'none' && (
                          <Calculator size={13} className="shell-muted" aria-label="Calculated" />
                        )}
                      </li>
                    )
                  })}
              </ul>
            </section>
          )
        })}
      </div>
      <div className="fc-prepare-form-panel-foot">
        <Checkbox
          checked={showTabs}
          onChange={(v) => usePF.setState({ showTabNumbers: v })}
          label="Show tab numbers"
        />
        <Button size="sm" icon={Calculator} onClick={() => void openCalculationOrder(doc)}>
          Calculation order…
        </Button>
      </div>
      <p className="fc-prepare-form-hint fc-prepare-form-panel-tip">
        Drag fields (or press Alt+↑/↓) to change the order the Tab key follows. Double-click a name to rename
        it.
      </p>
    </div>
  )
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      ref={ref}
      className="ui-input fc-prepare-form-rename"
      value={v}
      aria-label="Field name"
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(v.trim())
        else if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(v.trim())}
    />
  )
}

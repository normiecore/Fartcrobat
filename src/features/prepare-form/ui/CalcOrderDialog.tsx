import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Button, Dialog, openDialog, showError, toast, type DocumentModel } from '@renderer/sdk'
import { pf } from './actions'

/** Forms > Set Field Calculation Order. */
export async function openCalculationOrder(doc: DocumentModel) {
  try {
    const order = await pf(doc).calculationOrder()
    if (!order.length) {
      toast('No field is calculated yet. Set a calculation on a field’s Calculate tab first.')
      return
    }
    await openDialog((close) => <CalcOrderDialog doc={doc} initial={order} close={close} />)
  } catch (err) {
    showError(err, 'Could not read the calculation order')
  }
}

function CalcOrderDialog({ doc, initial, close }: { doc: DocumentModel; initial: { id: number; name: string }[]; close: () => void }) {
  const [items, setItems] = useState(initial)
  const [sel, setSel] = useState(0)
  const move = (d: number) => {
    const j = sel + d
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[sel], next[j]] = [next[j], next[sel]]
    setItems(next)
    setSel(j)
  }
  return (
    <Dialog
      title="Calculated Fields"
      onClose={close}
      width={440}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await pf(doc).setCalculationOrder(items.map((i) => i.id))
                close()
              } catch (err) {
                showError(err, 'Could not change the calculation order')
              }
            }}
          >
            OK
          </Button>
        </>
      }
    >
      <p className="ui-dialog-message">Fields are calculated from top to bottom. Put a field below the fields its calculation uses.</p>
      <div className="fc-prepare-form-calc">
        <div
          className="fc-prepare-form-items"
          role="listbox"
          aria-label="Calculation order"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              if (e.altKey) move(-1)
              else setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (e.altKey) move(1)
              else setSel((s) => Math.min(items.length - 1, s + 1))
            }
          }}
        >
          {items.map((it, i) => (
            <div key={it.id} role="option" aria-selected={i === sel} className={`fc-prepare-form-item ${i === sel ? 'is-selected' : ''}`} onClick={() => setSel(i)}>
              <span className="fc-prepare-form-item-num">{i + 1}</span>
              <span className="fc-prepare-form-item-label">{it.name}</span>
            </div>
          ))}
        </div>
        <div className="fc-prepare-form-calc-buttons">
          <Button icon={ArrowUp} onClick={() => move(-1)} disabled={sel <= 0}>
            Up
          </Button>
          <Button icon={ArrowDown} onClick={() => move(1)} disabled={sel >= items.length - 1}>
            Down
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

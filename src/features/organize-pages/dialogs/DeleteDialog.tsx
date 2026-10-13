import { useState } from 'react'
import { Button, Dialog, openDialog, type DocumentModel } from '@renderer/sdk'
import { deletePages } from '../actions'
import { countLabel } from '../ranges'
import { PageScope, Summary, initialScope, resolveScope, type Scope } from './common'

function DeleteDialog({
  doc,
  selected,
  close
}: {
  doc: DocumentModel
  selected: number[]
  close: () => void
}) {
  const [scope, setScope] = useState<Scope>(initialScope(selected))
  const res = resolveScope(doc, scope, selected)
  const all = res.ok && res.pages.length >= doc.pageCount
  const ok = res.ok && !all
  const submit = () => {
    if (!ok) return
    close()
    void deletePages(doc, res.pages)
  }
  return (
    <Dialog
      title="Delete Pages"
      onClose={close}
      onSubmit={submit}
      width={440}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={!ok} onClick={submit}>
            Delete
          </Button>
        </>
      }
    >
      <PageScope doc={doc} value={scope} onChange={setScope} selected={selected} allowAll={false} />
      <Summary tone={all ? 'warning' : undefined}>
        {all
          ? "You can't delete every page — a PDF needs at least one page."
          : res.ok
            ? `${countLabel(res.pages.length)} will be deleted. You can undo this.`
            : ' '}
      </Summary>
    </Dialog>
  )
}

/** Document > Delete Pages… (Mod+Shift+D) */
export async function openDeleteDialog(doc: DocumentModel, selected: number[]): Promise<void> {
  await openDialog((close) => <DeleteDialog doc={doc} selected={selected} close={() => close()} />)
}

import { ask, confirm, openDialog, showError, toast, type DocumentModel } from '@renderer/sdk'
import { groupsOf, listingOf, marksApi, refreshMarks } from './store'
import { lastSettings } from './memory'
import {
  defaultBackground,
  defaultBates,
  defaultHeaderFooter,
  defaultWatermark,
  describePages,
  MARK_NAMES,
  MARK_NAMES_LOWER,
  type BackgroundSettings,
  type BatesSettings,
  type HeaderFooterSettings,
  type MarkSettings,
  type MarkType,
  type WatermarkSettings
} from './shared'
import { HeaderFooterDialog } from './ui/HeaderFooterDialog'
import { WatermarkDialog } from './ui/WatermarkDialog'
import { BackgroundDialog } from './ui/BackgroundDialog'
import { BatesDialog } from './ui/BatesDialog'

function defaults(type: MarkType): MarkSettings {
  switch (type) {
    case 'HeaderFooter':
      return defaultHeaderFooter()
    case 'Watermark':
      return defaultWatermark()
    case 'Background':
      return defaultBackground()
    case 'Bates':
      return defaultBates()
  }
}

function lower(type: MarkType) {
  return MARK_NAMES_LOWER[type]
}

function showDialog(
  doc: DocumentModel,
  settings: MarkSettings,
  mode: 'add' | 'replace',
  intent: 'add' | 'update'
) {
  return openDialog<boolean>((close) => {
    const props = { doc, mode, intent, close }
    switch (settings.type) {
      case 'HeaderFooter':
        return <HeaderFooterDialog {...props} initial={settings as HeaderFooterSettings} />
      case 'Watermark':
        return <WatermarkDialog {...props} initial={settings as WatermarkSettings} />
      case 'Background':
        return <BackgroundDialog {...props} initial={settings as BackgroundSettings} />
      case 'Bates':
        return <BatesDialog {...props} initial={settings as BatesSettings} />
    }
  })
}

/** Add…: asks whether to replace marks that are already there, then opens the dialog. */
export async function addMarks(doc: DocumentModel, type: MarkType) {
  await refreshMarks(doc, 0)
  const existing = groupsOf(listingOf(doc), type)
  let mode: 'add' | 'replace' = 'add'
  if (existing.length) {
    const pages = [...new Set(existing.flatMap((g) => g.pages))]
    const answer = await ask({
      title: `Existing ${MARK_NAMES[type]}`,
      message: `This document already has a ${lower(type)} on ${pages.length === 1 ? 'page' : 'pages'} ${describePages(pages)}. Do you want to replace it, or add a new one as well?`,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'add', label: 'Add New' },
        { id: 'replace', label: 'Replace Existing', variant: 'primary' }
      ]
    })
    if (!answer || answer === 'cancel') return
    mode = answer === 'replace' ? 'replace' : 'add'
  }
  const initial = (await lastSettings(type)) ?? defaults(type)
  if (initial.type === 'HeaderFooter') initial.date = new Date().toISOString()
  await showDialog(doc, initial, mode, 'add')
}

/** Update…: opens the dialog with the settings of the marks already in the document. */
export async function updateMarks(doc: DocumentModel, type: MarkType) {
  await refreshMarks(doc, 0)
  const groups = groupsOf(listingOf(doc), type)
  if (!groups.length) {
    toast(`This document has no ${lower(type)} to update.`)
    return
  }
  // The most widely used settings win (several sets exist after "Add New").
  const group = [...groups].sort((a, b) => b.pages.length - a.pages.length)[0]
  await showDialog(doc, group.settings, 'replace', 'update')
}

export async function removeMarksFromUi(doc: DocumentModel, type: MarkType) {
  await refreshMarks(doc, 0)
  const groups = groupsOf(listingOf(doc), type)
  if (!groups.length) {
    toast(`This document has no ${lower(type)} to remove.`)
    return
  }
  const pages = [...new Set(groups.flatMap((g) => g.pages))]
  const ok = await confirm({
    title: `Remove ${MARK_NAMES[type]}`,
    message: `Remove the ${lower(type)} from ${pages.length === 1 ? 'page' : 'pages'} ${describePages(pages)}? You can undo this.`,
    confirmLabel: 'Remove',
    danger: true
  })
  if (!ok) return
  try {
    const res = await doc.busyWhile(`Removing ${lower(type)}…`, () => marksApi(doc).remove(type))
    toast(`Removed the ${lower(type)} from ${res.pages} ${res.pages === 1 ? 'page' : 'pages'}`, {
      kind: 'success',
      timeout: 2500
    })
  } catch (err) {
    showError(err, `Could not remove the ${lower(type)}`)
  }
}

export async function removeCrop(doc: DocumentModel) {
  await refreshMarks(doc, 0)
  const pages = listingOf(doc).croppedPages
  if (!pages.length) {
    toast('No pages are cropped.')
    return
  }
  const ok = await confirm({
    title: 'Remove Crop',
    message: `Show the whole of ${pages.length === 1 ? 'page' : 'pages'} ${describePages(pages)} again? You can undo this.`,
    confirmLabel: 'Remove Crop'
  })
  if (!ok) return
  try {
    await doc.busyWhile('Removing crop…', () =>
      marksApi(doc).setBoxes({ pages, box: 'CropBox', margins: null })
    )
    toast(`Removed the crop from ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, {
      kind: 'success',
      timeout: 2500
    })
  } catch (err) {
    showError(err, 'Could not remove the crop')
  }
}

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Check,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Files,
  ListOrdered,
  PencilLine,
  Plus,
  Settings2,
  SquareDashedMousePointer,
  Trash,
  WandSparkles
} from 'lucide-react'
import type { Point } from '@shared/geometry'
import { displayShortcut, openRightPanel, type ContextMenuItem, type DocumentModel } from '@renderer/sdk'
import { DEFAULT_SIZE, TYPE_LABELS, type PFType } from '../model'
import {
  arrangeSelected,
  copySelected,
  createField,
  deleteSelected,
  duplicateSelected,
  pasteFields,
  selectAllFields,
  setTabOrder,
  type ArrangeMode
} from './actions'
import { usePF } from './state'
import { openDuplicateDialog, openProperties } from './PropertiesDialog'
import { detectFieldsFlow } from './detectFlow'

const SEP = (id: string): ContextMenuItem => ({ id, label: '', separator: true })

export function fieldMenu(doc: DocumentModel, page: number, ids: number[], anchorId: number): ContextMenuItem[] {
  const multi = ids.length > 1
  const clip = usePF.getState().clipboard
  const showTabs = usePF.getState().showTabNumbers
  const arrange = (mode: ArrangeMode) => () => void arrangeSelected(doc, mode, anchorId)
  return [
    { id: 'props', label: 'Properties…', icon: Settings2, run: () => openProperties(doc, ids) },
    ...(multi
      ? []
      : [{ id: 'rename', label: 'Edit Field Name', icon: PencilLine, run: () => usePF.setState({ inline: { docId: doc.id, id: anchorId, page } }) }]),
    SEP('s1'),
    { id: 'copy', label: 'Copy', icon: Copy, shortcut: displayShortcut('Mod+C'), run: () => void copySelected(doc) },
    { id: 'paste', label: 'Paste', icon: ClipboardPaste, shortcut: displayShortcut('Mod+V'), disabled: !clip?.length, run: () => void pasteFields(doc, page) },
    { id: 'duplicate', label: 'Duplicate', icon: CopyPlus, run: () => void duplicateSelected(doc) },
    {
      id: 'duplicate-pages',
      label: 'Duplicate Across Pages…',
      icon: Files,
      disabled: doc.pageCount < 2,
      run: () => openDuplicateDialog(doc, ids, page)
    },
    { id: 'delete', label: 'Delete', icon: Trash, danger: true, shortcut: 'Del', run: () => void deleteSelected(doc) },
    SEP('s2'),
    {
      id: 'align',
      label: 'Align, Distribute or Center',
      icon: AlignStartVertical,
      disabled: !multi,
      submenu: [
        { id: 'left', label: 'Align Left', icon: AlignStartVertical, run: arrange('left') },
        { id: 'right', label: 'Align Right', icon: AlignEndVertical, run: arrange('right') },
        { id: 'top', label: 'Align Top', icon: AlignStartHorizontal, run: arrange('top') },
        { id: 'bottom', label: 'Align Bottom', icon: AlignEndHorizontal, run: arrange('bottom') },
        { id: 'cx', label: 'Align Centers in a Column', icon: AlignCenterVertical, run: arrange('center-x') },
        { id: 'cy', label: 'Align Centers in a Row', icon: AlignCenterHorizontal, run: arrange('center-y') },
        SEP('a1'),
        { id: 'dx', label: 'Distribute Horizontally', icon: AlignHorizontalDistributeCenter, disabled: ids.length < 3, run: arrange('distribute-x') },
        { id: 'dy', label: 'Distribute Vertically', icon: AlignVerticalDistributeCenter, disabled: ids.length < 3, run: arrange('distribute-y') }
      ]
    },
    {
      id: 'center',
      label: 'Center on Page',
      submenu: [
        { id: 'px', label: 'Horizontally', run: arrange('page-center-x') },
        { id: 'py', label: 'Vertically', run: arrange('page-center-y') },
        { id: 'pb', label: 'Both', run: arrange('page-center-both') }
      ]
    },
    {
      id: 'size',
      label: 'Set Fields to Same Size',
      disabled: !multi,
      submenu: [
        { id: 'w', label: 'Width', run: arrange('match-width') },
        { id: 'h', label: 'Height', run: arrange('match-height') },
        { id: 'b', label: 'Both', run: arrange('match-both') }
      ]
    },
    SEP('s3'),
    tabOrderMenu(doc, page, showTabs),
    { id: 'select-all', label: 'Select All Fields on Page', icon: SquareDashedMousePointer, run: () => void selectAllFields(doc, page) }
  ]
}

function tabOrderMenu(doc: DocumentModel, page: number, showTabs: boolean): ContextMenuItem {
  return {
    id: 'tabs',
    label: 'Tab Order',
    icon: ListOrdered,
    submenu: [
      { id: 'row', label: 'Order Tabs by Row', run: () => void setTabOrder(doc, page, 'row') },
      { id: 'column', label: 'Order Tabs by Column', run: () => void setTabOrder(doc, page, 'column') },
      {
        id: 'manual',
        label: 'Order Tabs Manually (Fields panel)',
        run: () => {
          openRightPanel('fields')
          usePF.setState({ showTabNumbers: true })
        }
      },
      SEP('t1'),
      {
        id: 'numbers',
        label: 'Show Tab Numbers',
        icon: showTabs ? Check : undefined,
        run: () => usePF.setState((s) => ({ showTabNumbers: !s.showTabNumbers }))
      }
    ]
  }
}

const ADD_TYPES: PFType[] = ['text', 'checkbox', 'radio', 'list', 'combo', 'button', 'date', 'signature']

export function pageMenu(doc: DocumentModel, page: number, point: Point): ContextMenuItem[] {
  const clip = usePF.getState().clipboard
  const showTabs = usePF.getState().showTabNumbers
  return [
    { id: 'paste', label: 'Paste', icon: ClipboardPaste, shortcut: displayShortcut('Mod+V'), disabled: !clip?.length, run: () => void pasteFields(doc, page) },
    {
      id: 'add',
      label: 'Add Field Here',
      icon: Plus,
      submenu: ADD_TYPES.map((t) => ({
        id: t,
        label: TYPE_LABELS[t],
        run: () => {
          const [w, h] = DEFAULT_SIZE[t]
          void createField(doc, t, page, [point[0], point[1], point[0] + w, point[1] + h])
        }
      }))
    },
    { id: 'select-all', label: 'Select All Fields on Page', icon: SquareDashedMousePointer, run: () => void selectAllFields(doc, page) },
    SEP('s1'),
    { id: 'detect', label: 'Detect Form Fields on This Page', icon: WandSparkles, run: () => void detectFieldsFlow(doc, [page]) },
    tabOrderMenu(doc, page, showTabs)
  ]
}

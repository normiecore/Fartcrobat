import {
  Calendar,
  CircleDot,
  List,
  RectangleHorizontal,
  Signature,
  SquareCheck,
  SquareChevronDown,
  TextCursorInput
} from 'lucide-react'
import type { Icon } from '@renderer/sdk'
import type { FieldKind } from '../model'

export const TYPE_ICONS: Record<FieldKind, Icon> = {
  text: TextCursorInput,
  date: Calendar,
  checkbox: SquareCheck,
  radio: CircleDot,
  list: List,
  combo: SquareChevronDown,
  button: RectangleHorizontal,
  signature: Signature,
  unknown: TextCursorInput
}

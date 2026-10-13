import { create } from 'zustand'
import type { FieldClip } from '../model'

export interface InlineTarget {
  docId: string
  id: number
  page: number
}

export interface Signer {
  name: string
  email: string
}

interface PrepareFormState {
  /** Fields copied with Edit > Copy. */
  clipboard: FieldClip[] | null
  /** Page the copied fields came from (or were last pasted on). */
  clipboardPage: number
  /** Show tab order numbers on the fields. */
  showTabNumbers: boolean
  /** The just-created field whose name box is open. */
  inline: InlineTarget | null
  /** "Add another button": the next radio button joins this group. */
  radioGroup: string | null
  /** Request e-signatures: the next signature/date field is assigned to this signer. */
  pendingSigner: Signer | null
  /** Signers per document id. */
  signers: Record<string, Signer[]>
  /** Documents we already asked about automatic field detection. */
  askedDetect: Record<string, boolean>
}

export const usePF = create<PrepareFormState>(() => ({
  clipboard: null,
  clipboardPage: -1,
  showTabNumbers: false,
  inline: null,
  radioGroup: null,
  pendingSigner: null,
  signers: {},
  askedDetect: {}
}))

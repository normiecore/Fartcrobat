import type { ComponentType, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { DocumentModel, Selection } from '../document/DocumentModel'
import type { PageGeometry } from '../viewer/geometry'

export type Icon = LucideIcon | ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>

export interface CommandContext {
  /** The active document, if any. */
  doc: DocumentModel | null
}

export type MenuId = 'file' | 'edit' | 'view' | 'document' | 'comment' | 'forms' | 'tools' | 'sign' | 'window' | 'help'

export interface CommandDefinition {
  id: string
  label: string | ((ctx: CommandContext) => string)
  icon?: Icon
  /**
   * Keyboard shortcut(s) in the form "Mod+Shift+S" ("Mod" is Cmd on macOS, Ctrl elsewhere),
   * or a single key like "H" (only active when single-key shortcuts are enabled in Preferences).
   */
  shortcut?: string | string[]
  run: (ctx: CommandContext) => void | Promise<void>
  /** Disabled commands are greyed out in menus and ignored by shortcuts. */
  enabled?: (ctx: CommandContext) => boolean
  checked?: (ctx: CommandContext) => boolean
  /** Defaults to true: the command needs an open document. */
  requiresDocument?: boolean
  /** Extra words for "Find text or tools". */
  keywords?: string[]
  /** Hide from "Find text or tools". */
  hidden?: boolean
}

export interface MenuContribution {
  menu: MenuId
  command: string
  /** Items with the same group are kept together and separated from other groups. */
  group?: string
  order?: number
  /** Nest under a submenu with this label (e.g. "Export To"). */
  submenu?: string
}

/** Props given to page layers and tool layers (one instance per rendered page). */
export interface PageLayerProps {
  doc: DocumentModel
  pageIndex: number
  geometry: PageGeometry
}

export interface ToolDefinition {
  id: string
  label: string
  icon: Icon
  shortcut?: string
  cursor?: string
  /** Per-page interaction layer while the tool is active (receives pointer events). */
  layer?: ComponentType<PageLayerProps>
  /** Contextual toolbar shown above the document while the tool is active. */
  toolbar?: ComponentType<{ doc: DocumentModel }>
  /** Allow text selection and the default annotation/form interactions while active. */
  allowDefaultInteractions?: boolean
  onActivate?: (ctx: CommandContext) => void
  onDeactivate?: (ctx: CommandContext) => void
}

export type ToolCategory = 'create' | 'edit' | 'convert' | 'sign' | 'review' | 'protect' | 'other'

/** An entry in the "All tools" panel (and optionally a tile on the Home screen). */
export interface ToolGroupDefinition {
  id: string
  label: string
  icon: Icon
  /** Accent colour of the icon tile. */
  color?: string
  description?: string
  order: number
  category?: ToolCategory
  /** Left-pane content when the tool group is opened. */
  panel?: ComponentType<{ doc: DocumentModel | null }>
  /** Tool activated when the group opens. */
  defaultTool?: string
  /**
   * Replaces the page viewer while the group is open (e.g. the Organize Pages thumbnail grid or a
   * Compare Files report). The left panel still shows `panel`.
   */
  documentView?: ComponentType<{ doc: DocumentModel }>
  /** Action for groups without a panel (e.g. open a dialog). */
  run?: (ctx: CommandContext) => void | Promise<void>
  /** Defaults to true. */
  requiresDocument?: boolean
  homeTile?: boolean
  keywords?: string[]
}

export interface RightPanelDefinition {
  id: string
  label: string
  icon: Icon
  order: number
  component: ComponentType<{ doc: DocumentModel }>
}

export interface PageLayerDefinition {
  id: string
  /** Stacking order; core layers: text selection 10, search 20, links 30. Higher is on top. */
  order: number
  component: ComponentType<PageLayerProps>
  /** Only mount the layer when this returns true (e.g. depending on the active tool). */
  when?: (ctx: { toolId: string; doc: DocumentModel }) => boolean
}

/** Buttons in the floating bar shown above selected text. */
export interface TextSelectionAction {
  id: string
  label: string
  icon: Icon
  order: number
  run: (doc: DocumentModel, selection: Extract<Selection, { kind: 'text' }>) => void | Promise<void>
}

export interface ContextMenuItem {
  id: string
  label: string
  icon?: Icon
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  run?: () => void
  separator?: boolean
  submenu?: ContextMenuItem[]
}

export interface PageContextMenuContribution {
  id: string
  order: number
  items: (ctx: { doc: DocumentModel; pageIndex: number; point: [number, number] }) => ContextMenuItem[]
}

export interface SettingsSection {
  id: string
  label: string
  order: number
  component: ComponentType
}

export interface DocToolbarItem {
  id: string
  order: number
  component: ComponentType<{ doc: DocumentModel }>
}

export interface QuickToolEntry {
  /** Tool id or command id. */
  id: string
  order: number
}

/**
 * Converts files the engine cannot open well by itself (e.g. Office files through LibreOffice)
 * into PDF bytes when they are opened. Return null to fall back to the built-in importer.
 */
export interface FileConverter {
  id: string
  extensions: string[]
  label: string
  convert: (path: string) => Promise<Uint8Array | null>
}

export interface FeatureDefinition {
  id: string
  fileConverters?: FileConverter[]
  commands?: CommandDefinition[]
  menus?: MenuContribution[]
  tools?: ToolDefinition[]
  toolGroups?: ToolGroupDefinition[]
  rightPanels?: RightPanelDefinition[]
  pageLayers?: PageLayerDefinition[]
  textSelectionActions?: TextSelectionAction[]
  pageContextMenu?: PageContextMenuContribution[]
  settings?: SettingsSection[]
  docToolbar?: DocToolbarItem[]
  /** Entries for the vertical quick-action toolbar on the left of the document. */
  quickTools?: QuickToolEntry[]
  /** Always-mounted components (e.g. listeners, floating UI). */
  globals?: ComponentType[]
  /** Called once for each document after it opens. */
  onDocumentOpen?: (doc: DocumentModel) => void
  /** Status-bar or panel badge content etc. can be added here later. */
  extra?: Record<string, ReactNode>
}

export function defineFeature(def: FeatureDefinition): FeatureDefinition {
  return def
}

class Registry {
  features: FeatureDefinition[] = []
  commands = new Map<string, CommandDefinition>()
  tools = new Map<string, ToolDefinition>()
  toolGroups: ToolGroupDefinition[] = []
  rightPanels: RightPanelDefinition[] = []
  pageLayers: PageLayerDefinition[] = []
  textSelectionActions: TextSelectionAction[] = []
  pageContextMenu: PageContextMenuContribution[] = []
  settings: SettingsSection[] = []
  docToolbar: DocToolbarItem[] = []
  quickTools: QuickToolEntry[] = []
  menus: MenuContribution[] = []
  fileConverters: FileConverter[] = []
  globals: ComponentType[] = []
  documentOpenHooks: ((doc: DocumentModel) => void)[] = []

  register(def: FeatureDefinition) {
    if (this.features.some((f) => f.id === def.id)) {
      console.warn(`Feature ${def.id} registered twice`)
      return
    }
    this.features.push(def)
    for (const c of def.commands ?? []) {
      if (this.commands.has(c.id)) console.warn(`Command ${c.id} redefined by ${def.id}`)
      this.commands.set(c.id, c)
    }
    for (const t of def.tools ?? []) {
      if (this.tools.has(t.id)) console.warn(`Tool ${t.id} redefined by ${def.id}`)
      this.tools.set(t.id, t)
    }
    this.toolGroups.push(...(def.toolGroups ?? []))
    this.rightPanels.push(...(def.rightPanels ?? []))
    this.pageLayers.push(...(def.pageLayers ?? []))
    this.textSelectionActions.push(...(def.textSelectionActions ?? []))
    this.pageContextMenu.push(...(def.pageContextMenu ?? []))
    this.settings.push(...(def.settings ?? []))
    this.docToolbar.push(...(def.docToolbar ?? []))
    this.quickTools.push(...(def.quickTools ?? []))
    this.menus.push(...(def.menus ?? []))
    this.fileConverters.push(...(def.fileConverters ?? []))
    this.globals.push(...(def.globals ?? []))
    if (def.onDocumentOpen) this.documentOpenHooks.push(def.onDocumentOpen)
    const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order
    this.toolGroups.sort(byOrder)
    this.rightPanels.sort(byOrder)
    this.pageLayers.sort(byOrder)
    this.textSelectionActions.sort(byOrder)
    this.pageContextMenu.sort(byOrder)
    this.settings.sort(byOrder)
    this.docToolbar.sort(byOrder)
    this.quickTools.sort(byOrder)
  }
}

export const registry = new Registry()

/** Loads every feature in src/features/<id>/index.tsx. */
export function loadFeatures(core: FeatureDefinition[]) {
  for (const f of core) registry.register(f)
  const modules = import.meta.glob<{ default?: FeatureDefinition }>('../../../features/*/index.tsx', { eager: true })
  for (const [path, mod] of Object.entries(modules)) {
    if (!mod.default?.id) {
      console.warn(`${path} does not export a feature definition`)
      continue
    }
    try {
      registry.register(mod.default)
    } catch (err) {
      console.error(`Feature ${path} failed to register`, err)
    }
  }
}

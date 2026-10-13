/**
 * The feature SDK: everything a feature in src/features/<id>/ normally needs, from one import.
 *
 *   import { defineFeature, useActiveDoc, openDialog, Dialog, Button } from '@renderer/sdk'
 */
export * from './app/registry'
export { useApp, useActiveDoc, usePrefs, getActiveDoc } from './app/store'
export * from './app/ui-services'
export {
  openBytes,
  openNewDocument,
  openPaths,
  openFileDialog,
  saveDocument,
  replaceDocumentBytes,
  closeDocument,
  setTool,
  openToolGroup,
  openRightPanel,
  toggleRightPanel,
  setPrefs
} from './app/actions'
export { runCommand, displayShortcut, registerActiveEditor, type ActiveEditor } from './app/commands'
export { DocumentModel, useDocState, usePageVersion, type Selection, type DocState } from './document/DocumentModel'
export * from './document/textModel'
export { PageGeometry, type CssRect } from './viewer/geometry'
export { setHiddenAnnotations } from './viewer/hiddenAnnotations'
export { getLoadedText, loadText } from './viewer/layers/textSync'
export { renderQueueFor, drawResult } from './viewer/renderQueue'
export { ToolPanelFrame, AllToolsList } from './shell/LeftPane'
export { openPreferences } from './core/dialogs'
export { authorName } from './core/coreFeature'
export { copySelection, useSelectionToolbar } from './viewer/layers/TextSelectionLayer'
export { followExternalLink } from './viewer/layers/LinkLayer'
export { nextZoomStep, ZOOM_STEPS } from './viewer/layout'
export { EngineClient } from './engine/EngineClient'
export * from './ui'
export * from './platform'

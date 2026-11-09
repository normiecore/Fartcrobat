/**
 * New on every load of this window: document ids ("doc-<n>") start again after a crash-reload, so
 * anything naming a document from outside the window (agent handles, tabs moved between windows)
 * carries this as well.
 */
export const WINDOW_BOOT = crypto.getRandomValues(new Uint32Array(1))[0].toString(36)

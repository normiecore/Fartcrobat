/**
 * Content Security Policy for everything served from app://fartcrobat. The same string is in the
 * <meta> tag of src/renderer/index.html (used by the dev server); a unit test keeps them equal.
 * Sending it as a response header also covers the engine's Web Workers, which parse untrusted
 * PDFs and do not inherit the page's <meta> policy.
 */
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data:; object-src 'none'"

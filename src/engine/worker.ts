/// <reference lib="webworker" />
// Engine Web Worker: owns one MuPDF document and answers calls from the UI thread.
import wasmUrl from '../../node_modules/mupdf/dist/mupdf-wasm.wasm?url'
import type { EngineMessage, EngineRequest } from './protocol'
import { Dispatcher } from './dispatcher'
import { collectOpModules } from './registry'
import { Session } from './session'

declare const self: DedicatedWorkerGlobalScope

;(globalThis as any).$libmupdf_wasm_Module = {
  locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path)
}

const post = (msg: EngineMessage, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

const ready: Promise<Dispatcher> = (async () => {
  const mupdf = await import('mupdf')
  mupdf.setLog({ warning: () => {}, error: (m: string) => console.warn('[mupdf]', m) })
  const dispatcher = new Dispatcher(new Session(mupdf), collectOpModules())
  post({ kind: 'ready', methods: dispatcher.list() })
  return dispatcher
})()

ready.catch((err) => post({ kind: 'init-error', message: String(err?.message ?? err) }))

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const req = event.data
  if (req.kind !== 'call') return
  let dispatcher: Dispatcher
  try {
    dispatcher = await ready
  } catch (err) {
    post({ kind: 'error', id: req.id, message: `Engine failed to start: ${err}`, code: 'INIT', changes: null })
    return
  }
  try {
    const { result, transfer, changes } = await dispatcher.call(
      req.method,
      req.args,
      (fraction, message) => post({ kind: 'progress', id: req.id, fraction, message }),
      req.actor
    )
    post({ kind: 'result', id: req.id, result, changes }, transfer)
  } catch (err: any) {
    const s = dispatcher.session
    post({
      kind: 'error',
      id: req.id,
      message: String(err?.message ?? err),
      code: err?.code ?? 'ENGINE_ERROR',
      changes: s.doc ? s.takeChanges() : null
    })
  }
}

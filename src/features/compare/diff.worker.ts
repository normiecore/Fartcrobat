/// <reference lib="webworker" />
// Runs the CPU-heavy parts of a comparison (page alignment, word diff, pixel diff) off the UI thread.
import { compareText, visualDiff } from './core'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

declare const self: DedicatedWorkerGlobalScope

const post = (msg: WorkerResponse) => self.postMessage(msg)

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    if (req.kind === 'text') {
      const result = compareText(req.oldPages, req.newPages, req.options, (fraction, message) =>
        post({ kind: 'progress', id: req.id, fraction, message })
      )
      post({ kind: 'result', id: req.id, result })
    } else {
      const result = visualDiff(req.a, req.b, req.oldPage, req.newPage)
      post({ kind: 'result', id: req.id, result })
    }
  } catch (err: any) {
    post({ kind: 'error', id: req.id, message: String(err?.message ?? err) })
  }
}

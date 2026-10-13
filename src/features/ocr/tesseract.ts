/**
 * Tesseract in the app: one Web Worker running tesseract.js with its WebAssembly core and the
 * language data, all bundled with the app (no network). Vite emits the files as assets; the
 * worker is started from a tiny bootstrap script that answers the worker's requests for
 * "<langPath>/<code>.traineddata.gz" with the bundled English data or a language file the user
 * added, then loads tesseract.js's worker script.
 */
import { createWorker, OEM, type Worker } from 'tesseract.js'
import workerScriptUrl from 'tesseract.js/dist/worker.min.js?url'
// The core version tesseract.js 7 is built against (installed under tesseract.js itself).
import coreSimdUrl from '../../../node_modules/tesseract.js/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'
import coreUrl from '../../../node_modules/tesseract.js/node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js?url'
import engDataUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url'
import { readFile } from '@renderer/sdk'
import { BUNDLED_LANGUAGE } from './constants'
import type { InstalledLanguage } from './ipc'
import { languageName } from './languages'
import { CancelledError, type RecognizeOutput, type Recognizer } from './pipeline'

const absolute = (url: string) => new URL(url, window.location.href).href

/** Smallest module using a SIMD instruction (v128.const), as used by wasm-feature-detect. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])

function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

/** Where the worker believes the language files are (served by the bootstrap script). */
const LANG_BASE = new URL('fartcrobat-ocr://languages').href.replace(/\/$/, '')

function bootstrapSource(files: Record<string, string>, script: string): string {
  return `"use strict";
const files = ${JSON.stringify(files)};
const realFetch = self.fetch.bind(self);
self.fetch = function (input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  return realFetch(Object.prototype.hasOwnProperty.call(files, url) ? files[url] : input, init);
};
importScripts(${JSON.stringify(script)});
`
}

export interface TesseractSession extends Recognizer {
  terminate(): void
}

export class LanguageUnavailableError extends Error {}

/**
 * Starts a Tesseract worker for `language` ("eng", "fra", "eng+fra"...). Rejects with
 * CancelledError when `signal` aborts first.
 */
export async function startTesseract(
  language: string,
  installed: InstalledLanguage[],
  signal?: AbortSignal
): Promise<TesseractSession> {
  const codes = language.split('+').filter(Boolean)
  const files: Record<string, string> = {}
  const blobUrls: string[] = []
  for (const code of codes) {
    const key = `${LANG_BASE}/${code}.traineddata.gz`
    const user = installed.find((l) => l.code === code)
    if (user) {
      let bytes: Uint8Array
      try {
        bytes = await readFile(user.path)
      } catch (err) {
        throw new LanguageUnavailableError(`The language file for ${languageName(code)} could not be read: ${(err as Error).message}`)
      }
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]))
      blobUrls.push(url)
      files[key] = url
    } else if (code === BUNDLED_LANGUAGE) {
      files[key] = absolute(engDataUrl)
    } else {
      throw new LanguageUnavailableError(
        `${languageName(code)} is not installed. Add its language file in Preferences > OCR first.`
      )
    }
  }
  const bootUrl = URL.createObjectURL(
    new Blob([bootstrapSource(files, absolute(workerScriptUrl))], { type: 'application/javascript' })
  )
  const release = () => {
    URL.revokeObjectURL(bootUrl)
    for (const u of blobUrls) URL.revokeObjectURL(u)
  }

  let onJobProgress: ((fraction: number) => void) | null = null
  let failJob: ((err: Error) => void) | null = null
  let failInit: ((err: Error) => void) | null = null
  const initFailed = new Promise<never>((_, reject) => {
    failInit = reject
  })
  initFailed.catch(() => {})
  const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

  let worker: Worker | null = null
  let terminated = false
  const terminate = () => {
    if (terminated) return
    terminated = true
    try {
      void worker?.terminate()
    } catch {}
    release()
  }

  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      terminate()
      reject(new CancelledError())
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})

  try {
    const creating = createWorker(codes.join('+'), OEM.LSTM_ONLY, {
      workerPath: bootUrl,
      workerBlobURL: false,
      corePath: absolute(supportsSimd() ? coreSimdUrl : coreUrl),
      langPath: LANG_BASE,
      gzip: true,
      cacheMethod: 'none',
      logger: (m) => {
        if (m.status === 'recognizing text' && onJobProgress) onJobProgress(Math.max(0, Math.min(1, m.progress)))
      },
      // tesseract.js throws inside its message handler without one; route errors to the job.
      errorHandler: (e) => {
        const err = toError(e)
        if (failJob) failJob(err)
        else failInit?.(err)
      }
    })
    creating.then((w) => {
      // Cancelled while starting: stop the worker as soon as it exists.
      if (terminated) void w.terminate()
    }, () => {})
    worker = await Promise.race([creating, initFailed, aborted])
  } catch (err) {
    terminate()
    if (err instanceof CancelledError) throw err
    const msg = String((err as Error)?.message ?? err)
    if (/initialization failed|traineddata|fetch/i.test(msg)) {
      throw new LanguageUnavailableError(
        `The language data for ${languageName(language)} could not be loaded. The file may be damaged or made for another Tesseract version.`
      )
    }
    throw new Error(`The text recognition engine could not start: ${msg}`)
  }

  return {
    async recognize(png, opts, onProgress): Promise<RecognizeOutput> {
      if (terminated || !worker) throw new CancelledError()
      onJobProgress = onProgress
      const failed = new Promise<never>((_, reject) => {
        failJob = reject
      })
      failed.catch(() => {})
      try {
        const res = await Promise.race([
          worker.recognize(
            png as any,
            { rotateAuto: true, user_defined_dpi: String(Math.round(opts.dpi)) } as any,
            { blocks: true, text: false }
          ),
          failed,
          aborted
        ])
        return {
          blocks: (res.data.blocks ?? null) as RecognizeOutput['blocks'],
          rotateRadians: Number((res.data as any).rotateRadians) || 0
        }
      } finally {
        onJobProgress = null
        failJob = null
      }
    },
    terminate
  }
}

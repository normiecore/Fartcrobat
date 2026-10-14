// Electron main-process probe for safeStorage (run with the repo's Electron 44 binary):
//   xvfb-run -a /home/user/Fartcrobat/node_modules/electron/dist/electron --no-sandbox main.cjs [--password-store=basic]
// Prints what the sync and async APIs report and whether ciphertexts are interchangeable.
const { app, safeStorage } = require('electron')
const { mkdtempSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

app.setPath('userData', process.env.PROBE_USER_DATA || mkdtempSync(join(tmpdir(), 'ss-probe-')))

const out = {}
const tryIt = async (name, fn) => {
  try {
    out[name] = await fn()
  } catch (e) {
    out[name] = `THROWS: ${e && e.message}`
  }
}

;(async () => {
  out.electron = process.versions.electron
  out.node = process.versions.node
  out.platform = process.platform
  out.argv = process.argv.slice(2).join(' ')
  // Before ready
  await tryIt('beforeReady.isEncryptionAvailable', () => safeStorage.isEncryptionAvailable())
  if (process.platform === 'linux') await tryIt('beforeReady.backend', () => safeStorage.getSelectedStorageBackend())
  await app.whenReady()
  if (process.platform === 'linux') await tryIt('backend', () => safeStorage.getSelectedStorageBackend())
  await tryIt('isEncryptionAvailable', () => safeStorage.isEncryptionAvailable())
  await tryIt('isAsyncEncryptionAvailable', () => safeStorage.isAsyncEncryptionAvailable())
  const secret = 'pässwörd-✓-' + 'x'.repeat(5)
  let syncCt = null
  let asyncCt = null
  await tryIt('encryptString', () => {
    syncCt = safeStorage.encryptString(secret)
    return `${syncCt.length} bytes, prefix ${JSON.stringify(syncCt.subarray(0, 3).toString('latin1'))}`
  })
  await tryIt('decryptString(sync ct)', () => safeStorage.decryptString(syncCt) === secret)
  await tryIt('encryptStringAsync', async () => {
    asyncCt = await safeStorage.encryptStringAsync(secret)
    return `${asyncCt.length} bytes, prefix ${JSON.stringify(Buffer.from(asyncCt).subarray(0, 3).toString('latin1'))}`
  })
  await tryIt('decryptStringAsync(async ct)', async () => {
    const r = await safeStorage.decryptStringAsync(asyncCt)
    return { ok: r.result === secret, shouldReEncrypt: r.shouldReEncrypt }
  })
  await tryIt('decryptStringAsync(sync ct)', async () => {
    const r = await safeStorage.decryptStringAsync(syncCt)
    return { ok: r.result === secret, shouldReEncrypt: r.shouldReEncrypt }
  })
  await tryIt('decryptString(async ct)', () => safeStorage.decryptString(Buffer.from(asyncCt)) === secret)
  await tryIt('decryptStringAsync(garbage)', async () => {
    const r = await safeStorage.decryptStringAsync(Buffer.from('v10' + 'A'.repeat(40)))
    return r
  })
  await tryIt('decryptString(garbage)', () => safeStorage.decryptString(Buffer.from('v10' + 'A'.repeat(40))))
  if (process.env.PROBE_ADAPTER) {
    // The adapter + store, as the app would wire them (compiled from src/*.ts by run-probe.sh).
    const { electronCipher } = await import(process.env.PROBE_ADAPTER)
    const cipher = electronCipher(safeStorage, { platform: process.platform, disabledByPolicy: () => false })
    await tryIt('adapter.unavailable', () => cipher.unavailable())
    await tryIt('adapter.backend', () => cipher.backend())
    await tryIt('adapter.roundTrip', async () => {
      const ct = await cipher.encrypt('abc')
      return (await cipher.decrypt(ct)).text === 'abc'
    })
  }
  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})().catch((e) => {
  console.error('probe failed', e)
  app.exit(1)
})

// Second probe: ciphertext written by one app run must decrypt in the next run (same keyring).
//   PROBE_CT_FILE=<file> electron persist.cjs   (writes the file when missing, else decrypts it)
const { app, safeStorage } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
app.setName('Fartcrobat')
if (process.env.PROBE_USER_DATA) app.setPath('userData', process.env.PROBE_USER_DATA)
app.whenReady().then(async () => {
  const f = process.env.PROBE_CT_FILE
  try {
    if (!existsSync(f)) {
      writeFileSync(f, Buffer.from(await safeStorage.encryptStringAsync('remembered-secret')))
      console.log('run 1: wrote ciphertext, backend', safeStorage.getSelectedStorageBackend())
    } else {
      const r = await safeStorage.decryptStringAsync(readFileSync(f))
      console.log('run 2: decrypted ok =', r.result === 'remembered-secret', 'shouldReEncrypt =', r.shouldReEncrypt)
    }
  } catch (e) {
    console.log('decrypt/encrypt failed:', e.message)
  }
  app.exit(0)
})

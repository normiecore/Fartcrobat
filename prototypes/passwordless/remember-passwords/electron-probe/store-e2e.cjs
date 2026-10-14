// The prototype store with the real safeStorage adapter, inside Electron's main process.
//   PROBE_USER_DATA=<dir> PROBE_STEP=remember|find electron store-e2e.cjs
// 'remember' saves a password for a fake lock; 'find' (a later app run) looks it up.
const { app, safeStorage } = require('electron')
const { join } = require('node:path')
const { readFileSync, existsSync } = require('node:fs')

app.setName('Fartcrobat')
app.setPath('userData', process.env.PROBE_USER_DATA)

app.whenReady().then(async () => {
  const build = join(__dirname, '..', 'build')
  const { SavedPasswordStore } = await import(join(build, 'store.mjs'))
  const { pdfKeys } = await import(join(build, 'keys.mjs'))
  const { electronCipher } = await import(join(build, 'electronCipher.mjs'))
  const { nodeFs } = await import(join(build, 'nodeFs.mjs'))
  const file = join(app.getPath('userData'), 'saved-passwords.json')
  const store = new SavedPasswordStore({
    file,
    cipher: electronCipher(safeStorage, { platform: process.platform, disabledByPolicy: () => process.env.PROBE_POLICY_OFF === '1' }),
    fs: nodeFs
  })
  const keys = pdfKeys({ lock: { handler: 'Standard', id: 'feedface', security: 'Filter=Standard;V=5;R=6;U=00' }, pathKey: '/docs/contract.pdf' })
  const out = { step: process.env.PROBE_STEP, unavailable: await store.unavailable(), backend: store.backend() }
  if (process.env.PROBE_STEP === 'remember') {
    out.ref = await store.remember({ kind: 'pdf', keys, label: 'contract.pdf', level: 'user', password: 'Sesame-✓-42' })
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      out.fileHasPassword = text.includes('Sesame')
      out.secretPrefix = Buffer.from(JSON.parse(text).records[0].secret, 'base64').subarray(0, 3).toString('latin1')
    } else out.file = 'not written'
  } else {
    out.found = (await store.find(keys)).map((c) => ({ ...c, password: c.password === 'Sesame-✓-42' ? '<matches>' : '<DIFFERENT>' }))
    out.list = await store.list()
  }
  console.log('RESULT ' + JSON.stringify(out))
  app.exit(0)
})

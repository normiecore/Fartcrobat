// Packs the Claude Desktop extension, an MCP Bundle: <outDir>/fartcrobat.mcpb holding manifest.json,
// icon.png and server/shim.mjs (built first by scripts/build-agent-shim.mjs). The installers ship it
// in resources/agent (electron-builder.yml); Preferences > AI apps > Add to Claude Desktop opens it.
//   node scripts/build-agent-extension.mjs [outDir]     (default out/agent)
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packExtension } from '@anthropic-ai/mcpb'
import { runnerImport } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.argv[2] ?? resolve(root, 'out/agent'))
const shim = join(outDir, 'shim.mjs')
const staging = join(outDir, 'extension')
const bundle = join(outDir, 'fartcrobat.mcpb')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

if (!existsSync(shim)) {
  console.error(`${shim} is missing: run scripts/build-agent-shim.mjs first.`)
  process.exit(1)
}

// The manifest lists the tools the shim advertises, from the same catalogue.
const { module: catalogue } = await runnerImport('/src/shared/agent/tools.ts', {
  root,
  configFile: false,
  logLevel: 'warn'
})

const manifest = {
  // 0.2 is what `mcpb init` writes and every Claude Desktop with extension support reads; nothing
  // here needs a later version.
  manifest_version: '0.2',
  name: 'fartcrobat',
  display_name: 'Fartcrobat',
  version: pkg.version,
  description:
    'Work with the PDF documents open in Fartcrobat: read, comment, fill forms, redact, organize pages and more.',
  long_description: [
    'Lets Claude work with the documents open in Fartcrobat on this computer, as you would: read text and pages, see what you selected, add comments, fill forms, mark redactions, organize pages and save.',
    'Changes appear live in Fartcrobat and can be undone there (Edit > Undo shows "Agent: ..."). Irreversible actions, such as overwriting a file, applying redactions, signing or removing security, wait for you to confirm in Fartcrobat. Passwords are always typed in Fartcrobat, never in chat.',
    'Fartcrobat must be installed. It starts when Claude first uses it. To stop AI apps from working with your documents, turn off Preferences > AI apps in Fartcrobat. Text that Claude reads from a document is sent to Claude like anything else in the conversation.'
  ].join('\n\n'),
  author: { name: pkg.author.name, url: pkg.homepage },
  homepage: pkg.homepage,
  repository: { type: 'git', url: pkg.repository.url },
  icon: 'icon.png',
  license: pkg.license,
  keywords: ['pdf', 'documents', 'forms', 'comments', 'redaction', 'signing'],
  server: {
    type: 'node',
    entry_point: 'server/shim.mjs',
    mcp_config: { command: 'node', args: ['${__dirname}/server/shim.mjs'] }
  },
  tools: catalogue.AGENT_TOOLS.map(({ name, description }) => ({ name, description })),
  compatibility: { platforms: ['win32', 'darwin', 'linux'], runtimes: { node: '>=20.0.0' } }
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'server'), { recursive: true })
writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
copyFileSync(resolve(root, 'build/icons/512x512.png'), join(staging, 'icon.png'))
copyFileSync(shim, join(staging, 'server', 'shim.mjs'))

// Packing validates the manifest (schema and icon) first, like `mcpb validate`.
rmSync(bundle, { force: true })
if (!(await packExtension({ extensionPath: staging, outputPath: bundle, silent: true }))) {
  console.error('Packing the Claude Desktop extension failed.')
  process.exit(1)
}
console.log(`Claude Desktop extension: ${bundle}`)

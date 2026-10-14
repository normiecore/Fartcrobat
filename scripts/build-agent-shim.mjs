// Bundles the MCP helper (src/agent-shim) into one ES module for Node 20 or later with every package
// inside it: the Claude Desktop extension ships that file alone (scripts/build-agent-extension.mjs).
//   node scripts/build-agent-shim.mjs [outDir]     (default out/agent; writes <outDir>/shim.mjs)
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.argv[2] ?? resolve(root, 'out/agent'))
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const builtins = new Set(builtinModules)

const result = await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  define: { __FARTCROBAT_VERSION__: JSON.stringify(pkg.version) },
  // An SSR build resolves packages for Node; noExternal puts all of them in the bundle.
  ssr: { target: 'node', noExternal: true },
  build: {
    ssr: resolve(root, 'src/agent-shim/index.ts'),
    outDir,
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'shim.mjs', inlineDynamicImports: true },
      // zod's sources carry comments Rollup cannot place; they are dropped harmlessly.
      onwarn(warning, warn) {
        if (warning.code !== 'INVALID_ANNOTATION') warn(warning)
      }
    }
  }
})

// Anything left as an import other than Node's own modules would be missing in the extension.
const output = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output ?? [])
const missing = output
  .flatMap((chunk) => (chunk.type === 'chunk' ? [...chunk.imports, ...chunk.dynamicImports] : []))
  .filter((id) => !id.startsWith('node:') && !builtins.has(id))
if (missing.length) {
  console.error(`The agent shim imports packages that are not bundled: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`Agent shim: ${resolve(outDir, 'shim.mjs')}`)

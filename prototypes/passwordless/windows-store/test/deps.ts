// Test-only: load node-forge and mupdf from an app checkout (FC_NODE_MODULES), so the suite also runs on Windows.
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const NODE_MODULES = process.env.FC_NODE_MODULES ?? '/home/user/Fartcrobat/node_modules'
const require = createRequire(path.join(NODE_MODULES, '..', 'package.json'))
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const forge = require('node-forge')
export const mupdf = await import(pathToFileURL(path.join(NODE_MODULES, 'mupdf', 'dist', 'mupdf.js')).href)

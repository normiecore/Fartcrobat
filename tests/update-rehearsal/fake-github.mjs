#!/usr/bin/env node
// A stand-in for github.com in update rehearsals (tests/update-rehearsal/README.md). A packaged
// Fartcrobat always asks github.com, so this is an HTTP proxy: the app is pointed at it (the
// https_proxy variable on Linux, --proxy-server on Windows) and it answers HTTPS for github.com and
// GitHub's release asset host itself, with a test certificate, as GitHub would. Every other host is
// refused, so a rehearsal never reaches the internet.
//
//   node fake-github.mjs --releases <dir> --latest v0.2.1 --cert cert.pem --key key.pem
//                        [--port 0] [--log requests.jsonl] [--ready <file>]
//
// <dir> holds one folder per release tag with its assets (v0.2.1/latest-linux.yml, ...). On start it
// prints `listening <port>` (and writes the port to --ready). Plain HTTP requests to the proxy port
// itself control it: GET /__control/latest?tag=v0.2.0 changes the latest release,
// GET /__control/requests returns the requests so far (one JSON object per line, as in --log).
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { join, resolve } from 'node:path'

const REPO = '/normiecore/Fartcrobat'
const ASSET_HOST = 'release-assets.githubusercontent.com'
const ASSET_PATH = '/github-production-release-asset'
const HOSTS = new Set(['github.com', ASSET_HOST])

const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
for (const need of ['releases', 'latest', 'cert', 'key'])
  if (!args[need]) {
    console.error(`fake-github: --${need} is required`)
    process.exit(2)
  }

const releases = resolve(args.releases)
let latest = args.latest
const requests = []

function log(entry) {
  const line = { t: new Date().toISOString(), ...entry }
  requests.push(line)
  if (args.log) appendFileSync(args.log, JSON.stringify(line) + '\n')
}

/** The release tags, newest first (v<major>.<minor>.<patch> only). */
function tags() {
  const parse = (t) => t.slice(1).split('.').map(Number)
  return readdirSync(releases)
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && statSync(join(releases, t)).isDirectory())
    .sort((a, b) => {
      const [x, y] = [parse(a), parse(b)]
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
    })
}

/** The Atom feed electron-updater reads (github.com/<repo>/releases.atom), newest entry first. */
function atom() {
  // Releases up to the latest one (a newer folder is a release not published yet).
  const all = tags()
  const entries = all
    .slice(Math.max(0, all.indexOf(latest)))
    .map(
      (t) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${t}</id>
    <updated>2026-10-20T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com${REPO}/releases/tag/${t}"/>
    <title>${t}</title>
    <content type="html">&lt;p&gt;Rehearsal release ${t}&lt;/p&gt;</content>
  </entry>`
    )
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com${REPO}/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com${REPO}/releases"/>
  <title>Release notes from Fartcrobat</title>
  <updated>2026-10-20T00:00:00Z</updated>
${entries.join('\n')}
</feed>
`
}

/** Serves a release asset with single byte ranges, as GitHub's asset host does. */
function sendFile(req, res, file, entry) {
  const size = statSync(file).size
  const range = req.headers.range
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  let start = 0
  let end = size - 1
  let status = 200
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return log({ ...entry, status: 416, range })
    }
    if (m[1] === '') start = Math.max(0, size - Number(m[2]))
    else {
      start = Number(m[1])
      if (m[2] !== '') end = Math.min(size - 1, Number(m[2]))
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return log({ ...entry, status: 416, range })
    }
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(end - start + 1)
  res.writeHead(status, headers)
  log({ ...entry, status, range, bytes: end - start + 1 })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file, { start, end }).pipe(res)
}

function handle(req, res) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  const url = new URL(req.url ?? '/', `https://${host}`)
  const entry = { method: req.method, host, path: url.pathname, accept: req.headers.accept ?? null }
  const reply = (status, headers, body = '') => {
    res.writeHead(status, headers).end(body)
    log({ ...entry, status, ...(headers.Location ? { location: headers.Location } : {}) })
  }
  if (host === 'github.com') {
    if (url.pathname === `${REPO}/releases/latest`) {
      // electron-updater asks for JSON; the app's own check reads the redirect.
      if ((req.headers.accept ?? '').includes('application/json'))
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ tag_name: latest, update_url: `${REPO}/releases/tag/${latest}` }))
      return reply(302, { Location: `https://github.com${REPO}/releases/tag/${latest}` })
    }
    if (url.pathname === `${REPO}/releases.atom`) return reply(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' }, atom())
    if (url.pathname.startsWith(`${REPO}/releases/tag/`))
      return reply(200, { 'Content-Type': 'text/html' }, `<h1>${url.pathname.split('/').pop()}</h1>`)
    const dl = new RegExp(`^${REPO}/releases/download/(v[^/]+)/([^/]+)$`).exec(url.pathname)
    if (dl && existsSync(join(releases, dl[1], dl[2])))
      return reply(302, { Location: `https://${ASSET_HOST}${ASSET_PATH}/${dl[1]}/${dl[2]}?X-Amz-Signature=rehearsal` })
    return reply(404, { 'Content-Type': 'text/plain' }, 'Not Found')
  }
  if (host === ASSET_HOST) {
    const m = new RegExp(`^${ASSET_PATH}/(v[^/]+)/([^/]+)$`).exec(url.pathname)
    const file = m && join(releases, m[1], m[2])
    if (file && existsSync(file) && (req.method === 'GET' || req.method === 'HEAD')) return sendFile(req, res, file, entry)
    return reply(404, { 'Content-Type': 'text/plain' }, 'Not Found')
  }
  return reply(404, { 'Content-Type': 'text/plain' }, 'Not Found')
}

const tlsServer = createTlsServer({ cert: readFileSync(args.cert), key: readFileSync(args.key) }, handle)
tlsServer.on('tlsClientError', (err) => log({ method: 'TLS', host: null, path: null, status: 0, error: err.message }))

const proxy = createServer((req, res) => {
  // Requests to the proxy itself: control. Anything else over plain HTTP is refused.
  const url = new URL(req.url ?? '/', 'http://proxy')
  if (url.pathname === '/__control/latest' && url.searchParams.get('tag')) {
    latest = url.searchParams.get('tag')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(latest)
  }
  if (url.pathname === '/__control/requests')
    return res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(requests.map((r) => JSON.stringify(r)).join('\n'))
  log({ method: req.method, host: url.host || null, path: url.pathname, status: 403, refused: true })
  res.writeHead(403).end()
})

proxy.on('connect', (req, socket, head) => {
  const [host, port] = (req.url ?? '').split(':')
  if (!HOSTS.has(host) || (port && port !== '443')) {
    log({ method: 'CONNECT', host: req.url, path: null, status: 403, refused: true })
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head?.length) socket.unshift(head)
  tlsServer.emit('connection', socket)
})

proxy.listen(Number(args.port ?? 0), '127.0.0.1', () => {
  const port = proxy.address().port
  if (args.ready) writeFileSync(args.ready, String(port))
  console.log(`listening ${port}`)
})

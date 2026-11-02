// The globe's image service, in the shape of Bluesky's (cdn.bsky.app): an app's image link names
// an account and a blob, and this finds which account server holds the account and serves the
// blob from there. Apps keep their usual template, pointed here:
//
//   https://cdn.<globe>/img/<preset>/plain/<did>/<cid>@<format>
//
// The preset and format are accepted and ignored: the blob comes back as stored, with the type
// its server gives it. Images only, as Bluesky's (its videos have a service of their own). Settings:
//
//   CDN_PLC_URL       the globe's directory, for did:plc (e.g. http://plc:2582)
//   CDN_DOMAIN        the globe's domain; a did:web or an account server outside it is refused, and
//                     no redirect is followed, so the service never fetches from outside the globe
//   CDN_UPSTREAM      host:port to connect to for every name under the domain, ignoring DNS (a local
//                     snowglobe's nginx, which answers them all); unset, names resolve as usual
//   CDN_BIND          host:port to listen on (default 0.0.0.0:8080)
//   CDN_MAX_BYTES     the largest blob served (default 10 MiB)
// A fetch verifies TLS against the system's CAs plus NODE_EXTRA_CA_CERTS (a snowglobe's CA).
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'

const PLC_URL = (process.env.CDN_PLC_URL ?? '').replace(/\/+$/, '')
const DOMAIN = (process.env.CDN_DOMAIN ?? '').toLowerCase()
const [BIND_HOST, BIND_PORT] = (process.env.CDN_BIND ?? '0.0.0.0:8080').split(':')
const [UP_HOST, UP_PORT] = (process.env.CDN_UPSTREAM ?? '').split(':')
const MAX_BYTES = Number(process.env.CDN_MAX_BYTES ?? 10 * 1024 * 1024)
const DOC_MAX_BYTES = 64 * 1024
const FETCH_MS = 10_000

// A did:web is a host, its port if any as %3A<port>, then path segments, each after a colon.
const PATH =
  /^\/img\/[a-z_]+\/plain\/(did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+(?:%3[aA][0-9]{1,5})?(?::[a-zA-Z0-9._-]+)*))\/(b[a-z2-7]{20,100})(?:@[a-z]+)?$/

/** Whether `host` is the globe's domain or a name under it. */
export const inGlobe = (host, domain = DOMAIN) => {
  const h = String(host).toLowerCase()
  return Boolean(domain) && /^[a-z0-9.-]+$/.test(h) && (h === domain || h.endsWith(`.${domain}`))
}

/** The did and cid an image path names, or null. */
export function parseImagePath(pathname) {
  const m = PATH.exec(pathname)
  return m ? { did: m[1], cid: m[2] } : null
}

/** Where a did:web's document is, as the did:web method says: { host, url }. */
export function didWebDocument(did) {
  const [authority, ...path] = did.slice('did:web:'.length).split(':')
  const hostPort = decodeURIComponent(authority).toLowerCase()
  return {
    host: hostPort.split(':')[0],
    url: `https://${hostPort}/${path.length ? path.join('/') : '.well-known'}/did.json`,
  }
}

/**
 * GET `url`, answered with the response before its body is read. No redirect is followed. A name
 * under the domain is connected to CDN_UPSTREAM, when it is set, whatever it resolves to.
 */
export function get(url) {
  const u = new URL(url)
  const tls = u.protocol === 'https:'
  const upstream = Boolean(UP_HOST) && tls && inGlobe(u.hostname)
  return new Promise((resolve, reject) => {
    const req = (tls ? https : http).get(
      {
        host: u.hostname,
        port: upstream ? Number(UP_PORT) : u.port || undefined,
        path: `${u.pathname}${u.search}`,
        headers: { host: u.host, 'user-agent': 'snowglobe-cdn/1' },
        timeout: FETCH_MS,
        ...(tls ? { servername: u.hostname } : {}),
        ...(upstream ? { lookup: (_name, opts, cb) => dns.lookup(UP_HOST, opts, cb) } : {}),
      },
      resolve,
    )
    req.on('timeout', () => req.destroy(new Error(`${u.host} timed out`)))
    req.on('error', reject)
  })
}

/** A response's body, or null once it passes `max` bytes (the rest is not read). */
export async function readBody(res, max) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > max) {
      res.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const pdsCache = new Map() // did -> { url, at }
const PDS_TTL_MS = 10 * 60 * 1000

async function pdsOf(did) {
  const hit = pdsCache.get(did)
  if (hit && Date.now() - hit.at < PDS_TTL_MS) return hit.url
  let docUrl
  if (did.startsWith('did:plc:')) docUrl = `${PLC_URL}/${did}`
  else {
    const web = didWebDocument(did)
    if (!inGlobe(web.host)) return null
    docUrl = web.url
  }
  const res = await get(docUrl)
  if (res.statusCode !== 200) {
    res.destroy()
    return null
  }
  const text = await readBody(res, DOC_MAX_BYTES)
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const services = Array.isArray(doc?.service) ? doc.service : []
  const svc = services.find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)
  let url
  try {
    url = new URL(svc?.serviceEndpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !inGlobe(url.hostname)) return null
  pdsCache.set(did, { url: url.origin, at: Date.now() })
  return url.origin
}

const ABOUT = () =>
  `The image service for ${DOMAIN}, in the shape of Bluesky's (cdn.bsky.app):\n\n  /img/<preset>/plain/<did>/<cid>@<format>\n`

async function serve(req, res) {
  const { pathname } = new URL(req.url, 'http://cdn')
  if (pathname === '/_health') return res.writeHead(200).end('ok')
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end()
  if (pathname === '/') return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(ABOUT())
  const named = parseImagePath(pathname)
  if (!named) return res.writeHead(404).end('not an image path')
  const pds = await pdsOf(named.did)
  if (!pds) return res.writeHead(404).end('no account server in this network for that account')
  const blob = await get(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(named.did)}&cid=${named.cid}`)
  const refuse = (status, text) => {
    blob.destroy()
    res.writeHead(status).end(text)
  }
  if (blob.statusCode !== 200) return refuse(blob.statusCode === 400 || blob.statusCode === 404 ? 404 : 502, 'blob not found')
  const type = blob.headers['content-type'] ?? 'application/octet-stream'
  if (!type.startsWith('image/')) return refuse(404, 'not an image')
  const declared = blob.headers['content-length'] ? Number(blob.headers['content-length']) : NaN
  const length = Number.isSafeInteger(declared) ? declared : null
  if (length !== null && length > MAX_BYTES) return refuse(413, 'too large')
  const head = {
    'content-type': type,
    // A blob's CID is its content, so the answer for a path never changes.
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  }
  if (req.method === 'HEAD') {
    blob.destroy()
    return res.writeHead(200, length === null ? head : { ...head, 'content-length': length }).end()
  }
  // Its size is known and allowed: passed on as it comes.
  if (length !== null) {
    res.writeHead(200, { ...head, 'content-length': length })
    return pipeline(blob, res)
  }
  const bytes = await readBody(blob, MAX_BYTES)
  if (!bytes) return res.writeHead(413).end('too large')
  res.writeHead(200, { ...head, 'content-length': bytes.length }).end(bytes)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!PLC_URL || !DOMAIN) throw new Error('set CDN_PLC_URL and CDN_DOMAIN')
  if (UP_HOST && !Number(UP_PORT)) throw new Error('CDN_UPSTREAM is host:port')
  http
    .createServer((req, res) =>
      serve(req, res).catch((err) => {
        console.error('cdn:', req.url, err.message)
        if (!res.headersSent) res.writeHead(502).end('upstream failed')
        else res.destroy()
      }),
    )
    .listen(Number(BIND_PORT), BIND_HOST, () => console.log(`cdn: listening on ${BIND_HOST}:${BIND_PORT} for ${DOMAIN}`))
}

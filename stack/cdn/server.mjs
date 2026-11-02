// The globe's image service, in the shape of Bluesky's (cdn.bsky.app): an app's image link names
// an account and a blob, and this finds which account server holds the account and serves the
// blob from there. Apps keep their usual template, pointed here:
//
//   https://cdn.<globe>/img/<preset>/plain/<did>/<cid>@<format>
//
// The preset and format are accepted and ignored: the blob comes back as stored, with the type
// its server gives it. Settings:
//
//   CDN_PLC_URL       the globe's directory, for did:plc (e.g. http://plc:2582)
//   CDN_DOMAIN        the globe's domain; a did:web or an account server outside it is refused,
//                     so the service never fetches from outside the globe
//   CDN_BIND          host:port to listen on (default 0.0.0.0:8080)
//   CDN_MAX_BYTES     the largest blob served (default 10 MiB)
import http from 'node:http'

const PLC_URL = (process.env.CDN_PLC_URL ?? '').replace(/\/+$/, '')
const DOMAIN = (process.env.CDN_DOMAIN ?? '').toLowerCase()
const [BIND_HOST, BIND_PORT] = (process.env.CDN_BIND ?? '0.0.0.0:8080').split(':')
const MAX_BYTES = Number(process.env.CDN_MAX_BYTES ?? 10 * 1024 * 1024)
const FETCH_MS = 10_000

const PATH = /^\/img\/[a-z_]+\/plain\/(did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:-]+))\/(b[a-z2-7]{20,100})(?:@[a-z]+)?$/

/** Whether `host` is the globe's domain or a name under it. */
export const inGlobe = (host, domain = DOMAIN) => host === domain || host.endsWith(`.${domain}`)

/** The did and cid an image path names, or null. */
export function parseImagePath(pathname) {
  const m = PATH.exec(pathname)
  return m ? { did: m[1], cid: m[2] } : null
}

const pdsCache = new Map() // did -> { url, at }
const PDS_TTL_MS = 10 * 60 * 1000

async function pdsOf(did) {
  const hit = pdsCache.get(did)
  if (hit && Date.now() - hit.at < PDS_TTL_MS) return hit.url
  let docUrl
  if (did.startsWith('did:plc:')) docUrl = `${PLC_URL}/${did}`
  else {
    const host = decodeURIComponent(did.slice('did:web:'.length)).toLowerCase()
    if (!inGlobe(host.split(':')[0])) return null
    docUrl = `https://${host}/.well-known/did.json`
  }
  const res = await fetch(docUrl, { signal: AbortSignal.timeout(FETCH_MS) })
  if (!res.ok) return null
  const doc = await res.json()
  const svc = (doc.service ?? []).find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)
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

async function serve(req, res) {
  const { pathname } = new URL(req.url, 'http://cdn')
  if (pathname === '/_health') return res.writeHead(200).end('ok')
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end()
  const named = parseImagePath(pathname)
  if (!named) return res.writeHead(404).end('not an image path')
  const pds = await pdsOf(named.did)
  if (!pds) return res.writeHead(404).end('no account server in this network for that account')
  const blob = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(named.did)}&cid=${named.cid}`, {
    signal: AbortSignal.timeout(FETCH_MS),
  })
  if (!blob.ok) return res.writeHead(blob.status === 400 || blob.status === 404 ? 404 : 502).end('blob not found')
  const type = blob.headers.get('content-type') ?? 'application/octet-stream'
  if (!type.startsWith('image/') && !type.startsWith('video/')) return res.writeHead(404).end('not an image')
  const bytes = Buffer.from(await blob.arrayBuffer())
  if (bytes.length > MAX_BYTES) return res.writeHead(413).end('too large')
  res.writeHead(200, {
    'content-type': type,
    'content-length': bytes.length,
    // A blob's CID is its content, so the answer for a path never changes.
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!PLC_URL || !DOMAIN) throw new Error('set CDN_PLC_URL and CDN_DOMAIN')
  http
    .createServer((req, res) =>
      serve(req, res).catch((err) => {
        console.error('cdn:', req.url, err.message)
        if (!res.headersSent) res.writeHead(502).end('upstream failed')
      }),
    )
    .listen(Number(BIND_PORT), BIND_HOST, () => console.log(`cdn: listening on ${BIND_HOST}:${BIND_PORT} for ${DOMAIN}`))
}

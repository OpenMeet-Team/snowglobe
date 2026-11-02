// The image service (stack/cdn/server.mjs): which paths it answers and which names it trusts. No
// Docker needed. Run them alone with `npx vitest run snowglobe-cdn`.
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
// @ts-expect-error: a plain .mjs module, without types
import { didWebDocument, get, inGlobe, parseImagePath, readBody } from '../stack/cdn/server.mjs';

describe('the image service', () => {
  const did = 'did:plc:yevuuwb2m57fpp3hlrhddc2k';
  const cid = 'bafkreibfqzoaylwpoatvvjihojadbwhs6nq4yw6ehii7jhgnykqa7lsime';

  it('reads the did and cid from a Bluesky-shaped image path', () => {
    expect(parseImagePath(`/img/feed_thumbnail/plain/${did}/${cid}@webp`)).toEqual({ did, cid });
    expect(parseImagePath(`/img/avatar/plain/${did}/${cid}`)).toEqual({ did, cid });
  });

  it('refuses anything else', () => {
    for (const p of ['/', '/img/x/plain/did:plc:short/bafk', `/img/x/plain/${did}/../etc`, '/xrpc/com.atproto.sync.getBlob'])
      expect(parseImagePath(p), p).toBeNull();
  });

  it('takes a name as in the globe only under its domain', () => {
    expect(inGlobe('alpha.mine.local.snowglobe.at', 'mine.local.snowglobe.at')).toBe(true);
    expect(inGlobe('mine.local.snowglobe.at', 'mine.local.snowglobe.at')).toBe(true);
    expect(inGlobe('evil-mine.local.snowglobe.at', 'mine.local.snowglobe.at')).toBe(false);
    expect(inGlobe('bsky.social', 'mine.local.snowglobe.at')).toBe(false);
    // With no domain set nothing is in it, and a name is only ever a hostname.
    expect(inGlobe('', '')).toBe(false);
    expect(inGlobe('a b.mine.test', 'mine.test')).toBe(false);
    expect(inGlobe('x.mine.test/..', 'mine.test')).toBe(false);
  });

  it('reads a did:web as the did:web method writes it: a host, a %3A port, then path segments', () => {
    for (const web of ['did:web:alpha.mine.test', 'did:web:alpha.mine.test%3A8443', 'did:web:alpha.mine.test:user:bob'])
      expect(parseImagePath(`/img/avatar/plain/${web}/${cid}@jpeg`), web).toEqual({ did: web, cid });
    expect(didWebDocument('did:web:alpha.mine.test')).toEqual({ host: 'alpha.mine.test', url: 'https://alpha.mine.test/.well-known/did.json' });
    expect(didWebDocument('did:web:alpha.mine.test%3A8443')).toEqual({ host: 'alpha.mine.test', url: 'https://alpha.mine.test:8443/.well-known/did.json' });
    expect(didWebDocument('did:web:alpha.mine.test:user:bob')).toEqual({ host: 'alpha.mine.test', url: 'https://alpha.mine.test/user/bob/did.json' });
    // A port is digits only, so nothing else can ride in on a %-escape.
    expect(parseImagePath(`/img/avatar/plain/did:web:alpha.mine.test%2Fx/${cid}`)).toBeNull();
  });
});

describe('the image service fetching', () => {
  // A server that answers every request with what `answer` writes; closed after the test.
  async function serving(answer: http.RequestListener) {
    const server = http.createServer(answer);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  it('follows no redirect, so a host in the globe cannot send it elsewhere', async () => {
    let followed = false;
    const target = await serving((_req, res) => {
      followed = true;
      res.end('{}');
    });
    const redirect = await serving((_req, res) => res.writeHead(302, { location: `${target.url}/elsewhere` }).end());
    try {
      const res = await get(`${redirect.url}/.well-known/did.json`);
      res.resume();
      expect(res.statusCode).toBe(302);
      expect(followed).toBe(false);
    } finally {
      target.close();
      redirect.close();
    }
  });

  it('stops reading a body once it passes the limit', async () => {
    const big = await serving((_req, res) => {
      res.write(Buffer.alloc(64 * 1024));
      res.end(Buffer.alloc(64 * 1024));
    });
    try {
      expect(await readBody(await get(big.url), 1024)).toBeNull();
      expect((await readBody(await get(big.url), 1024 * 1024)).length).toBe(128 * 1024);
    } finally {
      big.close();
    }
  });
});

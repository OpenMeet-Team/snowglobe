// The image service (stack/cdn/server.mjs): which paths it answers and which names it trusts. No
// Docker needed. Run them alone with `npx vitest run snowglobe-cdn`.
import { describe, it, expect } from 'vitest';
// @ts-expect-error: a plain .mjs module, without types
import { inGlobe, parseImagePath } from '../stack/cdn/server.mjs';

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
  });
});

// snowglobe check needs no Docker: it reads a snowglobe.yml and says what is wrong with it.
// Run it alone with `npx vitest run snowglobe-check`.
//
// Each case asserts WHERE the error points (the part before the first ': '), not its wording,
// so a reworded message does not break a test and a removed rule does.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { checkGlobe, loadGlobe } from '../lib/config.mjs';

const ROOT = join(__dirname, '..');
const FIXTURES = join(__dirname, 'snowglobe');

function check(...args: string[]) {
  const r = spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), 'check', ...args], { encoding: 'utf8', cwd: FIXTURES });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The locations a list of errors points at.
const wheres = (errors: string[]) => errors.map((e) => e.split(': ')[0]);
const whereOf = (doc: unknown, opts?: object) => wheres(checkGlobe(doc, opts).errors);

// A file's text, written to a fresh folder, then loaded the way the CLI loads it.
function loadText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'snowglobe-'));
  writeFileSync(join(dir, 'snowglobe.yml'), text);
  return loadGlobe(join(dir, 'snowglobe.yml'));
}

const PDS_A = { name: 'alpha', image: 'spaces-alpha' };
const PDS_B = { name: 'beta', image: 'ghcr.io/bluesky-social/pds:0.4.5037' };
const BARE_A = { ...PDS_A, bare_handles: true };
const ok = (extra: object = {}) => ({ globe: 'mine', pds: [PDS_A], ...extra });

describe('snowglobe check', () => {
  it('passes the atmo example globe, with three PDSes', () => {
    const r = check(join(ROOT, 'docs/examples/atmo.yml'));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('PDSs alpha regular prod');
  });

  it('uses the default globe when there is no snowglobe.yml', () => {
    const r = check();
    expect(r.code).toBe(0);
    expect(r.out).toContain('snowglobe.default.yml: ok');
    expect(r.out).toContain('PDSs main');
  });

  it('passes a file that uses every setting', () => {
    const r = check('full.yml');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it.each([
    ['no-pds.yml', 'pds'],
    ['duplicate-pds.yml', 'pds[1].name'],
    ['pds-grouphost-clash.yml', 'grouphosts[0].name'],
    ['two-bare.yml', 'pds'],
    ['authority-unlisted.yml', 'lexicons.authority'],
    ['latest-image.yml', 'pds[0].image'],
    ['bad-label.yml', 'pds[0].name'],
  ])('fails %s at %s, one line per problem', (file, where) => {
    const r = check(file);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n').map((l) => l.split(': ').slice(0, 2).join(': '))).toEqual([`${file}: ${where}`]);
  });

  it('fails a file that is not there', () => {
    expect(check('missing.yml').code).toBe(1);
  });

  it('fails a file that is not YAML, or not a map', () => {
    expect(loadText('globe: [unclosed\n').errors).toHaveLength(1);
    expect(loadText('- a list\n').errors).toHaveLength(1);
    expect(loadText('').errors).toHaveLength(1);
    expect(loadText('globe: a\nglobe: b\npds: []\n').errors).toHaveLength(1); // a key twice
  });

  it('fails an unknown command', () => {
    const r = spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), 'frobnicate'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('the rules behind the check', () => {
  it('fills in the defaults', () => {
    const { globe, errors } = checkGlobe(ok());
    expect(errors).toEqual([]);
    // A domain of its own, so the name router tells it from every other snowglobe.
    expect(globe.domain).toBe('mine.local.snowglobe.at');
    expect(checkGlobe(ok({ domain: 'local.snowglobe.at' })).globe.domain).toBe('local.snowglobe.at');
    expect(globe.pds[0].image).toContain('@sha256:');
    expect(globe.pds[0].invites).toBe('open');
    expect(globe.services.relay).toBe(true); // one PDS, but Jetstream reads a relay
    expect(globe.lexicons.authority).toBe('alpha');
  });

  it('checks the globe and domain names', () => {
    expect(whereOf({ pds: [PDS_A] })).toEqual(['globe']);
    expect(whereOf(ok({ globe: 'Mine' }))).toEqual(['globe']);
    expect(whereOf(ok({ globe: 'a'.repeat(32) }))).toEqual(['globe']);
    expect(whereOf(ok({ domain: 'nodot' }))).toEqual(['domain']);
    expect(whereOf(ok({ domain: `x.${'a'.repeat(64)}` }))).toEqual(['domain']); // a label over 63
    expect(whereOf(ok({ domain: `${'a'.repeat(63)}.`.repeat(4) + 'test' }))).toEqual(['domain']); // over 253
    expect(whereOf(ok({ domain: 'mine.test' }))).toEqual([]);
  });

  it('keeps the domain clear of the names the network serves whatever the domain', () => {
    for (const domain of ['plc.directory'])
      expect(whereOf(ok({ domain })), domain).toEqual(['domain']);
    expect(whereOf(ok({ domain: 'team.plc.directory' }))).toEqual([]); // plc.directory is one exact name
  });

  it('keeps app for the network: a PDS, group host or bare handle named app is refused', () => {
    expect(whereOf(ok({ pds: [{ ...PDS_A, name: 'app' }] }))).toEqual(['pds[0].name']);
    expect(whereOf(ok({ pds: [{ ...PDS_A, bare_handles: true }], accounts: ['app@alpha'] }))).toEqual(['accounts[0]']);
  });

  it('reports a domain that is not a string, without building names on it', () => {
    expect(whereOf(ok({ domain: { toString: 'typo' }, pds: [{ ...PDS_A, bare_handles: true }], accounts: ['alice@alpha'] }))).toEqual(['domain']);
  });

  it('turns the relay on with more than one PDS, and refuses it off', () => {
    expect(checkGlobe({ globe: 'mine', pds: [PDS_A, PDS_B] }).globe.services.relay).toBe(true);
    expect(whereOf({ globe: 'mine', pds: [PDS_A, PDS_B], services: { relay: false } })).toEqual(['services.relay']);
  });

  it('runs Jetstream only with the relay, and the relay without Jetstream only when asked', () => {
    expect(whereOf(ok({ services: { relay: false } }))).toEqual(['services.jetstream']);
    expect(whereOf(ok({ services: { relay: false, jetstream: false, slingshot: false } }))).toEqual([]);
    expect(checkGlobe(ok({ services: { jetstream: false, slingshot: false } })).globe.services.relay).toBe(false);
  });

  it('runs Slingshot only with Jetstream', () => {
    expect(whereOf(ok({ services: { jetstream: false, slingshot: true } }))).toEqual(['services.slingshot']);
    expect(whereOf(ok({ services: { jetstream: false, slingshot: false } }))).toEqual([]);
  });

  it('takes true or false for a service, and auto only for the relay', () => {
    expect(whereOf(ok({ services: { tap: 'yes', relay: 'auto', jetstream: 'auto' } }))).toEqual(['services.jetstream', 'services.tap']);
  });

  it('keeps the network\'s own names and services for the network', () => {
    for (const name of ['relay', 'nginx', 'postgres', 'maildev', 'proxy', 'init', 'relay-init', 'slingshot-dns', 'pds', 'sync']) {
      expect(whereOf(ok({ pds: [{ ...PDS_A, name }] })), name).toEqual(['pds[0].name']);
      expect(whereOf(ok({ grouphosts: [{ name, kind: 'opensocial' }] })), name).toEqual(['grouphosts[0].name']);
    }
  });

  it('refuses a bare handle that is another server\'s address, an app\'s handle ending, or the network\'s', () => {
    expect(whereOf({ globe: 'mine', pds: [BARE_A, PDS_B], accounts: ['beta@alpha', 'carol@beta'] })).toEqual(['accounts[0]']);
    expect(whereOf({ globe: 'mine', pds: [BARE_A], accounts: ['ev@alpha'], apps: [{ name: 'atmo', local: { port: 5173, handles: 'ev' } }] })).toEqual(['accounts[0]']);
    expect(whereOf({ globe: 'mine', pds: [BARE_A], accounts: ['tap@alpha'] })).toEqual(['accounts[0]']);
  });

  it('keeps the lexicon authority\'s account for the authority, bare or not', () => {
    expect(whereOf({ globe: 'mine', pds: [PDS_A], accounts: ['lex-authority@alpha'] })).toEqual(['accounts[0]']);
    expect(whereOf({ globe: 'mine', pds: [BARE_A], accounts: ['lex-authority@alpha'] })).toContain('accounts[0]');
  });

  it('names the handle each account gets, and refuses one listed twice', () => {
    const { globe } = checkGlobe({ globe: 'mine', pds: [BARE_A, PDS_B], accounts: ['alice@alpha', 'bob@beta'] });
    expect(globe.accounts.map((a: { handle: string }) => a.handle)).toEqual(['alice.mine.local.snowglobe.at', 'bob.beta.mine.local.snowglobe.at']);
    expect(whereOf({ globe: 'mine', pds: [BARE_A, PDS_B], accounts: ['bob@beta', 'bob@beta', 'carol@alpha'] })).toEqual(['accounts[1]']);
  });

  it('refuses an account that is not <name>@<pds>, or names no PDS here', () => {
    expect(whereOf(ok({ accounts: ['alice', 'alice@nope', 'Al.ice@alpha', 7] }))).toEqual(['accounts[0]', 'accounts[1]', 'accounts[2]', 'accounts[3]']);
  });

  describe('refuses a name longer than DNS allows (253)', () => {
    // A domain of n characters, in labels DNS allows.
    const domainOf = (n: number) => `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(n - 192)}`;

    it('a server\'s name, and the network\'s own', () => {
      // 249: alpha.<domain> is 255 and lex-authority.<domain> is 263.
      expect(whereOf({ globe: 'mine', domain: domainOf(249), pds: [PDS_A] })).toEqual(['domain', 'pds[0].name', 'lexicons.authority']);
      // 240: alpha.<domain> fits; lex-authority.<domain>, the longest of the network's names, is 254.
      expect(whereOf({ globe: 'mine', domain: domainOf(240), pds: [PDS_A] })).toEqual(['domain', 'lexicons.authority']);
    });

    it('the lexicon authority\'s handle', () => {
      // 236: lex-authority.<domain> is 250, but lex-authority.alpha.<domain> is 256.
      expect(whereOf({ globe: 'mine', domain: domainOf(236), pds: [PDS_A] })).toEqual(['lexicons.authority']);
      expect(whereOf({ globe: 'mine', domain: domainOf(236), pds: [BARE_A] })).toEqual([]);
    });

    it('an account\'s handle', () => {
      // 196: every server fits; a 63-letter name on alpha is 266.
      expect(whereOf({ globe: 'mine', domain: domainOf(196), pds: [PDS_A], accounts: [`${'x'.repeat(63)}@alpha`] })).toEqual(['accounts[0]']);
      expect(whereOf({ globe: 'mine', domain: domainOf(196), pds: [PDS_A], accounts: ['alice@alpha'] })).toEqual([]);
    });
  });

  it('takes open or required invites, and true or false for bare handles', () => {
    expect(whereOf(ok({ pds: [{ ...PDS_A, invites: 'closed' }] }))).toEqual(['pds[0].invites']);
    expect(whereOf(ok({ pds: [{ ...PDS_A, bare_handles: 'yes' }] }))).toEqual(['pds[0].bare_handles']);
  });

  it.each([
    ['ghcr.io/bluesky-social/pds:0.4.5037', true],
    ['ghcr.io/bluesky-social/pds@sha256:' + 'a'.repeat(64), true],
    ['pds:v1@sha256:' + 'a'.repeat(64), true],
    ['localhost:5000/pds:1', true],
    ['host:5000/pds:1', true],
    ['[2001:db8::1]:5000/pds:1', true],
    ['REGISTRY/pds:1', true], // an uppercase first component is a registry
    ['pds@sha512:' + 'a'.repeat(128), true],
    ['pds:' + 't'.repeat(128), true],
    ['ghcr.io/bluesky-social/pds', false], // no tag: it moves
    ['pds:latest', false],
    ['host:5000/pds', false],
    ['pds:v1@sha256:bad', false],
    ['pds@sha256:', false],
    ['PDS:v1', false],
    ['ghcr.io/Org/pds:v1', false],
    ['pds:' + 't'.repeat(129), false],
    ['pds:.v1', false],
    ['pds@sha512:' + 'a'.repeat(64), false],
    ['example.com/' + 'a'.repeat(256) + ':1', false], // a name over 255
    ['pds:bad tag', false],
    ['constructor', false], // not a short name, though every object has one
    ['', false],
  ])('image %j is pinned and well formed: %s', (image, good) => {
    expect(whereOf(ok({ pds: [{ ...PDS_A, image }] }))).toEqual(good ? [] : ['pds[0].image']);
  });

  it('knows its group host kinds, by their own name only', () => {
    for (const kind of ['other', 'constructor', ['opensocial'], { toString: 'typo' }, undefined])
      expect(whereOf(ok({ grouphosts: [{ name: 'gh', kind }] })), JSON.stringify(kind)).toEqual(['grouphosts[0].kind']);
    expect(whereOf(ok({ grouphosts: [{ name: 'gh', kind: 'opensocial' }] }))).toEqual([]);
  });

  it('takes a group host\'s image or its build folder, a folder with a Dockerfile beside the file, not both', () => {
    const gh = (extra: object) => ok({ grouphosts: [{ name: 'gh', kind: 'opensocial', ...extra }] });
    expect(whereOf(gh({ build: 'grouphost-build' }), { baseDir: FIXTURES })).toEqual([]);
    expect(checkGlobe(gh({ build: 'grouphost-build' }), { baseDir: FIXTURES }).globe.grouphosts[0].build).toBe(join(FIXTURES, 'grouphost-build'));
    expect(whereOf(gh({ build: 'nope' }), { baseDir: FIXTURES })).toEqual(['grouphosts[0].build']);
    expect(whereOf(gh({ build: 'apps' }), { baseDir: FIXTURES })).toEqual(['grouphosts[0].build']); // no Dockerfile
    expect(whereOf(gh({ build: 1 }))).toEqual(['grouphosts[0].build']);
    expect(whereOf(gh({ build: 'grouphost-build', image: 'ghcr.io/example/gh:1' }), { baseDir: FIXTURES })).toEqual(['grouphosts[0]']);
  });

  it('refuses an unknown setting at every level', () => {
    const found = whereOf(
      ok({
        sevices: {},
        pds: [{ ...PDS_A, imag: 'x' }],
        grouphosts: [{ name: 'gh', kind: 'opensocial', knd: 1 }],
        services: { relai: true },
        lexicons: { authorty: 'alpha' },
        apps: [{ name: 'atmo', locl: {}, local: { port: 1, handle: 'ev' }, hosted: { service: 'atmo:8080', lnk: 'x' } }],
        hosted: { region: 'us-east-1' },
      }),
    );
    const expected = ['sevices', 'pds[0].imag', 'grouphosts[0].knd', 'services.relai', 'lexicons.authorty', 'apps[0].locl', 'apps[0].local.handle', 'apps[0].hosted.lnk', 'hosted.region'];
    expect(found.sort()).toEqual(expected.sort());
  });

  it('refuses a YAML ordered map or set, whose entries it could not read', () => {
    const omap = loadText('globe: mine\npds: [{name: alpha, image: spaces-alpha}]\nservices: !!omap\n  - tap: false\n  - relai: false\n');
    expect(wheres(omap.errors)).toEqual(['services']);
    const set = loadText('globe: mine\npds: [{name: alpha, image: spaces-alpha}]\nlexicons: !!set {authority}\n');
    expect(wheres(set.errors)).toEqual(['lexicons']);
  });

  it('reports a value that contains itself, or a map where a name goes, instead of crashing', () => {
    expect(wheres(loadText('globe: &self [*self]\npds: [{name: alpha, image: spaces-alpha}]\n').errors)).toEqual(['globe']);
    expect(whereOf(ok({ pds: [{ name: { toString: 'x' }, image: 'spaces-alpha' }], lexicons: { authority: 'nope' } }))).toEqual(['pds[0].name', 'lexicons.authority']);
  });

  it('needs the lexicons to publish to be a folder beside the file', () => {
    expect(whereOf(ok({ lexicons: { publish: './nope' } }), { baseDir: FIXTURES })).toEqual(['lexicons.publish']);
    expect(whereOf(ok({ lexicons: { publish: 'full.yml' } }), { baseDir: FIXTURES })).toEqual(['lexicons.publish']);
    expect(whereOf(ok({ lexicons: { publish: '.' } }), { baseDir: FIXTURES })).toEqual([]);
  });

  it('checks each app: a port, a name once, a handle ending no one else has', () => {
    const app = (local: object) => ({ name: 'atmo', local });
    expect(whereOf(ok({ apps: [app({ port: 0 })] }))).toEqual(['apps[0].local.port']);
    expect(whereOf(ok({ apps: [app({ port: 65536 })] }))).toEqual(['apps[0].local.port']);
    expect(whereOf(ok({ apps: [app({ port: '5173' })] }))).toEqual(['apps[0].local.port']);
    expect(whereOf(ok({ apps: [app({ port: 1 }), app({ port: 2 })] }))).toEqual(['apps[1].name']);
    expect(whereOf(ok({ apps: [app({ port: 1, handles: 'alpha' })] }))).toEqual(['apps[0].local.handles']);
    expect(whereOf(ok({ apps: [{ name: 'atmo', hosted: { service: 'atmo', link: 'http://x' } }] }))).toEqual(['apps[0].hosted.service', 'apps[0].hosted.link']);
    for (const service of ['atmo:0', 'atmo:65536', 'atmo:123456'])
      expect(whereOf(ok({ apps: [{ name: 'atmo', hosted: { service } }] })), service).toEqual(['apps[0].hosted.service']);
    expect(whereOf(ok({ apps: [{ name: 'atmo', hosted: { service: 'atmo:65535' } }] }))).toEqual([]);
  });
});

describe('services.tap as a map', () => {
  const tap = (t: object) => ok({ services: { tap: t } });
  it('takes a webhook and a signal collection, and follows that collection alone by default', () => {
    const { globe, errors } = checkGlobe(tap({ webhook: 'https://app.test/hook', signal_collection: 'xyz.statusphere.status' }));
    expect(errors).toEqual([]);
    expect(globe.services.tap).toBe(true);
    expect(globe.tap).toEqual({ webhook: 'https://app.test/hook', signal_collection: 'xyz.statusphere.status', collection_filters: ['xyz.statusphere.status'] });
  });

  it('has no settings for plain true, and none for false', () => {
    expect(checkGlobe(ok({ services: { tap: true } })).globe.tap).toBeNull();
    expect(checkGlobe(ok({ services: { tap: false } })).globe.services.tap).toBe(false);
  });

  it('names the setting that is wrong', () => {
    expect(whereOf(tap({ webhook: 5 }))).toEqual(['services.tap.webhook']);
    expect(whereOf(tap({ signal_collection: 'status' }))).toEqual(['services.tap.signal_collection']);
    expect(whereOf(tap({ collection_filters: 'xyz.a.b' }))).toEqual(['services.tap.collection_filters']);
    expect(whereOf(tap({ hook: 'x' }))).toEqual(['services.tap.hook']);
  });

  it('checks the names in the webhook against the file', () => {
    expect(whereOf(tap({ webhook: '${apps.nope.url}/hook' }))).toEqual(['services.tap.webhook']);
    expect(whereOf(tap({ webhook: '${accounts.alice.did}' }))).toEqual(['services.tap.webhook']);
    expect(whereOf({ ...tap({ webhook: '${apps.web.url}/hook' }), apps: [{ name: 'web', local: { port: 3000 } }] })).toEqual([]);
  });
});

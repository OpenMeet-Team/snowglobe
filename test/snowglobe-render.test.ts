// snowglobe render needs no Docker to write the globe's files; one case asks `docker compose
// config` to read the result, and is skipped where there is no docker. Run them alone with
// `npx vitest run snowglobe-render`.
//
// The default globe's files are compared whole with test/snowglobe/rendered/, so any change to
// what the generator writes shows up in review. After an intended change, write them again with
// SG_WRITE_RENDERED=1 npx vitest run snowglobe-render, and read the diff.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
// @ts-expect-error: a plain .mjs module, without types
import { checkGlobe, loadGlobe, withGroupHostSources } from '../lib/config.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { contextHash, loadBase, renderGlobe } from '../lib/render.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { SECRETS } from '../lib/env.mjs';

// compose refuses to read the file without the secrets up makes.
const SECRET_ENV = Object.fromEntries(Object.keys(SECRETS).map((n) => [n, 'x']));

const ROOT = join(__dirname, '..');
const RENDERED = join(__dirname, 'snowglobe', 'rendered');
// Where the fixtures say a snowglobe's state is, the same on every machine.
const STATE = '/state/snowglobe/snowglobe';
const base = loadBase(ROOT);
// The CLI claims a globe's state folder by name, so the cases that run it keep that folder in their
// own temp dir, not the user's ~/.local/share/snowglobe.
const inDir = (dir: string, env: Record<string, string | undefined> = process.env) => ({ ...env, XDG_DATA_HOME: join(dir, 'xdg') });

function render(doc: object) {
  const { globe, errors } = checkGlobe(doc);
  expect(errors).toEqual([]);
  const files: Record<string, string> = renderGlobe(globe, base, { stateDir: STATE });
  return { files, compose: parse(files['compose.yml']), env: envOf(files['globe.env']) };
}
const envOf = (text: string) =>
  Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const PDS = (name: string, extra: object = {}) => ({ name, image: 'ghcr.io/bluesky-social/pds:0.4.5037', ...extra });
const THREE = { globe: 'mine', domain: 'mine.test', pds: [PDS('alpha', { bare_handles: true }), PDS('regular'), PDS('prod')] };
const FOUR = { ...THREE, pds: [...THREE.pds, PDS('beta')] };

describe('snowglobe render', () => {
  it('renders the default globe as one PDS, the PLC, the relay Jetstream reads, Jetstream, Slingshot and PDSls', () => {
    const { globe, errors } = loadGlobe(join(ROOT, 'snowglobe.default.yml'));
    expect(errors).toEqual([]);
    const compose = renderGlobe(globe, base, { stateDir: STATE })['compose.yml'];
    for (const name of ['pds-main:', 'plc:', 'relay:', 'jetstream:', 'slingshot:', 'pdsls:', 'nginx:']) expect(compose).toContain(`\n  ${name}`);
    expect(compose).not.toContain('\n  pds-alpha:');
    const jetstream = parse(compose).services.jetstream;
    expect(jetstream.environment.JETSTREAM_RELAY_URL).toBe('http://relay:2470');
    expect(jetstream.image).toBe(base.tags['snowglobe-jetstream']);
    // Healthy when it serves, not when it listens: /readyz on the debug port is up before the streams are.
    expect(jetstream.healthcheck.test).toContain('http://127.0.0.1:6008/xrpc/network.bsky.jetstream.listSegments?limit=1');
  });

  it('writes the atmo example globe as test/snowglobe/rendered/ has it', () => {
    const { globe, errors } = loadGlobe(join(ROOT, 'docs/examples/atmo.yml'));
    expect(errors).toEqual([]);
    const files: Record<string, string> = renderGlobe(globe, base, { stateDir: STATE, source: 'atmo.yml' });
    expect(Object.keys(files).sort()).toEqual(['compose.yml', 'globe.env', 'leaf-names', 'nginx/globe.conf', 'nginx/page.inc', 'page.json']);
    for (const [name, text] of Object.entries(files)) {
      const path = join(RENDERED, name);
      if (process.env.SG_WRITE_RENDERED) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      expect(text, name).toBe(readFileSync(path, 'utf8'));
    }
  });

  it('mounts the folder the page and nginx read the routes and snowglobe.json from, under the same path', () => {
    const { compose } = render(THREE);
    const mounts: string[] = compose.services.nginx.volumes.filter((v: string) => v.includes('/etc/nginx/snowglobe'));
    expect(mounts.length).toBeGreaterThan(0);
    const page = readFileSync(join(ROOT, 'stack/page/snowglobe.conf'), 'utf8');
    expect(page).toContain('alias /etc/nginx/snowglobe/snowglobe.json;');
    expect(page).not.toContain('/etc/nginx/devnet');
    expect(readFileSync(join(ROOT, 'stack/https/nginx.conf.template'), 'utf8')).toContain('include /etc/nginx/snowglobe/*.conf;');
  });

  it('runs one service per PDS, each on the plain network under its own name', () => {
    for (const doc of [THREE, FOUR]) {
      const { compose } = render(doc);
      const pds = Object.keys(compose.services).filter((s) => s.startsWith('pds-'));
      expect(pds).toEqual(doc.pds.map((p) => `pds-${p.name}`));
      for (const p of doc.pds) {
        const s = compose.services[`pds-${p.name}`];
        expect(s.network_mode).toBeUndefined();
        expect(s.environment.PDS_HOSTNAME).toBe(`${p.name}.mine.test`);
        expect(s.environment.PDS_SERVICE_DID).toBe(`did:web:${p.name}.mine.test`);
        expect(s.volumes).toContain(`pds-${p.name}-data:/pds/data`);
        expect(compose.volumes).toHaveProperty(`pds-${p.name}-data`);
      }
    }
  });

  it('shares no network namespace but Slingshot\'s', () => {
    const { compose } = render(FOUR);
    const shared = Object.entries(compose.services).filter(([, s]: [string, any]) => s.network_mode).map(([n]) => n);
    expect(shared).toEqual(['slingshot']);
  });

  it('gives a PDS with bare handles the domain\'s handles, and the others their own', () => {
    const { compose } = render(THREE);
    expect(compose.services['pds-alpha'].environment.PDS_SERVICE_HANDLE_DOMAINS).toBe('.mine.test');
    expect(compose.services['pds-regular'].environment.PDS_SERVICE_HANDLE_DOMAINS).toBe('.regular.mine.test');
  });

  it('requires invites only where the file says so', () => {
    const { compose } = render({ ...THREE, pds: [PDS('alpha', { invites: 'required' }), PDS('regular')] });
    expect(compose.services['pds-alpha'].environment.PDS_INVITE_REQUIRED).toBe('true');
    expect(compose.services['pds-regular'].environment.PDS_INVITE_REQUIRED).toBe('false');
  });

  it('has the relay crawl every PDS at its https name, and nginx answer to each inside the network', () => {
    const { compose } = render({ ...FOUR, services: { tap: true } });
    const names = FOUR.pds.map((p) => `${p.name}.mine.test`);
    expect(compose.services['relay-init'].environment.RELAY_HOSTS.split(' ')).toEqual(names);
    expect(compose.services.nginx.networks["snowglobe"].aliases).toEqual(names);
    expect(compose.services.jetstream.environment.JETSTREAM_RELAY_URL).toBe('http://relay:2470');
    expect(compose.services.tap.environment.TAP_RELAY_URL).toBe('http://relay:2470');
  });

  it('routes each PDS\'s name and handles to its service, and puts both on the leaf', () => {
    const { files } = render(FOUR);
    const conf = files['nginx/globe.conf'];
    const leaf = files['leaf-names'].trim().split('\n');
    expect(conf).toMatch(/server_name alpha\.mine\.test \*\.mine\.test;\s+location \/ \{\s+set \$upstream http:\/\/pds-alpha:3000;/);
    for (const n of ['regular', 'prod', 'beta']) {
      expect(conf).toMatch(new RegExp(`server_name ${n}\\.mine\\.test \\*\\.${n}\\.mine\\.test;\\s+location / \\{\\s+set \\$upstream http://pds-${n}:3000;`));
      expect(leaf).toEqual(expect.arrayContaining([`${n}.mine.test`, `*.${n}.mine.test`]));
    }
    expect(conf).toMatch(/server_name relay\.mine\.test;\s+location \/ \{\s+set \$upstream http:\/\/relay:2470;/);
  });

  it('gives the page health and accounts for every PDS, and the seed PDS at /health/pds', () => {
    const { files } = render({ ...FOUR, pds: [PDS('regular'), PDS('alpha', { bare_handles: true }), PDS('beta')] });
    const inc = files['nginx/page.inc'];
    expect(inc).toMatch(/location = \/health\/pds \{ proxy_pass \$pds_alpha\//);
    for (const n of ['regular', 'alpha', 'beta']) {
      expect(inc).toContain(`set $pds_${n} http://pds-${n}:3000;`);
      expect(inc).toContain(`location = /health/${n} {`);
      expect(inc).toContain(`location = /people/${n}/listRepos {`);
    }
  });

  it('refuses a PDS named for one of the page\'s own health routes, which nginx would see twice', () => {
    const fixed = [...readFileSync(join(ROOT, 'stack/page/snowglobe.conf'), 'utf8').matchAll(/location = \/health\/([a-z0-9-]+) /g)].map((m) => m[1]);
    expect(fixed.length).toBeGreaterThan(0);
    for (const name of [...fixed, 'pds']) {
      expect(checkGlobe({ ...THREE, pds: [PDS(name)] }).errors.map((e: string) => e.split(': ')[0]), name).toContain('pds[0].name');
    }
  });

  it('seeds init on the PDS with bare handles, else the first', () => {
    const bare = render({ ...THREE, pds: [PDS('regular'), PDS('alpha', { bare_handles: true })] });
    expect(bare.compose.services.init.depends_on).toHaveProperty('pds-alpha');
    expect(bare.compose.services.init.command[1]).toContain('http://pds-alpha:3000');
    expect(bare.env.SG_SEED_PDS).toBe('alpha');
    const first = render({ ...THREE, pds: [PDS('regular'), PDS('prod')] });
    expect(first.compose.services.init.environment.HANDLE_DOMAIN).toBe('.regular.mine.test');
    expect(first.env.SG_SEED_PDS).toBe('regular');
  });

  it('runs the relay for one PDS when Jetstream is on, since Jetstream reads a relay', () => {
    const { compose, env } = render({ globe: 'one', domain: 'one.test', pds: [PDS('solo')], services: { tap: true } });
    expect(compose.services).toHaveProperty('relay');
    expect(compose.services.jetstream.environment.JETSTREAM_RELAY_URL).toBe('http://relay:2470');
    expect(compose.services.jetstream.depends_on).toEqual({ relay: { condition: 'service_healthy' } });
    expect(compose.services.tap.environment.TAP_RELAY_URL).toBe('http://relay:2470');
    expect(env.SG_ONESHOTS).toBe('init relay-init');
  });

  it('runs no relay for one PDS without Jetstream, and TAP reads that PDS', () => {
    const { compose, files, env } = render({
      globe: 'one', domain: 'one.test', pds: [PDS('solo')], services: { tap: true, jetstream: false, slingshot: false },
    });
    expect(compose.services).not.toHaveProperty('relay');
    expect(compose.services).not.toHaveProperty('relay-init');
    expect(compose.services.tap.environment.TAP_RELAY_URL).toBe('http://pds-solo:3000');
    expect(files['nginx/globe.conf']).not.toContain('relay.one.test');
    expect(env.SG_ONESHOTS).toBe('init');
  });

  it('leaves out a service the file turns off, with its name and route', () => {
    const { compose, files, env } = render({ ...THREE, services: { pdsls: false, slingshot: false, tap: false } });
    for (const s of ['pdsls', 'slingshot', 'slingshot-dns', 'tap']) {
      expect(compose.services).not.toHaveProperty(s);
      expect(env.SG_SERVICES.split(' ')).not.toContain(s);
    }
    for (const n of ['pdsls.mine.test', 'slingshot.mine.test']) {
      expect(files['nginx/globe.conf']).not.toContain(n);
      expect(files['leaf-names'].split('\n')).not.toContain(n);
    }
  });

  it("names on the page only what the globe runs, and gives it no feed without Jetstream", () => {
    const page = (doc: object) => JSON.parse(render(doc).files['page.json']);
    const one = page({ globe: 'one', domain: 'one.test', pds: [PDS('solo')] });
    expect(one.about).toContain('its own PDS, PLC directory, relay and Jetstream.');
    expect(one.feed).toBe('/subscribe');
    expect(page({ ...THREE, services: { relay: true } }).about).toContain('its own PDSs, PLC directory, relay and Jetstream.');
    const quiet = page({ globe: 'one', domain: 'one.test', pds: [PDS('solo')], services: { jetstream: false, slingshot: false } });
    expect(quiet.about).toContain('its own PDS and PLC directory.');
    expect(quiet.feed).toBe(false);
  });

  it('lists in globe.env every service it runs, the one-shots apart', () => {
    const { compose, env } = render(FOUR);
    const listed = [...env.SG_SERVICES.split(' '), ...env.SG_ONESHOTS.split(' ')];
    expect(listed.sort()).toEqual(Object.keys(compose.services).sort());
    expect(env.SG_PDS).toBe('alpha regular prod beta');
    expect(env.SG_DOMAIN).toBe('mine.test');
  });

  it('tells snowglobe account which PDS has bare handles, which take invites, and which names are taken', () => {
    const { env } = render({
      ...FOUR,
      pds: [PDS('alpha', { bare_handles: true, invites: 'required' }), PDS('regular'), PDS('beta', { invites: 'required' })],
      grouphosts: [{ name: 'gh', kind: 'opensocial', image: 'ghcr.io/example/grouphost:1' }],
      apps: [{ name: 'atmo', local: { port: 5173, handles: 'ev' } }],
    });
    expect(env.SG_BARE_PDS).toBe('alpha');
    expect(env.SG_INVITE_PDS).toBe('alpha beta');
    expect(env.SG_TAKEN.split(' ')).toEqual(expect.arrayContaining(['plc', 'lex-authority', 'alpha', 'regular', 'beta', 'gh', 'ev']));
    expect(render({ ...THREE, pds: [PDS('regular')] }).env.SG_BARE_PDS).toBe('');
  });

  it('takes a domain from the command line in place of the file\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowglobe-render-'));
    const r = spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), 'render', join(ROOT, 'docs/examples/atmo.yml'), '--out', dir, '--domain', 'other.test'], { encoding: 'utf8', env: inDir(dir) });
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(readFileSync(join(dir, 'globe.env'), 'utf8')).SG_DOMAIN).toBe('other.test');
    expect(readFileSync(join(dir, 'leaf-names'), 'utf8')).toContain('alpha.other.test');
  });

  const docker = spawnSync('docker', ['compose', 'version']).status === 0;
  it.skipIf(!docker)('writes a compose file that docker compose reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowglobe-render-'));
    const r = spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), 'render', join(ROOT, 'docs/examples/atmo.yml'), '--out', dir], { encoding: 'utf8', env: inDir(dir) });
    expect(r.status, r.stderr).toBe(0);
    const c = spawnSync('docker', ['compose', '-p', 'snowglobe-render-test', '--project-directory', ROOT, '-f', join(dir, 'compose.yml'), 'config', '-q'], { encoding: 'utf8', env: { ...process.env, ...SECRET_ENV } });
    expect(c.status, c.stderr).toBe(0);
  });
});

// Two group hosts: one built from a folder, one from an image.
const BUILD = join(__dirname, 'snowglobe', 'grouphost-build');
const GH = {
  ...THREE,
  grouphosts: [
    { name: 'gh', kind: 'opensocial', build: BUILD },
    { name: 'gh2', kind: 'opensocial', image: 'ghcr.io/example/grouphost:1' },
  ],
};

describe('snowglobe render: group hosts', () => {
  it('runs none when the file lists none', () => {
    const { files, compose, env } = render(THREE);
    for (const [name, text] of Object.entries(files)) expect(text, name).not.toMatch(/grouphost/);
    expect(Object.keys(compose.services).filter((s) => s.startsWith('grouphost-'))).toEqual([]);
    expect(env.SG_GROUPHOSTS).toBe('');
    expect(env.SG_BUILDS).toBe('');
  });

  it('runs one service per group host, at <name>.<domain> with its groups\' handles under it', () => {
    const { compose } = render(GH);
    expect(compose.services['grouphost-gh'].build).toEqual({ context: BUILD });
    expect(compose.services['grouphost-gh'].image).toBeUndefined();
    expect(compose.services['grouphost-gh2'].image).toBe('ghcr.io/example/grouphost:1');
    expect(compose.services['grouphost-gh2'].build).toBeUndefined();
    for (const name of ['gh', 'gh2']) {
      const s = compose.services[`grouphost-${name}`];
      expect(s.environment).toMatchObject({
        PDS_PORT: '7070',
        PDS_HOSTNAME: `${name}.mine.test`,
        PDS_SERVICE_HANDLE_DOMAINS: `.${name}.mine.test`,
        HOST_PUBLIC_URL: `https://${name}.mine.test`,
        HOST_PLC_URL: 'http://plc:2582',
        PDS_DID_PLC_URL: 'http://plc:2582',
        PDS_INVITE_REQUIRED: 'false',
        SG_RESOLVE_DOMAIN: 'mine.test',
        PDS_LEXICON_AUTHORITY_DID: '${SG_LEXICON_AUTHORITY_DID:-}',
      });
      // The same devnet secrets as every PDS here, none left unset.
      for (const k of ['PDS_ADMIN_PASSWORD', 'PDS_JWT_SECRET', 'PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX'])
        expect(s.environment[k], k).toBe(compose.services['pds-alpha'].environment[k]);
      expect(s.volumes[0]).toBe(`grouphost-${name}-data:/data`);
      expect(compose.volumes).toHaveProperty(`grouphost-${name}-data`);
      expect(compose.services.nginx.networks["snowglobe"].aliases).toContain(`${name}.mine.test`);
    }
  });

  it('gives each one its nginx server, certificate names, page row, health and group list', () => {
    const { files, env } = render(GH);
    expect(files['nginx/globe.conf']).toContain('server_name gh.mine.test *.gh.mine.test;');
    expect(files['nginx/globe.conf']).toContain('set $upstream http://grouphost-gh2:7070;');
    const leaf = files['leaf-names'].split('\n');
    expect(leaf).toEqual(expect.arrayContaining(['gh.mine.test', '*.gh.mine.test', 'gh2.mine.test', '*.gh2.mine.test']));
    expect(files['nginx/page.inc']).toContain('location = /health/gh { proxy_pass $gh_gh/xrpc/_health; }');
    expect(files['nginx/page.inc']).toContain('location = /groups/gh2/listRepos { proxy_pass $gh_gh2/xrpc/com.atproto.sync.listRepos$is_args$args; }');
    const page = JSON.parse(files['page.json']);
    expect(page.services.filter((r: string[]) => r[0] === 'Group host').map((r: string[]) => r[1])).toEqual(['gh', 'gh2']);
    expect(page.accounts).toEqual(expect.arrayContaining([['/groups/gh', 'group, gh'], ['/groups/gh2', 'group, gh2']]));
    expect(env.SG_GROUPHOSTS).toBe('gh gh2');
    // Only the one built from a folder is built by up; both are waited on.
    expect(env.SG_BUILDS).toBe('grouphost-gh');
    expect(env.SG_SERVICES.split(' ')).toEqual(expect.arrayContaining(['grouphost-gh', 'grouphost-gh2']));
  });

  it('will not render a group host with no image and no build folder', () => {
    const { globe } = checkGlobe({ ...THREE, grouphosts: [{ name: 'gh', kind: 'opensocial' }] });
    expect(() => renderGlobe(globe, base, { stateDir: STATE })).toThrow(/gh/);
  });

  it('builds a group host the file gives no source from SG_OPENSOCIAL_BUILD, and says how when it is unset', () => {
    const { globe } = checkGlobe({ ...THREE, grouphosts: [{ name: 'gh', kind: 'opensocial' }, GH.grouphosts[1]] });
    const filled = withGroupHostSources(globe, { SG_OPENSOCIAL_BUILD: 'grouphost-build' }, join(__dirname, 'snowglobe'));
    expect(filled.grouphosts.map((g: { build: string | null }) => g.build)).toEqual([BUILD, null]);
    expect(() => withGroupHostSources(globe, {})).toThrow(/grouphosts\[0\] \(gh\).*SG_OPENSOCIAL_BUILD/);
    expect(() => withGroupHostSources(globe, { SG_OPENSOCIAL_BUILD: __dirname })).toThrow(/Dockerfile/);
    // The file's own image or folder wins over the variable.
    const own = checkGlobe(GH).globe;
    expect(withGroupHostSources(own, { SG_OPENSOCIAL_BUILD: '/elsewhere' }).grouphosts).toEqual(own.grouphosts);
  });

  it('render fails before writing anything when a group host has no source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowglobe-render-'));
    writeFileSync(join(dir, 'snowglobe.yml'), 'globe: mine\npds: [{name: alpha, image: spaces-alpha}]\ngrouphosts: [{name: gh, kind: opensocial}]\n');
    const env = { ...process.env };
    delete env.SG_OPENSOCIAL_BUILD;
    const r = spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), 'render', join(dir, 'snowglobe.yml'), '--out', join(dir, 'out')], { encoding: 'utf8', env: inDir(dir, env) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SG_OPENSOCIAL_BUILD');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  const docker = spawnSync('docker', ['compose', 'version']).status === 0;
  it.skipIf(!docker)('writes group hosts docker compose reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowglobe-render-'));
    writeFileSync(join(dir, 'snowglobe.yml'), 'globe: mine\npds: [{name: alpha, image: spaces-alpha}]\ngrouphosts: [{name: gh, kind: opensocial}, {name: gh2, kind: opensocial, image: "ghcr.io/example/grouphost:1"}]\n');
    const r = spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), 'render', join(dir, 'snowglobe.yml'), '--out', join(dir, 'out')], {
      encoding: 'utf8',
      env: inDir(dir, { ...process.env, SG_OPENSOCIAL_BUILD: BUILD }),
    });
    expect(r.status, r.stderr).toBe(0);
    const c = spawnSync('docker', ['compose', '-p', 'snowglobe-render-test', '--project-directory', ROOT, '-f', join(dir, 'out', 'compose.yml'), 'config', '-q'], { encoding: 'utf8', env: { ...process.env, ...SECRET_ENV } });
    expect(c.status, c.stderr).toBe(0);
  });
});

describe('stack/https/app-names.cjs', () => {
  // SG_APP_PROXY_HOST stands in for nginx, so the lookup answers here.
  const lookup = (name: string, env: object) =>
    spawnSync('node', ['--require', join(ROOT, 'stack/https/app-names.cjs'), '-e', `require('dns').lookup(${JSON.stringify(name)}, { family: 4 }, (e, a) => console.log(e ? e.code : a))`], {
      encoding: 'utf8',
      env: { ...process.env, SG_APP_PROXY_HOST: 'localhost', ...env },
    }).stdout.trim();

  it('sends the domain\'s names to nginx only when SG_RESOLVE_DOMAIN names it', () => {
    expect(lookup('club.gh.mine.test', { SG_RESOLVE_DOMAIN: 'mine.test' })).toBe('127.0.0.1');
    expect(lookup('mine.test', { SG_RESOLVE_DOMAIN: 'mine.test' })).toBe('127.0.0.1');
    expect(lookup('club.gh.mine.test', {})).not.toBe('127.0.0.1');
    expect(lookup('notmine.test', { SG_RESOLVE_DOMAIN: 'mine.test' })).not.toBe('127.0.0.1');
    // The PDSes get app.<domain>: any app's name goes to nginx, the rest of the domain does not.
    expect(lookup('x.app.mine.test', { SG_RESOLVE_DOMAIN: 'app.mine.test' })).toBe('127.0.0.1');
    expect(lookup('alpha.mine.test', { SG_RESOLVE_DOMAIN: 'app.mine.test' })).not.toBe('127.0.0.1');
    expect(lookup('x.devnet.internal', { SG_RESOLVE_DOMAIN: 'app.mine.test' })).not.toBe('127.0.0.1');
  });
});

describe('snowglobe images built from this repo', () => {
  it('tags each by a hash of its build folder, so a changed folder is rebuilt', () => {
    const { compose } = render(THREE);
    for (const [svc, name] of [['slingshot-dns', 'dns'], ['proxy', 'proxy'], ['pdsls', 'pdsls']])
      expect(compose.services[svc].image, svc).toMatch(new RegExp(`^snowglobe-${name}:[0-9a-f]{12}$`));
  });

  it('changes the tag when a file the build uses changes, not when another file in the folder does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-ctx-'));
    mkdirSync(join(dir, 'ctx'));
    writeFileSync(join(dir, 'ctx', 'Dockerfile'), 'FROM alpine\n');
    const before = contextHash(dir, 'ctx', ['Dockerfile']);
    writeFileSync(join(dir, 'ctx', 'server.test.mjs'), 'x');
    symlinkSync('missing', join(dir, 'ctx', '.#Dockerfile'));
    expect(contextHash(dir, 'ctx', ['Dockerfile'])).toBe(before);
    writeFileSync(join(dir, 'ctx', 'Dockerfile'), 'FROM alpine:3.20\n');
    expect(contextHash(dir, 'ctx', ['Dockerfile'])).not.toBe(before);
  });
});

describe('TAP with settings', () => {
  const tapGlobe = (t: object | boolean) => ({ globe: 'one', domain: 'one.test', pds: [PDS('solo')], apps: [{ name: 'web', local: { port: 3000 } }], services: { tap: t } });

  it('sends its events to the webhook and follows the signal collection', () => {
    const { compose } = render(tapGlobe({ webhook: '${apps.web.url}/api/webhook', signal_collection: 'xyz.statusphere.status' }));
    const env = compose.services.tap.environment;
    expect(env.TAP_WEBHOOK_URL).toBe('https://web.app.one.test/api/webhook');
    expect(env.TAP_SIGNAL_COLLECTION).toBe('xyz.statusphere.status');
    expect(env.TAP_COLLECTION_FILTERS).toBe('xyz.statusphere.status');
  });

  it('sets none of them for plain true', () => {
    const env = render({ ...tapGlobe(true) }).compose.services.tap.environment;
    expect(env).not.toHaveProperty('TAP_WEBHOOK_URL');
    expect(env).not.toHaveProperty('TAP_SIGNAL_COLLECTION');
  });

  it('runs in tap-dns, which answers every name with nginx, and publishes its port on loopback', () => {
    const { compose } = render(tapGlobe(true));
    expect(compose.services.tap.network_mode).toBe('service:tap-dns');
    expect(compose.services.tap).not.toHaveProperty('networks');
    expect(compose.services.tap).not.toHaveProperty('ports');
    expect(compose.services['tap-dns'].ports).toEqual(['${SG_BIND:-127.0.0.1}:${SG_TAP_PORT:-2480}:2480']);
    expect(compose.services['tap-dns'].environment.SG_DOMAIN).toBe('one.test');
  });

  it('adds neither when TAP is off', () => {
    const { compose } = render(tapGlobe(false));
    expect(compose.services).not.toHaveProperty('tap');
    expect(compose.services).not.toHaveProperty('tap-dns');
  });
});

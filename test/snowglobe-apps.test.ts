// snowglobe app (lib/commands/app.mjs, lib/apps.mjs): app routes through the globe's nginx and the
// network page. No Docker needed; run them alone with `npx vitest run snowglobe-apps`. The
// renderers are checked against test/snowglobe/apps/<globe>/; after a deliberate change, rewrite
// them with SG_WRITE_RENDERED=1 npx vitest run snowglobe-apps, and read the diff. The CLI
// runs on a copy of bin/ and lib/ in a temporary root, with no globe running, so nginx is not touched.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { formatApps, parseApps, renderApps, renderPage } from '../lib/apps.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { loadGlobe } from '../lib/config.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { loadBase, renderGlobe } from '../lib/render.mjs';

const ROOT = join(__dirname, '..');
const base = loadBase(ROOT);
// Where the fixtures say a snowglobe's state is, the same on every machine.
const STATE = '/state/snowglobe/snowglobe';
const APPS = 'atmo 5173 ev\nprobe 5480\n';
const GLOBES = { default: join(ROOT, 'docs/examples/atmo.yml'), four: join(ROOT, 'test/snowglobe/four.yml') };

function rendered(file: string) {
  const { globe, errors } = loadGlobe(file);
  expect(errors).toEqual([]);
  return { globe, files: renderGlobe(globe, base, { stateDir: STATE }) as Record<string, string> };
}

describe('the app renderers', () => {
  for (const [name, file] of Object.entries(GLOBES)) {
    it(`write the ${name} globe's routes and page as test/snowglobe/apps/${name}/ has them`, () => {
      const { globe, files } = rendered(file);
      const apps = parseApps(APPS);
      const out: Record<string, string> = {
        ...renderApps(apps, globe.domain),
        'snowglobe.json': renderPage(JSON.parse(files['page.json']), apps),
      };
      for (const [f, text] of Object.entries(out)) {
        const path = join(ROOT, 'test/snowglobe/apps', name, f);
        if (process.env.SG_WRITE_RENDERED) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
        }
        expect(text, f).toBe(readFileSync(path, 'utf8'));
      }
    });
  }

  it('lists every PDS on the page, with its account list, and only the services the globe runs', () => {
    const { globe, files } = rendered(GLOBES.four);
    const page = JSON.parse(renderPage(JSON.parse(files['page.json']), []));
    expect(page.services.filter((s: string[]) => s[0] === 'PDS').map((s: string[]) => s[1])).toEqual(globe.pds.map((p: { name: string }) => p.name));
    expect(page.accounts.map((a: string[]) => a[0])).toEqual(globe.pds.map((p: { name: string }) => `/people/${p.name}`));
    // Each PDS's health key has a relay in page.inc.
    for (const p of globe.pds) expect(files['nginx/page.inc']).toContain(`location = /health/${p.name} `);
    expect(page.apps).toEqual([{ name: 'pdsls', url: 'https://pdsls.four.test' }]);

    const lean = { ...globe, services: { ...globe.services, slingshot: false, pdsls: false, tap: false } };
    const leanPage = JSON.parse(renderGlobe(lean, base, { stateDir: STATE })['page.json']);
    const keys = leanPage.services.map((s: string[]) => s[2]);
    for (const off of ['slingshot', 'pdsls', 'sync']) expect(keys).not.toContain(off);
    expect(leanPage.apps).toEqual([]);
  });

  it('reads and writes the apps file', () => {
    expect(parseApps('a 1 e\n\nb 2\nbroken\n')).toEqual([
      { name: 'a', port: 1, ending: 'e' },
      { name: 'b', port: 2, ending: null },
    ]);
    expect(formatApps(parseApps(APPS))).toBe(APPS);
  });
});

// A root with bin/ and lib/, a rendered four-PDS globe and its certificates, as snowglobe up leaves it.
function globeRoot() {
  const r = mkdtempSync(join(tmpdir(), 'snowglobe-apps-'));
  for (const d of ['bin', 'lib', 'stack/https/dns', 'stack/https/proxy', 'stack/pdsls', 'stack/jetstream']) cpSync(join(ROOT, d), join(r, d), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(r, 'node_modules'));
  writeFileSync(join(r, 'package.json'), '{"type": "module"}\n');
  for (const f of ['docker-compose.yml', 'docker-compose.test.yml', 'docker-compose.relay.yml', 'init/init.sh']) { mkdirSync(dirname(join(r, 'stack', f)), { recursive: true }); cpSync(join(ROOT, 'stack', f), join(r, 'stack', f)); }
  // The file in the folder the commands run in, and the user's state under it.
  cpSync(GLOBES.four, join(r, 'snowglobe.yml'));
  const env = cleanEnv(r);
  expect(spawnSync('node', [join(r, 'bin/snowglobe.mjs'), 'render'], { cwd: r, env, encoding: 'utf8' }).status).toBe(0);
  expect(spawnSync('node', [join(r, 'bin/snowglobe.mjs'), 'certs'], { cwd: r, env, encoding: 'utf8' }).status).toBe(0);
  return r;
}
function cleanEnv(r: string) {
  const e: Record<string, string | undefined> = { ...process.env, XDG_DATA_HOME: join(r, 'xdg') };
  for (const k of ['SG_DOMAIN', 'SG_PROJECT', 'SG_BIND', 'SG_FILE', 'HTTPS_EXTRA_NAMES']) delete e[k];
  return e;
}
// The four-PDS globe's state folder, and the user's CA beside it.
const st = (r: string, f: string) => join(r, 'xdg/snowglobe/four', f);
const caCrt = (r: string) => join(r, 'xdg/snowglobe/ca/ca.crt');
const app = (r: string, ...args: string[]) =>
  spawnSync('node', [join(r, 'bin/snowglobe.mjs'), 'app', ...args], { cwd: r, env: cleanEnv(r), encoding: 'utf8' });
const appsFile = (r: string) => (existsSync(st(r, 'https/apps')) ? readFileSync(st(r, 'https/apps'), 'utf8') : '');
const page = (r: string) => JSON.parse(readFileSync(st(r, 'https/nginx/snowglobe.json'), 'utf8'));
const leaf = (r: string) => new X509Certificate(readFileSync(st(r, 'https/leaf.crt')));

describe('snowglobe app', () => {
  it('routes an app, puts it on the page, and keeps the route for a globe that is not running', () => {
    const r = globeRoot();
    const res = app(r, 'probe', '5480');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('loads the route when snowglobe up starts');
    expect(appsFile(r)).toBe('probe 5480\n');
    expect(readFileSync(st(r, 'https/nginx/apps.map'), 'utf8')).toContain('probe.app.four.test snowglobe_app_probe;');
    expect(page(r).apps.map((a: { name: string }) => a.name)).toEqual(['pdsls', 'probe']);
    expect(page(r).services.filter((s: string[]) => s[0] === 'PDS')).toHaveLength(4);
  });

  it('reissues the leaf from the same CA when an ending is new', () => {
    const r = globeRoot();
    const ca = readFileSync(caCrt(r), 'utf8');
    const res = app(r, 'atmo', '5173', 'ev');
    expect(res.status, res.stderr).toBe(0);
    expect(leaf(r).subjectAltName).toContain('DNS:*.ev.four.test');
    expect(readFileSync(caCrt(r), 'utf8')).toBe(ca);
    expect(readFileSync(st(r, 'https/nginx/apps.conf'), 'utf8')).toContain('server_name *.ev.four.test;');
  });

  it('refuses an ending that is a PDS name or another app\'s, and leaves the routes as they were', () => {
    const r = globeRoot();
    expect(app(r, 'atmo', '5173', 'ev').status).toBe(0);
    const before = appsFile(r);
    const pds = app(r, 'x', '5600', 'beta');
    expect(pds.status).toBe(1);
    expect(pds.stderr).toContain('beta.four.test');
    expect(app(r, 'other', '5601', 'ev').status).toBe(1);
    expect(appsFile(r)).toBe(before);
  });

  it('changes the port on a rerun, and drops the ending unless it is given again', () => {
    const r = globeRoot();
    expect(app(r, 'atmo', '5173', 'ev').status).toBe(0);
    expect(app(r, 'atmo', '5174').status).toBe(0);
    expect(appsFile(r)).toBe('atmo 5174\n');
    expect(readFileSync(st(r, 'https/nginx/apps.conf'), 'utf8')).not.toContain('*.ev.');
  });

  it('removes a route, from nginx and the page; an unknown one is refused', () => {
    const r = globeRoot();
    expect(app(r, 'probe', '5480').status).toBe(0);
    expect(app(r, 'atmo', '5173').status).toBe(0);
    expect(app(r, '--remove', 'probe').status).toBe(0);
    expect(appsFile(r)).toBe('atmo 5173\n');
    expect(readFileSync(st(r, 'https/nginx/apps.map'), 'utf8')).not.toContain('probe');
    expect(page(r).apps.map((a: { name: string }) => a.name)).toEqual(['pdsls', 'atmo']);
    expect(app(r, '--remove', 'probe').status).toBe(1);
  });

  it('refuses a bad name, port or ending as a usage mistake', () => {
    const r = globeRoot();
    for (const args of [['Atmo', '5173'], ['atmo', '0'], ['atmo', '70000'], ['atmo', '5173', 'E_V'], ['atmo'], ['--remove']])
      expect(app(r, ...args).status, args.join(' ')).toBe(2);
    expect(appsFile(r)).toBe('');
  });

  it('--render writes the routes and page with no route at all', () => {
    const r = globeRoot();
    expect(app(r, '--render').status).toBe(0);
    expect(page(r).domain).toBe('four.test');
    expect(readFileSync(st(r, 'https/nginx/apps.conf'), 'utf8')).toMatch(/^# Written by snowglobe app/);
  });
});

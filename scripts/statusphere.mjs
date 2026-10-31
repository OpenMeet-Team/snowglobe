#!/usr/bin/env node
// The Statusphere example's whole flow, end to end (docs/examples/statusphere.md): up with
// docs/examples/statusphere.yml, the app at a pinned commit with the page's patch, run under
// snowglobe run, then in headless Chromium sign in as alice through her PDS's sign-in and consent
// pages, pick an emoji, and see it on her PDS and in the feed; then bob writes a status outside
// the app, and it has to reach the feed through Tap. One line per step, ok or FAIL, and exit 0
// only when every step passed. Nothing secret is printed.
//
//   node scripts/statusphere.mjs
//
// Like smoke.mjs it runs on a copy of this checkout in a temporary folder, with its own state
// folder (XDG_DATA_HOME), so your own snowglobes are never touched. The globe is compose project
// snowglobe-statusphere on SG_BIND from the environment, else 127.0.0.4. It is taken down with -v
// at the end, unless SMOKE_KEEP is set and a step failed (CI then reads the containers' logs);
// the folder is left for a look, with the app's log and a screenshot of the step that failed.
//
// Needs Docker with compose, Node 20+, pnpm (corepack), git, network access to GitHub and npm,
// and Linux, where the name router runs: the app and the browser reach the snowglobe by name. The browser is Playwright's Chromium, installed into the copy;
// on a fresh Linux machine its system libraries come from `npx playwright install-deps chromium`.

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'data', 'node_modules']);
const PROJECT = 'snowglobe-statusphere';
const APP_PORT = 3017;
// The app as the page was written against, and the browser driver.
const APP_REPO = 'https://github.com/bluesky-social/statusphere-example-app';
const APP_COMMIT = 'dbb97738caa965c4b04efd281bfa1d2fbe4fffb3';
const PLAYWRIGHT = '1.64.1';

const root = mkdtempSync(join(tmpdir(), 'snowglobe-statusphere-'));
for (const name of readdirSync(SRC)) if (!SKIP.has(name)) cpSync(join(SRC, name), join(root, name), { recursive: true });
symlinkSync(join(SRC, 'node_modules'), join(root, 'node_modules'));

const { adoptOldNames, setting } = await import(join(root, 'lib/env.mjs'));
const { localDomain } = await import(join(root, 'lib/config.mjs'));
const given = { ...process.env };
adoptOldNames({ root, env: given });
for (const k of Object.keys(given)) if (/^(DEVNET|SNOWGLOBE)_/.test(k)) delete given[k];
const env = { ...given, XDG_DATA_HOME: join(root, 'state'), SG_PROJECT: PROJECT, SG_BIND: setting('SG_BIND', { root, env: given }) || '127.0.0.4' };
for (const k of ['SG_FILE', 'ACCOUNTS_FILE', 'SG_PUBLIC', 'SG_RESET_OK', 'SG_DOMAIN']) delete env[k];
const bind = env.SG_BIND;

// The example's file, with the app on a port of its own.
const file = readFileSync(join(root, 'docs/examples/statusphere.yml'), 'utf8');
writeFileSync(join(root, 'snowglobe.yml'), file.replace('port: 3000', `port: ${APP_PORT}`));
const globe = /^globe: *(\S+)/m.exec(file)[1];
// The file's domain line if it has one, else the globe's own domain, as up gives it.
const domain = /^domain: *(\S+)/m.exec(file)?.[1] ?? localDomain(globe);
const APP = `https://statusphere.app.${domain}`;
const PDS = `https://main.${domain}`;
const alice = `alice.${domain}`;
const bob = `bob.${domain}`;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
const sg = (args, opts = {}) => sh(process.execPath, [join(root, 'bin/snowglobe.mjs'), ...args], { cwd: root, env, timeout: 900_000, ...opts });
const why = (r) => (r.error?.message ?? r.stderr ?? '').trim().split('\n').pop();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function step(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}
// A step the rest depend on: when it fails, the run stops there.
class Stop extends Error {}
const must = (name, ok, detail) => {
  if (!step(name, ok, detail)) throw new Stop(name);
};

// https to the globe as an app on this machine sees it: every name on its address, and its CA.
function call(url, { method = 'GET', headers = {}, body } = {}) {
  const ca = readFileSync(join(root, 'state/snowglobe/ca/ca.crt'));
  const lookup = (host, opts, cb) => (opts.all ? cb(null, [{ address: bind, family: 4 }]) : cb(null, bind, 4));
  return new Promise((done) => {
    const req = request(url, { method, headers, ca, lookup, timeout: 15000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => done({ status: res.statusCode, text }));
      // A connection closed partway through the body ends neither in 'end' nor in a timeout.
      res.on('error', (e) => done({ status: 0, text: e.code ?? e.message }));
      res.on('aborted', () => done({ status: 0, text: 'aborted' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => done({ status: 0, text: e.code ?? e.message }));
    req.end(body);
  });
}
const json = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return {};
  }
};
const xrpc = (method, params, token) =>
  method.includes('list')
    ? call(`${PDS}/xrpc/${method}?${new URLSearchParams(params)}`).then(json)
    : call(`${PDS}/xrpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(params) }).then(json);
const statuses = async (handle) => (await xrpc('com.atproto.repo.listRecords', { repo: handle, collection: 'xyz.statusphere.status' })).records?.map((r) => r.value.status) ?? [];
async function until(test, ms, every = 1500) {
  for (const end = Date.now() + ms; ; await sleep(every)) {
    const v = await test();
    if (v || Date.now() > end) return v;
  }
}

console.log(`copy: ${root}`);
console.log(`node ${process.version}; app ${APP_COMMIT.slice(0, 7)}; playwright ${PLAYWRIGHT}; bind ${bind}, project ${PROJECT}\n`);

let app;
let page;
let browser;
const appLog = join(root, 'app.log');
try {
  // The app: a clone at the pinned commit, the page's two changes, its key and env file.
  const dir = join(root, 'app');
  mkdirSync(dir);
  const git = (...a) => sh('git', a, { cwd: dir });
  let r = git('init', '-q');
  for (const a of [['fetch', '-q', '--depth', '1', APP_REPO, APP_COMMIT], ['checkout', '-q', 'FETCH_HEAD'], ['apply', join(root, 'docs/examples/statusphere.patch')]]) if (r.status === 0) r = git(...a);
  must('the app at its commit, with the page\'s changes', r.status === 0, why(r));
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  const PRIVATE_KEY = JSON.stringify({ ...key, kid: String(Date.now()), alg: 'ES256', key_ops: ['sign'] });
  writeFileSync(join(dir, '.env.local'), readFileSync(join(dir, 'env.template'), 'utf8').split('\n').filter((l) => !l.startsWith('APP_URL=')).join('\n'));
  r = sh('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, env: { ...given, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
  must('pnpm install', r.status === 0, why(r));

  // The browser driver, in the copy, so the package itself carries no browser.
  const pw = join(root, 'pw');
  mkdirSync(pw);
  writeFileSync(join(pw, 'package.json'), '{"private":true}');
  r = sh('npm', ['install', '--silent', '--no-audit', '--no-fund', `playwright@${PLAYWRIGHT}`], { cwd: pw });
  if (r.status === 0) r = sh(process.execPath, [join(pw, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: pw });
  must('playwright and chromium', r.status === 0, why(r));
  const { chromium } = createRequire(join(pw, 'package.json'))('playwright');

  r = sg(['check']);
  must('check', r.status === 0, why(r));
  r = sg(['up']);
  if (r.status !== 0) {
    // The end of what up printed, less compose's progress lines: the line that names the failure.
    const PROGRESS = /^\s*(Container|Network|Volume|Image) \S+ +(Waiting|Healthy|Starting|Started|Stopping|Stopped|Creating|Created|Running|Recreate|Recreated|Pulling|Pulled|Removing|Removed)\s*$/;
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').filter((l) => l.trim() && !PROGRESS.test(l)).slice(-15);
    console.log(tail.map((l) => `       ${l}`).join('\n'));
  }
  must('up', r.status === 0, why(r));

  const log = openSync(appLog, 'a');
  app = spawn(process.execPath, [join(root, 'bin/snowglobe.mjs'), 'run', '--', 'pnpm', 'dev'], {
    cwd: dir,
    env: { ...env, PRIVATE_KEY, PORT: String(APP_PORT), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    stdio: ['ignore', log, log],
    detached: true,
  });
  // Next compiles each page on its first request, so the first answer can take a minute.
  const meta = await until(async () => {
    const m = await call(`${APP}/oauth-client-metadata.json`);
    return m.status === 200 && m;
  }, 240_000, 3000);
  must('the app answers at its https name', !!meta, 'no 200 in 4 minutes (app.log)');
  must('its OAuth client ID is its https name', json(meta).client_id === `${APP}/oauth-client-metadata.json`, json(meta).client_id);

  // The browser reaches the snowglobe as a person's would: public DNS sends its names to the name
  // router. It does not trust the snowglobe's CA (ignoreHTTPSErrors); a browser that does is in browser.md.
  browser = await chromium.launch();
  page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  page.setDefaultTimeout(30_000);
  const at = (host) => new RegExp(`^https://${host.replaceAll('.', '\\.')}/`);

  await page.goto(APP, { waitUntil: 'load' });
  await page.fill('input[type=text]', alice);
  await page.click('button[type=submit]');
  must('the app sends alice to her PDS', await page.waitForURL(at(`main.${domain}`)).then(() => true, () => false), page.url());

  const password = /^ALICE_PASSWORD=(.*)$/m.exec(readFileSync(join(root, `state/snowglobe/${globe}/accounts.env`), 'utf8'))?.[1];
  await page.fill('input[name=password]', password ?? '');
  await page.click('button:has-text("Sign in")');
  // The PDS asks for consent the first time; either way the browser ends up back at the app.
  const consent = page.locator('button:has-text("Authorize"), button:has-text("Accept"), button:has-text("Allow")').first();
  await Promise.race([consent.waitFor().then(() => consent.click(), () => {}), page.waitForURL(at(`statusphere.app.${domain}`)).catch(() => {})]);
  must('sign-in and consent bring her back to the app', await page.waitForURL(at(`statusphere.app.${domain}`)).then(() => true, () => false), page.url());
  must('the app says she is signed in', await page.getByText(`Signed in as @${alice}`).waitFor().then(() => true, () => false));

  const recent = async () => (await page.innerText('body')).replace(/\s+/g, ' ').split('Recent')[1] ?? '';
  await page.click('button:has-text("🚀")');
  must('her status is a record on her PDS', await until(async () => (await statuses(alice)).includes('🚀'), 20_000), (await statuses(alice)).join(' ') || 'none');
  const mine = await until(async () => (await page.reload({ waitUntil: 'load' }), (await recent()).includes(alice)), 20_000);
  must('the feed shows it', mine, (await recent()).slice(0, 120));

  // bob writes with a password session, outside the app: the feed can only learn of it from Tap.
  const s = await xrpc('com.atproto.server.createSession', { identifier: bob, password: /^BOB_PASSWORD=(.*)$/m.exec(readFileSync(join(root, `state/snowglobe/${globe}/accounts.env`), 'utf8'))?.[1] });
  const w = await xrpc('com.atproto.repo.createRecord', { repo: s.did, collection: 'xyz.statusphere.status', record: { $type: 'xyz.statusphere.status', status: '🦋', createdAt: new Date().toISOString() } }, s.accessJwt);
  must('bob writes a status outside the app', !!w.uri, w.error);
  const his = await until(async () => (await page.reload({ waitUntil: 'load' }), (await recent()).includes(bob)), 90_000, 2000);
  step('his status reaches the feed through Tap', his, his ? '' : (await recent()).slice(0, 120));
} catch (e) {
  if (!(e instanceof Stop)) step('statusphere', false, e.message.split('\n')[0]);
} finally {
  if (failed && page) {
    mkdirSync(join(root, 'shots'), { recursive: true });
    await page.screenshot({ path: join(root, 'shots/failed.png') }).catch(() => {});
    console.log(`     at ${page.url()}; screenshot ${join(root, 'shots/failed.png')}`);
  }
  await browser?.close().catch(() => {});
  if (app) {
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {}
  }
  if (failed) {
    let text = '';
    try {
      text = readFileSync(appLog, 'utf8');
    } catch {}
    if (text) console.log(`     the app's log, last lines:\n${text.trim().split('\n').slice(-25).map((l) => `       ${l.slice(0, 300)}`).join('\n')}`);
  }
  if (process.env.SMOKE_KEEP && failed) {
    console.log('SMOKE_KEEP set: containers left running');
    process.exit(1);
  }
  const r = sg(['down', '-v'], { stdio: ['ignore', 'ignore', 'pipe'] });
  step('down -v', r.status === 0, why(r));
}

console.log(`\n${failed ? `${failed} step(s) FAILED` : 'every step passed'}; the copy is ${root}`);
process.exit(failed ? 1 : 0);

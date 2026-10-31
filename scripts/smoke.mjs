#!/usr/bin/env node
// The whole snowglobe sequence on this machine, end to end: check, up, account on two PDSes,
// invite, lexicons, env and run (the app's settings), app add, run (names, the CA, each PDS's
// health and the app), app --remove,
// down -v. One line per step, ok or FAIL, and exit 0 only when every step passed. Nothing secret
// is printed: accounts print their DID, invite and lexicons print nothing a login needs.
//
//   node scripts/smoke.mjs
//
// It runs on a copy of this checkout in a temporary folder (data/, .git and node_modules left out;
// node_modules is linked), with its own state folder inside it (XDG_DATA_HOME), so your own
// snowglobes' state (~/.local/share/snowglobe: their CA, logins and app routes) is never touched,
// and the copy keeps every file as checked out, line endings and .env included. The
// globe is compose project snowglobe-smoke, on its own ports and loopback address, beside any other
// globe: SG_BIND and SG_DOMAIN come from the environment or the copied .env if set there,
// else 127.0.0.3 and the default file's domain, and the steps on snowglobe env check they were used.
// The copy is taken down with -v at the end whatever happened; its folder is left for a look.
// The snowglobe has a domain of its own (the atmo example's file, less any domain line), which
// the name router reaches by name; the router is the machine's, shared with your own snowglobes.
//
// Needs Docker with compose and Node 20+. The steps that reach names need the name router, which
// runs on Linux.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'data', 'node_modules']);
const PROJECT = 'snowglobe-smoke';
const APP_PORT = 5597;

const root = mkdtempSync(join(tmpdir(), 'snowglobe-smoke-'));
for (const name of readdirSync(SRC)) if (!SKIP.has(name)) cpSync(join(SRC, name), join(root, name), { recursive: true });
symlinkSync(join(SRC, 'node_modules'), join(root, 'node_modules'));

const { adoptOldNames, setting } = await import(join(root, 'lib/env.mjs'));
const { localDomain } = await import(join(root, 'lib/config.mjs'));
const { ROUTER_ADDRESS } = await import(join(root, 'lib/env.mjs'));
const { routerDir } = await import(join(root, 'lib/router.mjs'));
// Old DEVNET_ and SNOWGLOBE_ settings as their SG_ names, and then gone, so none outlives the
// overrides below.
const given = { ...process.env };
adoptOldNames({ root, env: given });
for (const k of Object.keys(given)) if (/^(DEVNET|SNOWGLOBE)_/.test(k)) delete given[k];
const env = {
  ...given,
  // The state of the copy's snowglobe (the default one) and its CA, in the copy.
  XDG_DATA_HOME: join(root, 'state'),
  SG_PROJECT: PROJECT,
  SG_PLC_PORT: '2593',
  SG_JETSTREAM_PORT: '6028',
  SG_JETSTREAM_METRICS_PORT: '6029',
  SG_MAILDEV_WEB_PORT: '1092',
  SG_MAILDEV_SMTP_PORT: '1037',
  SG_PROXY_PORT: '1093',
  SG_BIND: setting('SG_BIND', { root, env: given }) || '127.0.0.3',
};
for (const k of ['SG_FILE', 'ACCOUNTS_FILE', 'SG_PUBLIC', 'SG_RESET_OK']) delete env[k];
// The atmo example globe, on a domain of its own, plus one app, with the settings the steps below
// check. Its name is smokeapp, so the route the app step adds is the one the file names.
writeFileSync(
  join(root, 'snowglobe.yml'),
  `${readFileSync(join(root, 'docs/examples/atmo.yml'), 'utf8').replace(/^domain:.*\n/m, '')}
apps:
  - name: smokeapp
    env:
      SMOKE_PDS: \${pds.alpha.url}
      SMOKE_PLC: \${services.plc.url}
      SMOKE_ALICE_HANDLE: \${accounts.alice.handle}
      SMOKE_ALICE_PASSWORD: \${accounts.alice.password}
      SMOKE_AUTHORITY_DID: \${lexicons.authority.did}
`,
);
// The example's globe is called snowglobe.
const wantDomain = setting('SG_DOMAIN', { root, env: given }) || localDomain('snowglobe');

const sg = (args, opts = {}) =>
  spawnSync(process.execPath, [join(root, 'bin/snowglobe.mjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 900_000, ...opts });
const run = (args, extra = {}) => sg(['run', '--', ...args], { env: { ...env, ...extra } });

let failed = 0;
function step(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}
// The last line of a failed command's stderr, which names what went wrong.
const why = (r) => (r.error?.message ?? r.stderr ?? '').trim().split('\n').pop();
// When up fails: the end of what it printed but compose's progress lines, each container that
// exited non-zero or is unhealthy with the end of its log, and the ones never started, read
// before down -v removes them.
const PROGRESS = /^\s*(Container|Network|Volume|Image) \S+ +(Waiting|Healthy|Starting|Started|Stopping|Stopped|Creating|Created|Running|Recreate|Recreated|Pulling|Pulled|Removing|Removed)\s*$/;
function diagnose(r) {
  const tail = (text, n) => text.split('\n').filter((l) => l.trim() && !PROGRESS.test(l)).slice(-n).map((l) => `       ${l}`).join('\n');
  console.log(tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, 12));
  const ps = spawnSync('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}\t{{.Status}}'], { encoding: 'utf8' });
  const unstarted = [];
  for (const line of (ps.stdout ?? '').trim().split('\n').filter(Boolean)) {
    const [name, status] = line.split('\t');
    if (status === 'Created') unstarted.push(name.replace(`${PROJECT}-`, ''));
    if (!/^Exited \([1-9]|unhealthy|Restarting/.test(status)) continue;
    console.log(`     ${name}: ${status}`);
    const logs = spawnSync('docker', ['logs', '--tail', '15', name], { encoding: 'utf8' });
    console.log(tail(`${logs.stdout ?? ''}\n${logs.stderr ?? ''}`, 15));
  }
  if (unstarted.length) console.log(`     never started: ${unstarted.join(' ')}`);
}
const version = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout?.trim().split('\n')[0] || 'missing';

console.log(`copy: ${root}`);
console.log(`node ${process.version}; ${version('docker', ['compose', 'version'])}; ${process.platform}`);
console.log(`domain ${wantDomain}, bind ${env.SG_BIND}, project ${PROJECT}\n`);

// The app, in a process of its own: this one waits on each command in turn, and would not answer.
let listener;
try {
  let r = sg(['check']);
  step('check', r.status === 0, why(r));

  r = sg(['up']);
  if (!step('up', r.status === 0, r.status === 0 ? '' : why(r))) {
    diagnose(r);
    throw new Error('up failed');
  }

  step('no devnet.env', !existsSync(join(root, 'state/snowglobe/snowglobe/devnet.env')));
  r = sg(['env']);
  step(
    'env: settings, no password',
    r.status === 0 &&
      r.stdout.includes(`export SMOKE_PDS='https://alpha.${wantDomain}'`) &&
      /^export SMOKE_AUTHORITY_DID='did:plc:/m.test(r.stdout) &&
      r.stdout.includes(`export NODE_EXTRA_CA_CERTS='${join(root, 'state/snowglobe/ca/ca.crt')}'`) &&
      !r.stdout.includes('PASSWORD=') &&
      /^# SMOKE_ALICE_PASSWORD left out/m.test(r.stdout),
    why(r),
  );

  r = sg(['account', 'smoke-one', 'SMOKE_ONE']);
  step('account on the bare-handle PDS', r.status === 0 && r.stdout.startsWith('did:'), why(r));
  r = sg(['account', 'smoke-two', 'SMOKE_TWO', 'regular']);
  step('account on regular', r.status === 0 && r.stdout.startsWith('did:'), why(r));
  r = sg(['account', 'smoke-one', 'SMOKE_ONE']);
  step('account rerun finds it', r.status === 0 && /^Found /m.test(r.stderr), why(r));

  r = sg(['invite', 'SMOKE_INVITE']);
  const accounts = readFileSync(join(root, 'state/snowglobe/snowglobe/accounts.env'), 'utf8');
  step('invite', r.status === 0 && /^SMOKE_INVITE=./m.test(accounts), why(r));

  const lex = join(root, 'smoke-lexicons');
  mkdirSync(lex);
  for (const id of ['test.smoke.one', 'test.smoke.two'])
    writeFileSync(join(lex, `${id}.json`), JSON.stringify({ lexicon: 1, id, defs: { main: { type: 'token' } } }));
  r = sg(['lexicons', lex]);
  step('lexicons', r.status === 0 && r.stdout.trim().split('\n').length === 2, why(r));

  // run hands over the same settings, the login too, and the PDS they name answers.
  r = run([process.execPath, '-e', `if (!process.env.SMOKE_ALICE_PASSWORD) process.exit(2); fetch(process.env.SMOKE_PDS + '/xrpc/_health').then((r) => console.log(r.status), (e) => console.log(e.cause?.code ?? e.message))`]);
  step('run: the app\'s settings, and the PDS they name answers', r.stdout?.trim() === '200', r.stdout?.trim() || why(r));

  listener = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('smokeapp')).listen(${APP_PORT}, '0.0.0.0', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => listener.stdout.once('data', ok));
  r = sg(['app', 'smokeapp', String(APP_PORT), 'sm']);
  step('app add', r.status === 0, why(r));

  // Nothing maps a name: public DNS sends each one to the name router.
  const names = [wantDomain, ...['alpha', 'regular', 'prod'].map((p) => `${p}.${wantDomain}`), `smokeapp.app.${wantDomain}`, `made-later.alpha.${wantDomain}`];
  r = run(['getent', 'ahostsv4', ...names]);
  const routed = new Set((r.stdout ?? '').trim().split('\n').filter((l) => l.startsWith(`${ROUTER_ADDRESS} `)).map((l) => l.split(/\s+/).pop()));
  step('names resolve to the name router', names.every((n) => routed.has(n)), `${names.filter((n) => routed.has(n)).length} of ${names.length} on ${ROUTER_ADDRESS}`);

  // Node under run, with no flags: the names resolve and the CA is trusted.
  const fetches = `
    const urls = ['alpha', 'regular', 'prod'].map((p) => 'https://${wantDomain}/health/' + p).concat('https://smokeapp.app.${wantDomain}/x');
    Promise.all(urls.map((u) => fetch(u).then((r) => r.status, (e) => e.cause?.code ?? e.message))).then((s) => console.log(s.join(' ')));`;
  r = run([process.execPath, '-e', fetches]);
  step('run: health of each PDS, and the app', r.stdout?.trim() === '200 200 200 200', r.stdout?.trim() || why(r));

  r = sg(['app', '--remove', 'smokeapp']);
  step('app --remove', r.status === 0, why(r));
  // nginx reloads in the background, so the old route can answer for a moment.
  let gone = '';
  for (let n = 0; n < 10 && gone !== '404'; n++) {
    gone = run([process.execPath, '-e', `fetch('https://smokeapp.app.${wantDomain}/x').then((r) => console.log(r.status), (e) => console.log(e.cause?.code ?? e.message))`]).stdout?.trim();
    if (gone !== '404') spawnSync('sleep', ['1']);
  }
  step('removed app answers 404', gone === '404', gone);
} catch (e) {
  if (e.message !== 'up failed') step('smoke', false, e.message);
} finally {
  listener?.kill();
  // SMOKE_KEEP=1 leaves the containers up when a step failed, so CI can read their logs.
  if (process.env.SMOKE_KEEP && failed) {
    console.log('SMOKE_KEEP set: containers left running');
    process.exit(1);
  }
  const r = sg(['down', '-v'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const count = (args) =>
    spawnSync('docker', [...args, '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean).length;
  const containers = count(['ps', '-a']);
  const volumes = count(['volume', 'ls']);
  step('down -v leaves nothing', r.status === 0 && containers === 0 && volumes === 0, `${containers} containers, ${volumes} volumes`);
  step('down drops the route', !existsSync(join(routerDir(env), 'routes', PROJECT)));
}

console.log(`\n${failed ? `${failed} step(s) FAILED` : 'every step passed'}; the copy is ${root}`);
process.exit(failed ? 1 : 0);

// What every snowglobe subcommand shares: where the files are, the domain and the address the
// globe is under (read as compose reads them), env files that hold logins, docker compose on the
// rendered globe, and https to a globe's names. Nothing here prints a secret.
//

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDomain } from './config.mjs';

// The name router's address (lib/router.mjs): public DNS answers every name under
// local.snowglobe.at with it, and the router passes each connection on to the snowglobe whose
// domain the name is under. No snowglobe it routes to publishes here.
export const ROUTER_ADDRESS = '127.0.0.1';

/**
 * Whether this machine runs the name router: on Linux, unless SG_ROUTER=off. Elsewhere (and with
 * it off) every snowglobe publishes on 127.0.0.1 as before 0.5.0, and only the one there is
 * reached by name.
 */
export function routerRuns({ root = ROOT, env = process.env, platform = process.platform } = {}) {
  return platform === 'linux' && setting('SG_ROUTER', { root, env }) !== 'off';
}

// A mistake in how a command was called, as opposed to one the globe answered with.
export class UsageError extends Error {}

// A refusal with its own exit code (3: the shared devnet, guarded).
export class Refused extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * The compose project up and down act on: SG_PROJECT if set, else `name`, the globe's name in
 * its snowglobe.yml. Refused before anything else is done: none (a usage mistake), or
 * devnet-spaces, the shared devnet, without SG_RESET_OK=1 (exit 3).
 */
export function guardProject(env = process.env, name) {
  const project = env.SG_PROJECT || name;
  if (!project) throw new UsageError('no compose project: name one with SG_PROJECT, or run in a folder with a snowglobe.yml');
  if (project === 'devnet-spaces' && env.SG_RESET_OK !== '1')
    throw new Refused('refusing devnet-spaces, the shared devnet; set SG_RESET_OK=1 only for a planned reset', 3);
  return project;
}

// The repo root, which is also the compose project directory, where compose reads .env.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The folder all snowglobe state is under, for this user and not this checkout:
 * $XDG_DATA_HOME/snowglobe, else %LOCALAPPDATA%\\snowglobe on Windows, else
 * ~/.local/share/snowglobe. Each snowglobe has a folder of its own in it, named for the file's
 * `globe:`, and ca/ holds the one certificate authority they all use.
 */
export function stateRoot(env = process.env, { platform = process.platform, home = homedir() } = {}) {
  // XDG's rule: a relative XDG_DATA_HOME is ignored.
  if (env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)) return join(env.XDG_DATA_HOME, 'snowglobe');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'snowglobe');
  return join(home, '.local', 'share', 'snowglobe');
}

// The settings file compose reads beside the compose files (the repo root's .env).
export const dotenvFile = (root = ROOT) => join(root, '.env');

/**
 * The files a snowglobe keeps in `state`, its folder under stateRoot(), and the user's CA beside
 * it (<stateRoot>/ca). Nothing is kept in the checkout.
 */
export function paths(root = ROOT, state) {
  if (!state) throw new Error('no state folder given (a snowglobe keeps its files in one: lib/state.mjs session)');
  const data = state;
  const https = join(data, 'https');
  const globe = join(data, 'globe');
  const caDir = join(dirname(state), 'ca');
  return {
    root,
    data,
    https,
    // The CA, one per user, which run's processes and snowglobeRequest trust.
    caDir,
    ca: join(caDir, 'ca.crt'),
    // The snowglobe's own logins: the base init's alice, bob and invite code, the lexicon
    // authority, and accounts made by snowglobe account.
    accounts: join(data, 'accounts.env'),
    // The secrets the services start with (SECRETS below), made by up, once, and read by account
    // and invite. A file of its own: the base init rewrites accounts.env.
    secrets: join(data, 'secrets.env'),
    // The loopback address this snowglobe publishes its ports on (chooseBind), one line.
    bind: join(data, 'bind'),
    // Where the admin password was kept before secrets.env (read, never written, for a snowglobe made then).
    admin: join(data, 'admin.env'),
    // App routes, "<name> <port> [<ending>]" per line (snowglobe app).
    apps: join(https, 'apps'),
    // The rendered globe (bin/snowglobe.mjs render). Nothing in it is secret.
    globe,
    globeEnv: join(globe, 'globe.env'),
    leafNames: join(globe, 'leaf-names'),
    compose: join(globe, 'compose.yml'),
    dotenv: dotenvFile(root),
  };
}

// Files an older snowglobe kept in <root>/data, before state moved to the user's folder.
const OLD_FILES = ['accounts.env', 'accounts.json', 'devnet.env', 'globe', 'https/apps', 'https/names'];

/**
 * The text that says a checkout still holds a snowglobe's files from before state moved to the
 * user's folder (<root>/data/globe or data/devnet.env) while `state` has none, with the command
 * that moves them; null when it does not. Nothing is moved by snowglobe itself.
 */
export function oldDataNotice(root, state, platform = process.platform) {
  const data = join(root, 'data');
  if (!(existsSync(join(data, 'globe', 'compose.yml')) || existsSync(join(data, 'devnet.env')))) return null;
  if (existsSync(join(state, 'globe', 'compose.yml'))) return null;
  const project = envGet('SG_PROJECT', join(data, 'devnet.env'));
  const found = OLD_FILES.filter((f) => existsSync(join(data, f)));
  const win = platform === 'win32';
  const q = (x) => `"${x}"`;
  const move = win
    ? [`New-Item -ItemType Directory -Force ${q(join(state, 'https'))}`, ...found.map((f) => `Move-Item ${q(join(data, f))} ${q(join(state, f))}`)]
    : [`mkdir -p ${q(join(state, 'https'))}`, ...found.map((f) => `mv ${q(join(data, f))} ${q(join(state, f))}`)];
  return [
    `${data} holds a snowglobe from before state moved out of the checkout (into ${state}). Nothing was changed.`,
    `To keep it, move its files${project ? ` and keep its compose project (its containers and volumes belong to ${project})` : ''}:`,
    ...move.map((l) => `  ${l}`),
    project ? `  ${win ? '$env:SG_PROJECT' : 'SG_PROJECT'}=${project} snowglobe up` : '  snowglobe up',
    "Either way it trusts a new CA, once: snowglobe now makes one for you in place of the checkout's old one.",
  ].join('\n');
}

/**
 * The text that says the default snowglobe was named devnet before it was named snowglobe, and an
 * install made under the old name is still in the state root while `state` has none, with the
 * commands to keep it or drop it; null when it does not. Nothing is moved by snowglobe itself.
 * A snowglobe made from a file of your own is not affected: it keeps the file's `globe:` name.
 */
export function renamedDefaultNotice(root, state, platform = process.platform) {
  const old = join(dirname(state), 'devnet');
  if (!existsSync(join(old, 'globe', 'compose.yml')) || existsSync(join(state, 'globe', 'compose.yml'))) return null;
  const win = platform === 'win32';
  const q = (x) => `"${x}"`;
  const keep = win
    ? [`Move-Item ${q(old)} ${q(state)}`, "$env:SG_PROJECT='devnet'", 'snowglobe up --default']
    : [`mv ${q(old)} ${q(state)}`, 'SG_PROJECT=devnet snowglobe up --default'];
  return [
    `${old} holds the default snowglobe from before it was renamed (it was called devnet, and is called snowglobe now). Nothing was changed.`,
    'To keep it, with its accounts, move its folder and keep its compose project (its containers and volumes belong to devnet; their network and images are recreated under the new names):',
    ...keep.map((l) => `  ${l}`),
    'To drop it, remove its containers and volumes, then delete the folder:',
    `  docker compose -p devnet --project-directory ${q(root)} -f ${q(join(old, 'globe', 'compose.yml'))} down -v`,
    `  ${win ? 'Remove-Item -Recurse' : 'rm -r'} ${q(old)}`,
  ].join('\n');
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []);

// Until 2026-10-20 the settings were DEVNET_* and SNOWGLOBE_*; every one is SG_* now. The old
// names still work for a while: adoptOldNames copies each one to its SG_ name, and envGet falls
// back to them in a file written before the change.
const OLD_NAME = /^(?:DEVNET|SNOWGLOBE)_([A-Za-z0-9_]+)$/;
const oldNames = (name) => (name.startsWith('SG_') ? [`DEVNET_${name.slice(3)}`, `SNOWGLOBE_${name.slice(3)}`] : []);

// The last value of NAME in an env file the scripts write (NAME=value, nothing else), or ''.
// An SG_ name the file lacks is looked up under its old names.
export function envGet(name, file) {
  const ls = lines(file);
  for (const n of [name, ...oldNames(name)]) {
    let value;
    for (const l of ls) if (l.startsWith(`${n}=`)) value = l.slice(n.length + 1);
    if (value !== undefined) return value;
  }
  return '';
}

/**
 * Each old setting (DEVNET_*, SNOWGLOBE_*) in the environment or .env whose SG_ name neither sets
 * is copied into env under the SG_ name, so the commands and compose see it; one warning names
 * them. Returns the old names taken.
 */
export function adoptOldNames({ root = ROOT, env = process.env, warn = (m) => console.error(m) } = {}) {
  const dotenv = dotenvFile(root);
  const taken = new Map();
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(OLD_NAME);
    if (m && env[`SG_${m[1]}`] === undefined) taken.set(`SG_${m[1]}`, { old: k, value: v });
  }
  for (const l of lines(dotenv)) {
    const k = l.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/)?.[1];
    const m = k?.match(OLD_NAME);
    const name = m && `SG_${m[1]}`;
    if (m && env[name] === undefined && !taken.has(name) && envCompose(name, dotenv) === undefined)
      taken.set(name, { old: `${k} (in .env)`, value: envCompose(k, dotenv) });
  }
  for (const [name, { value }] of taken) env[name] = value;
  if (taken.size)
    warn(
      `snowglobe: old setting names, still read for now: ${[...taken].map(([name, { old }]) => `${old} is now ${name}`).join('; ')}`,
    );
  return [...taken.values()].map((t) => t.old);
}

// NAME's last value in an env file read as compose reads it: an export prefix, spaces around
// the =, quotes, a trailing " # comment" and a CRLF line end are allowed. undefined when the
// file does not set it.
export function envCompose(name, file) {
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  let raw;
  for (const l of lines(file)) {
    const m = l.replace(/\r$/, '').match(re);
    if (m) raw = m[1];
  }
  if (raw === undefined) return undefined;
  const quoted = raw.match(/^"([^"]*)"/) ?? raw.match(/^'([^']*)'/);
  if (quoted) return quoted[1];
  return raw.replace(/\s+#.*/, '').replace(/\s+$/, '');
}

// A setting from the environment, where set (even empty, which then wins), else from .env, as
// compose reads it; '' when neither sets it.
export function setting(name, { root = ROOT, env = process.env } = {}) {
  return env[name] !== undefined ? env[name] : (envCompose(name, dotenvFile(root)) ?? '');
}

// The domain every globe name sits under: SG_DOMAIN from the environment or .env; else the
// rendered globe's, which is the file's unless one of those replaced it; else the globe's own,
// <name of its state folder>.local.snowglobe.at.
// A setting that differs from the rendered globe's means the render is stale: refused, unless
// this run is about to render again (rendering). `set` is the setting alone, for render --domain.
export function resolveDomain({ root = ROOT, state, env = process.env, rendering = false } = {}) {
  const p = paths(root, state);
  const set = setting('SG_DOMAIN', { root, env });
  const rendered = envGet('SG_DOMAIN', p.globeEnv);
  if (set && rendered && set !== rendered && !rendering)
    throw new Error(`SG_DOMAIN=${set}, but the globe in ${p.globe} was rendered for ${rendered}; run snowglobe up`);
  const domain = set || rendered || localDomain(basename(state));
  // A domain name and nothing else. This also refuses ${...} in .env, which compose would
  // expand and these scripts do not.
  if (/[^A-Za-z0-9.-]/.test(domain) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..'))
    throw new Error(`SG_DOMAIN=${domain} is not a domain name (set in the environment or .env)`);
  return { domain, set };
}

// The rendered globe's facts (globe.env): its domain, its PDSes by name, the one with bare
// handles (<name>.<domain>, '' if none), those that take an invite code, the seed and authority
// PDSes, and the names under the domain a bare handle would take.
export function globeFacts({ root = ROOT, state, env = process.env } = {}) {
  const p = paths(root, state);
  if (!existsSync(p.globeEnv)) throw new Error(`No ${p.globeEnv}: run snowglobe up, which renders it`);
  const list = (name) => envGet(name, p.globeEnv).split(' ').filter(Boolean);
  return {
    domain: resolveDomain({ root, state, env }).domain,
    pds: list('SG_PDS'),
    bare: envGet('SG_BARE_PDS', p.globeEnv),
    invites: list('SG_INVITE_PDS'),
    seed: envGet('SG_SEED_PDS', p.globeEnv),
    authority: envGet('SG_AUTHORITY_PDS', p.globeEnv),
    taken: list('SG_TAKEN'),
  };
}

// The loopback address nginx and every other published port use, worked out as compose works out
// ${SG_BIND:-127.0.0.1}: SG_BIND where set, else the one `up` chose for this snowglobe (the bind
// file in its state folder), else 127.0.0.1. A loopback address only (127.x.y.z, one per globe run
// side by side): the globe's logins are throwaway, so it is never published beyond this machine.
export function resolveBind({ root = ROOT, state, env = process.env } = {}) {
  const saved = state && existsSync(paths(root, state).bind) ? readFileSync(paths(root, state).bind, 'utf8').trim() : '';
  const bind = setting('SG_BIND', { root, env }) || saved || '127.0.0.1';
  const parts = bind.split('.');
  if (parts.length !== 4 || parts[0] !== '127' || parts.slice(1).some((x) => !/^[0-9]+$/.test(x) || Number(x) > 255))
    throw new Error(`SG_BIND=${bind} is not a loopback address 127.x.y.z (set in the environment or .env)`);
  return bind;
}

// The ports a snowglobe publishes on its address: nginx, and the tools (each can be moved with its SG_..._PORT).
// Tap's is probed whether or not this globe runs Tap: an address another globe's Tap answers on is not free.
const PUBLISHED = [['', 443], ['SG_PROXY_PORT', 1080], ['SG_MAILDEV_WEB_PORT', 1081], ['SG_MAILDEV_SMTP_PORT', 1026], ['SG_PLC_PORT', 2582], ['SG_JETSTREAM_PORT', 6008], ['SG_JETSTREAM_METRICS_PORT', 6009], ['SG_TAP_PORT', 2480]];

// Whether something already answers on any port a snowglobe would publish on a loopback address.
export async function addressBusy(address, { root = ROOT, env = process.env } = {}) {
  const answers = (port) =>
    new Promise((done) => {
      const s = net.connect({ host: address, port, timeout: 500 });
      s.on('connect', () => (s.destroy(), done(true)));
      s.on('timeout', () => (s.destroy(), done(false)));
      s.on('error', () => done(false));
    });
  const ports = PUBLISHED.map(([name, port]) => Number((name && setting(name, { root, env })) || port));
  return (await Promise.all(ports.map(answers))).some(Boolean);
}

// Whether the compose project's own nginx is running now.
export function ownNginxUp(project, env = process.env) {
  const res = spawnSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=nginx'], { encoding: 'utf8', env });
  return !res.error && res.status === 0 && res.stdout.trim() !== '';
}

/**
 * The loopback address this snowglobe publishes on, chosen once and kept in its state folder, so a
 * second snowglobe on the machine starts beside the first with no settings: it takes the first
 * 127.0.0.N that no other snowglobe in the same user folder has kept and nothing answers on 443 or any other port it publishes.
 * Where the name router runs (routerRuns), that starts at 127.0.0.2: 127.0.0.1 is the router's.
 * SG_BIND, where set, wins and nothing is written. A snowglobe that is already running with no
 * address kept was made before this and is on 127.0.0.1, so it keeps that. One that kept
 * 127.0.0.1 before the router existed moves to a free address when it is not running: what it
 * holds depends on its domain, not its address. Returns the address.
 */
export async function chooseBind({ root = ROOT, state, project, env = process.env, listening = (a) => addressBusy(a, { root, env }), ownUp = ownNginxUp, platform = process.platform } = {}) {
  const p = paths(root, state);
  if (setting('SG_BIND', { root, env })) return resolveBind({ root, state, env });
  const routed = routerRuns({ root, env, platform });
  const keep = () => existsSync(p.bind) && !(routed && resolveBind({ root, state, env }) === ROUTER_ADDRESS && !ownUp(project, env));
  if (keep()) return resolveBind({ root, state, env });
  // Choosing reads the other bind files, waits on probes, then writes ours, so two first starts at
  // once would both pick the same address and keep it. One at a time, under a lock beside the state folders.
  return withLock(join(dirname(state), '.bind-lock'), async () => {
    if (keep()) return resolveBind({ root, state, env });
    return pickBind({ p, state, project, env, listening, ownUp, first: routed ? 2 : 1 });
  });
}

// Run `fn` holding a lock directory (mkdir is atomic). A lock older than `stale` ms was left by a
// process that died. It is not taken over, since two starts taking it over at once could both
// hold it; up stops and names the folder to remove.
async function withLock(dir, fn, { stale = 60000, wait = 30000 } = {}) {
  mkdirSync(dirname(dir), { recursive: true });
  const until = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try {
        age = Date.now() - statSync(dir).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > stale) throw new Error(`a snowglobe that stopped while choosing an address left ${dir}; remove that folder, then up again`);
      if (Date.now() > until) throw new Error(`another snowglobe is choosing an address (${dir}); remove that folder if none is`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pickBind({ p, state, project, env, listening, ownUp, first }) {
  const used = new Set();
  const top = dirname(state);
  for (const d of existsSync(top) ? readdirSync(top) : []) {
    const f = join(top, d, 'bind');
    if (join(top, d) !== state && existsSync(f)) used.add(readFileSync(f, 'utf8').trim());
  }
  let bind = '127.0.0.1';
  if (!ownUp(project, env)) {
    bind = '';
    for (let n = first; n <= 50 && !bind; n++) {
      const a = `127.0.0.${n}`;
      if (!used.has(a) && !(await listening(a))) bind = a;
    }
    if (!bind) throw new Error(`every loopback address from 127.0.0.${first} to 127.0.0.50 is in use; set SG_BIND to one that is free`);
  }
  writeFileSync(p.bind, `${bind}\n`);
  return bind;
}

// Replace the lines of an env file matching `drop` with `add` (lines, no newlines). The file is
// mode 600, and never readable by anyone else, even briefly: it is written aside at 600, then
// renamed over the old one.
export function envPut(file, drop, add = []) {
  const kept = lines(file).filter((l) => l !== '' && !drop.test(l));
  const text = [...kept, ...add].map((l) => `${l}\n`).join('');
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

// Mode 600, even if a container wrote the file: it then belongs to root, and only a rewrite
// makes it ours.
export function makePrivate(file) {
  if (!existsSync(file)) return;
  if (statSync(file).uid === process.getuid?.()) chmodSync(file, 0o600);
  else envPut(file, /^$/);
}

// The env file for logins: made if missing, and private either way.
export function loginsFile(file) {
  if (!existsSync(file)) envPut(file, /^$/);
  makePrivate(file);
  return file;
}

// The secrets a snowglobe's services start with: the PDSes' admin password, JWT secret and PLC
// rotation key, the relay's admin password and the PLC database's. `up` makes each one random,
// once, per snowglobe (ensureSecrets); the compose files take them as ${SG_...:?}, so none has a
// default. `bytes` is how many random bytes (the rotation key is a 32-byte secp256k1 key).
// `legacy` is the fixed value every snowglobe used before they were random: a snowglobe whose data
// was made under it keeps it, because Postgres keeps the password it was first started with and
// a DID's PLC record names the rotation key that made it. The admin password was never fixed.
export const SECRETS = {
  SG_PDS_ADMIN_PASSWORD: { bytes: 24 },
  SG_PDS_JWT_SECRET: { bytes: 24, legacy: 'devnet-jwt-secret-not-for-production' },
  SG_PLC_ROTATION_KEY: { bytes: 32, legacy: '0123456789abcdef'.repeat(4) },
  SG_RELAY_ADMIN_PASSWORD: { bytes: 24, legacy: 'devnet-relay-admin' },
  SG_DB_PASSWORD: { bytes: 24, legacy: 'postgres' },
};

// A secret's value: the environment's or .env's (a globe on the cluster has its own), else the
// one up made for this snowglobe in its secrets.env (for the admin password, else its older admin.env); '' when none.
export function secret(name, { root = ROOT, state, env = process.env } = {}) {
  const set = setting(name, { root, env });
  if (set || !state) return set || '';
  const p = paths(root, state);
  // The admin password up made before secrets.env existed is still the snowglobe's: its PDSes
  // were started with it, so it is kept, not replaced by a new one.
  return envGet(name, p.secrets) || (name === 'SG_PDS_ADMIN_PASSWORD' ? envGet(name, p.admin) : '');
}

export const adminPassword = (opts) => secret('SG_PDS_ADMIN_PASSWORD', opts);

/**
 * Every secret in SECRETS, made first where there is none: random, and kept in secrets.env (mode
 * 600) so the same one is used on every later up. Where the snowglobe already has data (`hasData()`
 * is true, asked only when a secret that used to be fixed is missing; null, Docker could not say, is refused) a secret that used to be fixed keeps its fixed
 * value instead. Returns { values, kept }: each secret's value, and the names that kept a fixed
 * one. A value set in the environment or .env is used and not written. Never prints a value.
 */
export function ensureSecrets({ root = ROOT, state, env = process.env, hasData = () => false } = {}) {
  const values = {};
  const kept = [];
  const made = [];
  let data;
  for (const [name, { bytes, legacy }] of Object.entries(SECRETS)) {
    let value = secret(name, { root, state, env });
    if (!value) {
      // Only a secret that used to be fixed depends on whether there is data; the answer is asked once.
      if (legacy !== undefined && data === undefined) {
        data = hasData();
        if (data === null) throw new Error('Docker did not say whether this snowglobe already has data (docker volume ls failed), so up will not choose its secrets yet: start Docker, then run up again');
      }
      if (legacy !== undefined && data) {
        value = legacy;
        kept.push(name);
      } else value = randomBytes(bytes).toString('hex');
      made.push(name);
    }
    values[name] = value;
  }
  if (made.length) {
    const p = paths(root, state);
    mkdirSync(p.data, { recursive: true });
    envPut(loginsFile(p.secrets), new RegExp(`^(${made.join('|')})=`), made.map((n) => `${n}=${values[n]}`));
  }
  return { values, kept };
}

/** Whether Docker holds volumes for the compose project: null when Docker cannot say, which is not an answer to act on. */
export function projectHasData(project, env = process.env) {
  const res = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8', env });
  return res.error || res.status !== 0 ? null : res.stdout.trim() !== '';
}

/**
 * After `down -v`, the fixed secrets (SECRETS' legacy values) are dropped from secrets.env: the
 * data they were kept for is gone, so the next up makes random ones. Random ones stay, and a
 * secret set in the environment or .env is not in the file.
 */
export function dropLegacySecrets({ root = ROOT, state } = {}) {
  const file = paths(root, state).secrets;
  if (!existsSync(file)) return;
  const old = Object.entries(SECRETS).filter(([n, { legacy }]) => legacy !== undefined && envGet(n, file) === legacy).map(([n]) => n);
  if (old.length) envPut(file, new RegExp(`^(${old.join('|')})=`));
}

// docker compose on `project` with the rendered globe. Its paths are from the repo root, which is
// also where compose reads .env. Returns spawnSync's result; stdio as given (inherited by default),
// env as given (this process's by default), for compose to fill the file's ${...} from.
export function dc(project, args, { root = ROOT, state, stdio = 'inherit', encoding, env } = {}) {
  const p = paths(root, state);
  if (!existsSync(p.compose)) {
    const old = oldDataNotice(root, state);
    throw new Error(`No ${p.compose}: run snowglobe up, which renders it${old ? `\n${old}` : ''}`);
  }
  // compose fills the file's ${SG_...:?} secrets from these, and refuses to read the file without
  // them. up makes the real ones first; down and ps on a snowglobe that up has not made them for
  // need only a value for compose to read the file.
  const base = env ?? process.env;
  const secrets = Object.fromEntries(Object.keys(SECRETS).map((n) => [n, secret(n, { root, state, env: base }) || 'unset-run-snowglobe-up']));
  return spawnSync('docker', ['compose', '-p', project, '--project-directory', root, '-f', p.compose, ...args], {
    stdio,
    encoding,
    env: { ...base, ...secrets, SG_BIND: resolveBind({ root, state, env: base }) },
  });
}

// An https request to a globe's name: the name goes to nginx on SG_BIND, and TLS is verified
// against the globe's CA. With SG_PUBLIC=1 the names are public ones with a real certificate
// (a globe on the cluster), so the URL is used as it stands, through public DNS and the system's
// CAs. Resolves to { status, body } (body a string); never logs the request or the answer.
export function snowglobeRequest(url, { method = 'GET', headers = {}, body, root = ROOT, state, env = process.env } = {}) {
  const pub = env.SG_PUBLIC === '1';
  const options = { method, headers };
  if (!pub) {
    const bind = resolveBind({ root, state, env });
    options.ca = readFileSync(paths(root, state).ca);
    options.lookup = (_host, opts, cb) =>
      opts?.all ? cb(null, [{ address: bind, family: 4 }]) : cb(null, bind, 4);
  }
  return new Promise((done, fail) => {
    const req = request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(body);
  });
}

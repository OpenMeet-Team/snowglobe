// bin/snowglobe.mjs env [--app <name>] [--secrets] [--dotenv]
//
// env prints the settings an app is handed, from the apps[].env of the snowglobe.yml in this folder
// (or above), as `export NAME='value'` lines for `eval "$(snowglobe env)"`, plus
// NODE_EXTRA_CA_CERTS, the CA that signs the snowglobe's certificates. --dotenv prints NAME=value
// instead, for a framework's own file (.env.local, .dev.vars) or PowerShell. With one app in the
// file it is that app's; with several --app says which; with none only the CA is set.
//
// A secret (accounts.<name>.password) is left out unless --secrets is given, and a comment line
// names each one left out. snowglobe run hands the same settings over, secrets included. Values
// known only after up are read from the state folder; before then env says which are missing.
// lib/settings.mjs has the names.

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, UsageError, envGet, paths, resolveBind, resolveDomain, setting } from '../env.mjs';
import { ownerOf, session } from '../state.mjs';
import { isSecret, lookup, parseValue } from '../settings.mjs';
import { accountPrefixes } from '../up.mjs';
import { checkedGlobe } from './check.mjs';

export const command = {
  name: 'env',
  usage: 'env [--app <name>] [--secrets] [--dotenv]',
  options: { app: { type: 'string' }, secrets: { type: 'boolean' }, dotenv: { type: 'boolean' } },
  positionals: [0, 0],
};

export function run({ values }) {
  const s = appSettings({ app: values.app, secrets: values.secrets });
  process.stdout.write(formatEnv(s, { dotenv: values.dotenv }));
  if (s.differs) console.error(`snowglobe env: ${s.differs}`);
  if (!s.caExists) console.error(`snowglobe env: ${s.ca} does not exist yet; snowglobe up (or certs) makes it`);
}

/**
 * The snowglobe a command reads settings from: { path, globe, state, p, later, differs }. `later`
 * gives the names known only after up, from the state folder (undefined where it has none yet).
 * `differs` is one line when the file differs from the globe the last up rendered, else null.
 * Throws, after printing each problem, when the file has any.
 */
function load({ file, root = ROOT, env = process.env } = {}) {
  const found = session({ file, env });
  const { set } = resolveDomain({ root, state: found.state, env });
  const { path, globe } = checkedGlobe(found.path, { domain: set || undefined });
  if (!globe) throw new Error(`${path} has problems (above)`);
  const p = paths(root, found.state);
  const home = (globe.pds.find((x) => x.bare_handles) ?? globe.pds[0]).name;
  const prefixes = new Map(accountPrefixes(globe.accounts, home).map((a) => [a.name, a.prefix]));
  const later = (name) => {
    const [head, ...rest] = name.split('.');
    const kept = (key) => envGet(key, p.accounts) || undefined;
    // Each exists only once up has run; a path or port guessed before then would be wrong.
    if (name === 'ca.file') return existsSync(p.ca) ? p.ca : undefined;
    if (name === 'accounts.file') return existsSync(p.accounts) ? p.accounts : undefined;
    // The mail page's port is a setting, not recorded in the state; the rendered globe says up has run.
    if (name === 'services.mail.url') return !existsSync(p.compose) ? undefined : `http://${resolveBind({ root, state: found.state, env })}:${setting('SG_MAILDEV_WEB_PORT', { root, env }) || '1081'}`;
    if (name === 'services.tap.url') return !existsSync(p.compose) ? undefined : `http://${resolveBind({ root, state: found.state, env })}:${setting('SG_TAP_PORT', { root, env }) || '2480'}`;
    if (name === 'lexicons.authority.did') return kept('LEX_AUTHORITY_DID');
    if (head === 'accounts') return kept(`${prefixes.get(rest[0])}_${rest[1].toUpperCase()}`);
    return undefined;
  };
  return { path, globe, state: found.state, p, later, differs: differs({ ...found, path, globe, p, prefixes }) };
}

// The last up decides what runs, so a file with the same globe: name that says otherwise would
// hand over settings for a globe that is not running: one line saying where they part, or null.
function differs({ name, state, path, globe, p, prefixes }) {
  if (!existsSync(p.globeEnv)) return null;
  const what = [];
  const domain = envGet('SG_DOMAIN', p.globeEnv);
  if (domain && domain !== globe.domain) what.push(`domain ${domain}, not ${globe.domain}`);
  const pds = envGet('SG_PDS', p.globeEnv);
  const mine = globe.pds.map((x) => x.name).join(' ');
  if (pds && pds !== mine) what.push(`PDSs ${pds}, not ${mine}`);
  for (const a of globe.accounts) {
    const kept = envGet(`${prefixes.get(a.name)}_HANDLE`, p.accounts);
    if (kept && kept !== a.handle) what.push(`account ${a.name} ${kept}, not ${a.handle}`);
  }
  if (!what.length) return null;
  const last = ownerOf(state);
  const by = last && last !== realpathSync(resolve(path)) ? `, as ${last} last brought it up` : '';
  return `${path} differs from the snowglobe ${name}${by}: ${what.join('; ')}. These settings are this file's; snowglobe up here to run it`;
}

// The text of a value with its placeholders filled, or the names that could not be.
function fill(globe, text, later) {
  const out = [];
  for (const part of parseValue(text).parts) {
    if (part.text !== undefined) out.push(part.text);
    else {
      const r = lookup(globe, part.name, later);
      if (r.error) throw new Error(r.error);
      out.push(r.value);
    }
  }
  return out.join('');
}

/**
 * The settings of one app of the file: { vars, left, ca, caExists }. vars is [{ name, value }] in the
 * order the file gives them; left is [{ name, via }] for the secrets not included (without
 * `secrets`), via the secret names in the value. The app is `app`, or the file's one app; with
 * several `app` is required, with none vars is empty. NODE_EXTRA_CA_CERTS joins vars unless the
 * app sets it itself.
 */
export function appSettings({ app, secrets = false, file, root = ROOT, env = process.env } = {}) {
  const { path, globe, p, later, differs } = load({ file, root, env });
  const names = globe.apps.map((a) => a.name);
  let chosen = null;
  if (app !== undefined) {
    chosen = globe.apps.find((a) => a.name === app);
    if (!chosen) throw new UsageError(`${path} has no app named ${app} (${names.join(', ') || 'it lists none'})`);
  } else if (globe.apps.length === 1) chosen = globe.apps[0];
  else if (globe.apps.length > 1) throw new UsageError(`${path} lists several apps (${names.join(', ')}); say which with --app <name>`);

  const vars = [];
  const left = [];
  for (const [name, text] of Object.entries(chosen?.env ?? {})) {
    const via = parseValue(text).parts.filter((x) => x.name && isSecret(x.name)).map((x) => x.name);
    if (via.length && !secrets) left.push({ name, via });
    else {
      try {
        const value = fill(globe, text, later);
        // Said by name only: the value may hold a login.
        if (value.includes('\0')) throw new Error('the value contains a NUL character, which a process cannot be given');
        vars.push({ name, value });
      } catch (e) {
        throw new Error(`${path}: apps[${globe.apps.indexOf(chosen)}].env.${name}: ${e.message}`);
      }
    }
  }
  if (!vars.some((v) => v.name === 'NODE_EXTRA_CA_CERTS')) vars.push({ name: 'NODE_EXTRA_CA_CERTS', value: p.ca, auto: true });
  return { vars, left, ca: p.ca, caExists: existsSync(p.ca), differs };
}

/**
 * The values of `names` (such as 'domain' or 'lexicons.authority.did') in the snowglobe file reads,
 * for a script that wants a fact without an app to map it. Throws on a name the file has no value for.
 */
export function resolveNames(names, { file, root = ROOT, env = process.env } = {}) {
  const { globe, later } = load({ file, root, env });
  return names.map((n) => fill(globe, `\${${n}}`, later));
}

const quoteSh = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
// A dotenv value as dotenv (16) reads it, and Vite, which expands $NAME and ${NAME} after it. Bare
// when plain; else in the first quote the value does not hold, single first because dotenv takes
// that literally (double quotes expand \n and \r). null when no form reads back as the value: a
// $ that starts a name, a carriage return, or a value with every quote in it.
function quoteDotenv(v) {
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(v)) return v;
  if (/\$[A-Za-z_{]/.test(v) || v.includes('\r')) return null;
  for (const q of ["'", '`', '"']) if (!v.includes(q) && !(q === '"' && /\\[nr]/.test(v))) return `${q}${v}${q}`;
  return null;
}

/** The lines env prints for `settings` (appSettings): export lines, or NAME=value with `dotenv`. */
export function formatEnv({ vars, left }, { dotenv = false } = {}) {
  const line = (v) => {
    if (!dotenv) return `export ${v.name}=${quoteSh(v.value)}`;
    const q = quoteDotenv(v.value);
    if (q === null) throw new Error(`${v.name} cannot be written as a dotenv value (it holds a $ that starts a name, a carriage return, or every kind of quote); use snowglobe env without --dotenv`);
    return `${v.name}=${q}`;
  };
  const note = (l) => `# ${l.name} left out: ${l.via.join(', ')} ${l.via.length > 1 ? 'are secrets' : 'is a secret'}; --secrets includes it`;
  const lines = [...vars.filter((v) => v.name !== 'NODE_EXTRA_CA_CERTS').map(line), ...left.map(note), ...vars.filter((v) => v.name === 'NODE_EXTRA_CA_CERTS').map(line)];
  return lines.map((l) => `${l}\n`).join('');
}

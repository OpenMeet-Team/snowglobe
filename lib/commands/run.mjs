// bin/snowglobe.mjs run [--app <name>] [--] <cmd> [args...]
//
// run runs a command with the snowglobe around it, for that command's process tree only:
//   - it is handed the app's settings, the apps[].env of the snowglobe.yml (lib/commands/env.mjs;
//     the same as snowglobe env, secrets included, none printed). They win over a value already in
//     the environment, and one line names the ones they replaced. --app picks the app when the
//     file lists several;
//   - the globe's names (its page, each PDS, its services and plc.directory, from the rendered
//     globe), every handle in https/names (account and up add them) and every app in
//     https/apps, as <name>.app.<domain>, resolve to SG_BIND, where nginx answers on
//     443 (lib/hosts.mjs). HTTPS_RUN_EXTRA_NAMES adds names (space-separated);
//   - Node trusts the globe's CA (NODE_EXTRA_CA_CERTS=<state root>/ca/ca.crt), on top of its own
//     roots. Miniflare passes the same file on to workerd.
//
// The globe is the one the snowglobe.yml in this folder (or above) describes, as for up.
//
// e.g. bin/snowglobe.mjs run node scripts/https-probe.mjs
//      (cd ../myapp && ../snowglobe/bin/snowglobe.mjs run npm run dev)
//
// How: bubblewrap gives the command its own mount namespace with a generated hosts file bound
// over /etc/hosts. Nothing else changes: same filesystem, same network, same user. Outside,
// every name resolves as usual. The names are read when the command starts, so a handle or app
// added later needs a restart of the command. Linux only: a Mac has no bubblewrap, and reaches
// the globe through snowglobe env instead (the names resolve through public DNS, and the CA is in
// NODE_EXTRA_CA_CERTS).

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { constants as os } from 'node:os';
import { delimiter, join } from 'node:path';
import { readApps } from '../apps.mjs';
import { ROOT, paths, resolveBind, resolveDomain } from '../env.mjs';
import { hostsFile, runNames } from '../hosts.mjs';
import { session } from '../state.mjs';
import { appSettings } from './env.mjs';

export const command = {
  name: 'run',
  usage: 'run [--app <name>] [--] <cmd> [args...]',
  // Every word after run is the command's own, dashes and all, except an --app <name> first of
  // all; none is a usage mistake.
  parse: (args) => {
    const named = args[0] === '--app';
    if (named && args.length < 2) return null;
    const rest = named ? args.slice(2) : args;
    const cmd = rest[0] === '--' ? rest.slice(1) : rest;
    return cmd.length ? { cmd, app: named ? args[1] : undefined } : null;
  },
};

// The first `name` on PATH that can be run, or null.
function onPath(name, env) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

export function run({ cmd, app }) {
  const s = appSettings({ app, secrets: true });
  if (s.differs) console.error(`snowglobe run: ${s.differs}`);
  return runUnder(cmd, { settings: s.vars });
}

/**
 * Run `cmd` (a word list) under the globe's names with `settings` ([{ name, value }], from
 * appSettings) in its environment; resolves to its exit code. A setting replaces a value of the same
 * name already in `env`, and `log` is told which.
 */
export function runUnder(cmd, { root = ROOT, env = process.env, state = session({ env }).state, settings = [], log = (m) => console.error(m) } = {}) {
  if (process.platform !== 'linux')
    throw new Error('run needs Linux (bubblewrap) for now; on this system eval "$(snowglobe env)" hands the app the same settings');
  const p = paths(root, state);
  if (!existsSync(p.ca)) throw new Error(`no ${p.ca}; run snowglobe up (or certs) first`);
  if (!existsSync(p.leafNames)) throw new Error(`no ${p.leafNames}; run snowglobe up first`);
  const bwrap = onPath('bwrap', env);
  if (!bwrap) throw new Error('bwrap (bubblewrap) is not installed, or not on PATH');
  // Refuses a SG_DOMAIN the render is not for, and a SG_BIND that is not loopback.
  const { domain } = resolveDomain({ root, state, env });
  const bind = resolveBind({ root, state, env });

  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const names = runNames({ leafNames: read(p.leafNames), handles: read(p.names), apps: readApps(p), domain, extra: env.HTTPS_RUN_EXTRA_NAMES });
  // Written aside and renamed, so a run already holding the old file is undisturbed.
  const hosts = join(p.https, 'hosts');
  writeFileSync(`${hosts}.tmp.${process.pid}`, hostsFile(read('/etc/hosts'), names, bind), { mode: 0o644 });
  renameSync(`${hosts}.tmp.${process.pid}`, hosts);

  // Never the values: a setting may be a login.
  const replaced = settings.filter((x) => !x.auto && env[x.name] !== undefined && env[x.name] !== x.value).map((x) => x.name);
  if (replaced.length) log(`snowglobe run: the snowglobe's settings replaced ${replaced.join(', ')} from the environment`);

  const child = spawn(bwrap, ['--dev-bind', '/', '/', '--ro-bind', hosts, '/etc/hosts', '--die-with-parent', '--', ...cmd], {
    stdio: 'inherit',
    env: { ...env, NODE_EXTRA_CA_CERTS: p.ca, ...Object.fromEntries(settings.map((x) => [x.name, x.value])) },
  });
  // A terminal's ^C reaches the whole process group, the command included, so it is left to the
  // command; a signal sent to run alone is passed on.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  return new Promise((done, fail) => {
    // A spawn error can quote an environment value; a setting may be a login, so it is named instead.
    child.on('error', (e) => {
      let msg = e.message;
      for (const x of settings) if (x.value) msg = msg.split(x.value).join(`<${x.name}>`);
      fail(Object.assign(new Error(msg), { code: e.code }));
    });
    child.on('exit', (code, signal) => done(signal ? 128 + (os.signals[signal] ?? 0) : code));
  });
}

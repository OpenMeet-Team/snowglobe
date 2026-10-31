// bin/snowglobe.mjs run [--app <name>] [--] <cmd> [args...]
//
// run runs a command with the snowglobe's settings:
//   - it is handed the app's settings, the apps[].env of the snowglobe.yml (lib/commands/env.mjs;
//     the same as snowglobe env, secrets included, none printed). They win over a value already in
//     the environment, and one line names the ones they replaced. --app picks the app when the
//     file lists several;
//   - Node trusts the globe's CA (NODE_EXTRA_CA_CERTS=<state root>/ca/ca.crt), on top of its own
//     roots. Miniflare passes the same file on to workerd.
//
// The globe is the one the snowglobe.yml in this folder (or above) describes, as for up.
//
// e.g. bin/snowglobe.mjs run node scripts/https-probe.mjs
//      (cd ../myapp && ../snowglobe/bin/snowglobe.mjs run npm run dev)
//
// Nothing maps names. Each snowglobe has a domain of its own under local.snowglobe.at, whose
// public DNS answers every name with 127.0.0.1, where the name router passes each connection to
// the snowglobe the name is under (lib/router.mjs). So every name resolves as it does anywhere on
// the machine, a handle made after the command started included. plc.directory is the real one:
// an app takes the snowglobe's PLC directory as a setting (${services.plc.url}), as it must on a
// hosted globe. A domain of your own, outside local.snowglobe.at, has to resolve to 127.0.0.1 the
// same way.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as os } from 'node:os';
import { ROOT, paths, resolveDomain } from '../env.mjs';
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

export const run = ({ cmd, app }) => runUnder(cmd, { settings: appSettings({ app, secrets: true }).vars });

/**
 * Run `cmd` (a word list) with `settings` ([{ name, value }], from appSettings) and the globe's CA
 * in its environment; resolves to its exit code. A setting replaces a value of the same name
 * already in `env`, and `log` is told which.
 */
export function runUnder(cmd, { root = ROOT, env = process.env, state = session({ env }).state, settings = [], log = (m) => console.error(m) } = {}) {
  const p = paths(root, state);
  if (!existsSync(p.ca)) throw new Error(`no ${p.ca}; run snowglobe up (or certs) first`);
  if (!existsSync(p.globeEnv)) throw new Error(`no ${p.globeEnv}; run snowglobe up first`);
  // Refuses a SG_DOMAIN the render is not for.
  resolveDomain({ root, state, env });

  // Never the values: a setting may be a login.
  const replaced = settings.filter((x) => !x.auto && env[x.name] !== undefined && env[x.name] !== x.value).map((x) => x.name);
  if (replaced.length) log(`snowglobe run: the snowglobe's settings replaced ${replaced.join(', ')} from the environment`);

  const child = spawn(cmd[0], cmd.slice(1), {
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

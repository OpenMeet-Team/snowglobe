// bin/snowglobe.mjs ls
//
// ls lists the snowglobes on this machine: every folder in the state root (lib/env.mjs stateRoot;
// ca/, the one CA, and dot folders such as the name router's .router are not ones) with its name,
// the domain it was rendered for, whether its compose project is running, and the file that owns
// it. Take the name to `up`, `down`, or a file to -f.
// "up" is a project with a container running (the one-shot init and relay-init have exited by
// then), "down" is none, or no project yet; "unknown" is what it says when Docker did not answer.
// When the name router routes any snowglobe, a last line says whether it is running and to which.
// Reads only; nothing is started.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ROUTER_ADDRESS, envGet, paths, stateRoot } from '../env.mjs';
import { readRoutes, routerDir, routerState } from '../router.mjs';
import { ownerOf } from '../state.mjs';

export const command = {
  name: 'ls',
  usage: 'ls',
  options: {},
  positionals: [0, 0],
};

/** Compose's own status for each project, "running(5)" or "exited(2)" or "exited(1), running(10)", by name; null when Docker did not answer. */
export function projectStatuses() {
  const res = spawnSync('docker', ['compose', 'ls', '-a', '--format', 'json'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  try {
    return new Map(JSON.parse(res.stdout || '[]').map((p) => [p.Name, p.Status ?? '']));
  } catch {
    return null;
  }
}

// What a compose status means for the table.
export function stateWord(status) {
  return /running\(\d+\)/.test(status ?? '') ? 'up' : 'down';
}

/**
 * The snowglobes in the state root: [{ name, domain, state, file }], by name. `statuses` is
 * projectStatuses()'s answer, null for "unknown". A file that is gone is shown as "(gone)".
 */
export function list({ root = ROOT, env = process.env, statuses = projectStatuses() } = {}) {
  const base = stateRoot(env);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'ca' && !e.name.startsWith('.'))
    .map((e) => {
      const state = join(base, e.name);
      const owner = ownerOf(state);
      return {
        name: e.name,
        domain: envGet('SG_DOMAIN', paths(root, state).globeEnv) || '-',
        state: statuses === null ? 'unknown' : stateWord(statuses.get(env.SG_PROJECT || e.name)),
        file: owner ? (existsSync(owner) ? owner : `${owner} (gone)`) : '-',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function run() {
  const rows = list();
  if (!rows.length) {
    console.log(`No snowglobes in ${stateRoot()}. snowglobe up in a folder with a snowglobe.yml makes one.`);
    return 0;
  }
  const head = { name: 'NAME', domain: 'DOMAIN', state: 'STATE', file: 'FILE' };
  const cols = Object.keys(head);
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(head[c].length, ...rows.map((r) => r[c].length))]));
  for (const r of [head, ...rows]) console.log(cols.map((c, i) => (i === cols.length - 1 ? r[c] : r[c].padEnd(width[c]))).join('  '));
  const routes = readRoutes(routerDir());
  if (routes.length) {
    const word = { running: 'running', stopped: 'stopped', missing: 'not running' }[routerState()];
    console.log(`\nName router on ${ROUTER_ADDRESS}:443: ${word}, routing ${routes.map((r) => `${r.domain} to ${r.globe}`).join(', ')}`);
  }
  return 0;
}

// The name router: one per machine, in front of every local snowglobe on it.
//
// Each snowglobe has a domain of its own (<globe>.local.snowglobe.at unless its file names one),
// and public DNS answers every name under local.snowglobe.at, at any depth, with 127.0.0.1. The
// router listens there on 443, reads the name a TLS connection asks for (SNI) and passes the
// connection, still encrypted, to the snowglobe whose domain the name is under, on that
// snowglobe's own 127.0.0.N. Each snowglobe's nginx keeps serving its own certificate. So a browser
// reaches every snowglobe at once by name, and a handle made at any time resolves, with nothing to
// map: as on a hosted globe, where the cluster's Gateway routes by name.
//
// It is a stock nginx (the image each snowglobe's nginx runs), in a container named
// snowglobe-router on the host's network, with its config in <state root>/.router: nginx.conf,
// written from routes/, one file per snowglobe it routes ("<domain> <address> <project>"). up writes
// a snowglobe's route and down removes it; each then brings the container in line (syncRouter).
// The longest domain wins, so a snowglobe still on the shared local.snowglobe.at keeps working
// beside ones under it. A name under no routed domain is closed. Linux only for now (routerRuns
// in lib/env.mjs); SG_ROUTER=off turns it off.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROUTER_ADDRESS, stateRoot } from './env.mjs';

export const ROUTER_CONTAINER = 'snowglobe-router';
// The image each snowglobe's own nginx runs (lib/render.mjs), so the router pulls nothing new.
export const ROUTER_IMAGE = 'nginx:1.30-alpine';
// Where the router's folder is mounted in its container. A folder, not the file: up and down
// replace nginx.conf by renaming over it, and a file mount would keep the old one.
const MOUNT = '/etc/snowglobe-router';

/** The router's folder, a dot folder in the state root, so no snowglobe can be named for it. */
export const routerDir = (env = process.env) => join(stateRoot(env), '.router');

const ROUTE_RE = /^([a-z0-9.-]+) (127\.[0-9]+\.[0-9]+\.[0-9]+) (\S+)$/;

/** The routes in `dir`: [{ globe, domain, bind, project }], by globe name. A file that does not read as one is skipped. */
export function readRoutes(dir) {
  const routes = join(dir, 'routes');
  if (!existsSync(routes)) return [];
  return readdirSync(routes)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .flatMap((globe) => {
      const m = readFileSync(join(routes, globe), 'utf8').trim().match(ROUTE_RE);
      return m ? [{ globe, domain: m[1], bind: m[2], project: m[3] }] : [];
    });
}

// Written aside and renamed, so nginx never reads half a file.
function put(file, text) {
  writeFileSync(`${file}.tmp.${process.pid}`, text);
  renameSync(`${file}.tmp.${process.pid}`, file);
}

/** Route `domain` and every name under it to `bind`, for the snowglobe `globe` (its compose project `project`). */
export function writeRoute(dir, { globe, domain, bind, project }) {
  mkdirSync(join(dir, 'routes'), { recursive: true });
  put(join(dir, 'routes', globe), `${domain} ${bind} ${project}\n`);
}

/** Stop routing to `globe`. Returns whether it had a route. */
export function dropRoute(dir, globe) {
  const file = join(dir, 'routes', globe);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** The route of another snowglobe at exactly `domain`, or null: the router can send a name to one snowglobe only. */
export const domainTaken = (routes, globe, domain) => routes.find((r) => r.globe !== globe && r.domain === domain) ?? null;

/**
 * The router's nginx.conf for `routes`: a domain and every name under it (nginx's ".domain" form)
 * to that snowglobe's 443, the longest domain first (nginx prefers it whatever the order).
 */
export function routerConfig(routes) {
  const map = [...routes]
    .sort((a, b) => b.domain.length - a.domain.length || a.domain.localeCompare(b.domain))
    .map((r) => `    .${r.domain} ${r.bind}:443;  # ${r.globe}`);
  return [
    '# The snowglobe name router (lib/router.mjs). Written by snowglobe up and down from routes/; edits are lost.',
    'worker_processes 1;',
    'events { worker_connections 1024; }',
    'stream {',
    '  map $ssl_preread_server_name $snowglobe {',
    '    hostnames;',
    ...map,
    // A name under no routed domain: nothing listens there, so the connection is closed.
    '    default unix:/run/snowglobe-router-none.sock;',
    '  }',
    '  server {',
    `    listen ${ROUTER_ADDRESS}:443;`,
    '    ssl_preread on;',
    '    proxy_pass $snowglobe;',
    '  }',
    '}',
    '',
  ].join('\n');
}

const dockerCli = (env) => (args) => spawnSync('docker', args, { encoding: 'utf8', env });

/** The router container's state: 'running', 'stopped', or 'missing'. `docker` runs a docker command (spawnSync's result). */
export function routerState(docker = dockerCli(process.env)) {
  const res = docker(['inspect', '-f', '{{.State.Running}}', ROUTER_CONTAINER]);
  if (res.error || res.status !== 0) return 'missing';
  const out = (res.stdout ?? '').trim();
  return out === 'true' ? 'running' : out === 'false' ? 'stopped' : 'missing';
}

/**
 * Bring the router in line with the routes in `dir`: write nginx.conf, then reload a running
 * router, start a stopped one, or make it; with no routes left, remove it. `docker` runs a docker
 * command (spawnSync's result); `wait` is how long a router just started gets before it is checked.
 */
export async function syncRouter({ dir = routerDir(), env = process.env, docker = dockerCli(env), log = () => {}, wait = 1000 } = {}) {
  const routes = readRoutes(dir);
  const now = routerState(docker);
  if (!routes.length) {
    if (now !== 'missing') {
      docker(['rm', '-f', ROUTER_CONTAINER]);
      log('Removed the name router: no snowglobe is routed');
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
  put(join(dir, 'nginx.conf'), routerConfig(routes));
  const must = (args) => {
    const res = docker(args);
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} for the name router failed: ${(res.stderr ?? '').trim()}`);
  };
  if (now === 'running') return must(['exec', ROUTER_CONTAINER, 'nginx', '-s', 'reload']);
  if (now === 'stopped') must(['start', ROUTER_CONTAINER]);
  else
    must([
      'run', '-d', '--name', ROUTER_CONTAINER, '--label', 'snowglobe.router=1', '--restart', 'unless-stopped',
      '--network', 'host', '-v', `${dir}:${MOUNT}:ro`,
      ROUTER_IMAGE, 'nginx', '-g', 'daemon off;', '-c', `${MOUNT}/nginx.conf`,
    ]);
  // nginx that cannot listen exits at once; give it a moment, then look.
  await sleep(wait);
  if (routerState(docker) !== 'running')
    throw new Error(
      `the name router did not stay up (docker logs ${ROUTER_CONTAINER} says why). Something else may hold ${ROUTER_ADDRESS}:443, ` +
        'such as a snowglobe made before 0.5.0 that kept that address: snowglobe down it, and up it again to move it.',
    );
  log(`Started the name router on ${ROUTER_ADDRESS}:443`);
}

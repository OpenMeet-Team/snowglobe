// The name router: one per machine, in front of every local snowglobe on it.
//
// Each snowglobe has a domain of its own (<globe>.local.snowglobe.at unless its file names one),
// and public DNS answers every name under local.snowglobe.at, at any depth, with 127.0.0.1. The
// router is published there on port 443, reads the name a TLS connection asks for (SNI) and passes
// the connection, still encrypted, to the nginx of the snowglobe whose domain the name is under.
// Each snowglobe's nginx keeps serving its own certificate. So a browser reaches every snowglobe at
// once by name, and a handle made at any time resolves, with nothing to map: as on a hosted globe,
// where the cluster's Gateway routes by name.
//
// It is a stock nginx (the image each snowglobe's nginx runs) in an ordinary container named
// snowglobe-router: port 443 published on 127.0.0.1, on a network of its own (snowglobe-router, so
// no other container reaches it), and joined to the compose network of each snowglobe it routes,
// where it reaches that snowglobe's nginx by container name. Since it needs only a published port,
// it works wherever one does, Docker Desktop included, whose host network is Docker's own VM and
// not this machine. Its folder is ~/.local/share/snowglobe/.router whatever XDG_DATA_HOME says,
// because the container serves the whole machine: a snowglobe kept in another state folder (a
// test's copy, say) is routed by the same router. In the folder: nginx.conf, written from routes/,
// one file per compose project it routes ("<domain> <address> <globe>", the address being the one
// the snowglobe publishes its own ports on); compose project names are what is unique on a
// machine. up writes a snowglobe's route and down removes it, each under the router's lock, then
// brings the container in line (syncRouter): its config, and the networks it is joined to. down
// does that before compose removes the snowglobe's network, which Docker refuses while the router
// is joined to it.
// The longest domain wins, so a snowglobe still on the shared local.snowglobe.at keeps working
// beside ones under it. A name under no routed domain is closed. Linux only for now (routerRuns
// in lib/env.mjs); SG_ROUTER=off turns it off.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROUTER_ADDRESS, withLock } from './env.mjs';
import { NETWORK } from './render.mjs';

export const ROUTER_CONTAINER = 'snowglobe-router';
// The router's own network: it publishes 443 from this one, which no other container is on.
export const ROUTER_NETWORK = 'snowglobe-router';
// The label on the router and its network.
const LABEL = 'snowglobe.router=1';
// The image each snowglobe's own nginx runs (lib/render.mjs), so the router pulls nothing new.
export const ROUTER_IMAGE = 'nginx:1.30-alpine';
// Where the router's folder is mounted in its container. A folder, not the file: up and down
// replace nginx.conf by renaming over it, and a file mount would keep the old one.
const MOUNT = '/etc/snowglobe-router';

/** The router's folder: a dot folder beside the default state folders, so no snowglobe can be named for it. */
export const routerDir = (env = process.env) => join(env.HOME || homedir(), '.local', 'share', 'snowglobe', '.router');

/** The compose network of the project `project`, which the router joins to reach that snowglobe's nginx. */
export const globeNetwork = (project) => `${project}_${NETWORK}`;

// That snowglobe's nginx, by the name compose gives its one container, which is unique on the
// machine where the service name nginx is not: the router is on every snowglobe's network at once.
const globeNginx = (project) => `${project}-nginx-1:443`;

const ROUTE_RE = /^([a-z0-9.-]+) (127\.[0-9]+\.[0-9]+\.[0-9]+) ([a-z0-9]+)$/;

/**
 * The routes in `dir`: [{ project, domain, bind, globe }], by project. A file that does not read as
 * one is skipped, and so is one removed while they are read (ls reads them without the lock).
 */
export function readRoutes(dir) {
  const routes = join(dir, 'routes');
  if (!existsSync(routes)) return [];
  return readdirSync(routes)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .flatMap((project) => {
      let text;
      try {
        text = readFileSync(join(routes, project), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') return [];
        throw e;
      }
      const m = text.trim().match(ROUTE_RE);
      return m ? [{ project, domain: m[1], bind: m[2], globe: m[3] }] : [];
    });
}

// Written aside and renamed, so nginx never reads half a file. The file aside is a dot file, which
// readRoutes skips, so a write that stops half way leaves no second route.
function put(file, text) {
  const aside = join(dirname(file), `.${basename(file)}.tmp.${process.pid}`);
  writeFileSync(aside, text);
  renameSync(aside, file);
}

/** Route `domain` and every name under it to `bind`, for the compose project `project` (the snowglobe `globe`). */
export function writeRoute(dir, { project, domain, bind, globe }) {
  mkdirSync(join(dir, 'routes'), { recursive: true });
  put(join(dir, 'routes', project), `${domain} ${bind} ${globe}\n`);
}

/** Stop routing to the compose project `project`. Returns whether it had a route. */
export function dropRoute(dir, project) {
  const file = join(dir, 'routes', project);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/**
 * Write `route` ({ project, domain, bind, globe }) in `dir`, unless another project's route at the
 * same domain is up (`isUp(project)`): that route is returned and nothing is written. Another's
 * route there whose project is not up was left by a snowglobe stopped without snowglobe down; it is
 * dropped, since nginx refuses the whole config with two routes at one domain. Returns null once
 * written. Run it under the router's lock, as syncRouter's `change`.
 */
export function claimDomain(dir, route, isUp, log = () => {}) {
  const others = readRoutes(dir).filter((r) => r.project !== route.project && r.domain === route.domain);
  const live = others.find((r) => isUp(r.project));
  if (live) return live;
  for (const r of others) {
    dropRoute(dir, r.project);
    log(`Dropped the route ${r.globe} (compose project ${r.project}) left at ${r.domain}: it is not up`);
  }
  writeRoute(dir, route);
  return null;
}

/**
 * The router's nginx.conf for `routes`: a domain and every name under it (nginx's ".domain" form)
 * to that snowglobe's nginx on 443, the longest domain first (nginx prefers it whatever the order).
 */
export function routerConfig(routes) {
  const map = [...routes]
    .sort((a, b) => b.domain.length - a.domain.length || a.domain.localeCompare(b.domain))
    .map((r) => `    .${r.domain} ${globeNginx(r.project)};  # ${r.globe}`);
  return [
    '# The snowglobe name router (lib/router.mjs). Written by snowglobe up and down from routes/; edits are lost.',
    'worker_processes 1;',
    'events { worker_connections 1024; }',
    'stream {',
    // Docker's DNS, which answers the container names on the networks the router is joined to.
    // Asked when a connection comes and kept 10 s, so a snowglobe's nginx made again is found.
    '  resolver 127.0.0.11 valid=10s ipv6=off;',
    '  map $ssl_preread_server_name $snowglobe {',
    '    hostnames;',
    ...map,
    // A name under no routed domain: nothing listens there, so the connection is closed.
    '    default unix:/run/snowglobe-router-none.sock;',
    '  }',
    '  server {',
    // In its own container; Docker publishes it on ROUTER_ADDRESS:443 (sync).
    '    listen 443;',
    '    ssl_preread on;',
    '    proxy_pass $snowglobe;',
    '  }',
    '}',
    '',
  ].join('\n');
}

const dockerCli = (env) => (args) => spawnSync('docker', args, { encoding: 'utf8', env });

/**
 * The router container: { state: 'running' | 'stopped' | 'missing', dir, mode, networks }: dir is
 * the folder it reads ('' when Docker does not say), mode the network it was made on ('host' for
 * one made before it was an ordinary container), networks those it is joined to. `docker` runs a
 * docker command (spawnSync's result).
 */
export function routerState(docker = dockerCli(process.env)) {
  // --type: the router's network has the same name.
  const res = docker([
    'inspect', '--type', 'container', '-f',
    `{{.State.Running}}|{{range .Mounts}}{{if eq .Destination "${MOUNT}"}}{{.Source}}{{end}}{{end}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}`,
    ROUTER_CONTAINER,
  ]);
  if (res.error || res.status !== 0) return { state: 'missing', dir: '', mode: '', networks: [] };
  const [running = '', dir = '', mode = '', networks = ''] = (res.stdout ?? '').trim().split('|');
  return { state: running === 'true' ? 'running' : running === 'false' ? 'stopped' : 'missing', dir, mode, networks: networks.split(' ').filter(Boolean) };
}

// The same folder, though the two may be spelled differently (a HOME reached through a link).
// Docker reports a mount's folder as it was given; one this machine cannot see is compared as text.
function sameFolder(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/**
 * Bring the router in line with the routes in `dir`: write nginx.conf, join the network of each
 * snowglobe routed and leave the others, and reload a running router or make it; with no routes
 * left, remove it and its network. A router that reads another folder (started under another
 * HOME) is refused, since it would never see these routes.
 * `change`, run first under the same lock, changes the routes (claimDomain, dropRoute); when it
 * returns false nothing changed and the router is left as it is. `docker` runs a docker command
 * (spawnSync's result); `wait` is how long a router just started gets before it is checked.
 */
export async function syncRouter({ dir = routerDir(), env = process.env, docker = dockerCli(env), log = () => {}, wait = 1000, change = () => true } = {}) {
  // Two ups at once would both make the router, or one would write a config without the other's
  // route, or both take one domain; one at a time, under a lock in the router's folder.
  return withLock(
    join(dir, '.lock'),
    async () => {
      if ((await change()) !== false) await sync({ dir, docker, log, wait });
    },
    { doing: 'updating the name router' },
  );
}

async function sync({ dir, docker, log, wait }) {
  const routes = readRoutes(dir);
  const now = routerState(docker);
  if (now.state !== 'missing' && now.dir && !sameFolder(now.dir, dir))
    throw new Error(`the name router on this machine reads ${now.dir}, not ${dir} (it was started under another HOME); bring snowglobes up under that one, or docker rm -f ${ROUTER_CONTAINER} once none of its snowglobes is up`);
  const held =
    ` Something else may hold ${ROUTER_ADDRESS}:443: a snowglobe made before 0.5.0 that kept that address (snowglobe down it, and up it again to move it), ` +
    "or an editor forwarding a dev container's port 443 to this machine.";
  const must = (args, more = '') => {
    const res = docker(args);
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} for the name router failed: ${(res.stderr ?? '').trim()}${more}`);
    return res;
  };
  if (!routes.length) {
    if (now.state !== 'missing') {
      must(['rm', '-f', ROUTER_CONTAINER]);
      // Its network goes with it; one still in use is left, and says so to no one.
      docker(['network', 'rm', ROUTER_NETWORK]);
      log('Removed the name router: no snowglobe is routed');
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
  put(join(dir, 'nginx.conf'), routerConfig(routes));
  const there = new Set((must(['network', 'ls', '--format', '{{.Name}}']).stdout ?? '').split('\n').filter(Boolean));
  // Only a running router of this kind is kept. One made before it was an ordinary container (on
  // the host's network) is made again as one; so is a stopped one, since it may still be joined to
  // a snowglobe's network that is gone, and Docker would not start it.
  const keep = now.state === 'running' && now.mode === ROUTER_NETWORK;
  if (!keep) {
    if (now.state !== 'missing') must(['rm', '-f', ROUTER_CONTAINER]);
    if (!there.has(ROUTER_NETWORK)) must(['network', 'create', '--label', LABEL, ROUTER_NETWORK]);
    must([
      'create', '--name', ROUTER_CONTAINER, '--label', LABEL, '--restart', 'unless-stopped',
      '--network', ROUTER_NETWORK, '-p', `${ROUTER_ADDRESS}:443:443`, '-v', `${dir}:${MOUNT}:ro`,
      ROUTER_IMAGE, 'nginx', '-g', 'daemon off;', '-c', `${MOUNT}/nginx.conf`,
    ]);
  }
  const joined = keep ? now.networks : [ROUTER_NETWORK];
  const wanted = new Set(routes.map((r) => globeNetwork(r.project)));
  // Joined before the reload, so the new routes' names resolve once it has them.
  for (const r of routes) {
    const net = globeNetwork(r.project);
    if (joined.includes(net)) continue;
    if (there.has(net)) {
      must(['network', 'connect', net, ROUTER_CONTAINER]);
      joined.push(net);
    } else log(`The name router cannot reach ${r.globe} (compose project ${r.project}): its network ${net} is not there, so it is not up; snowglobe up starts it`);
  }
  if (keep) {
    // With -c the reload reads this config before it signals, and fails when nginx would refuse it.
    // Without it, it reads the image's own config and says nothing, while the router keeps the old routes.
    must(['exec', ROUTER_CONTAINER, 'nginx', '-s', 'reload', '-c', `${MOUNT}/nginx.conf`]);
    // Left once the config no longer names them.
    for (const net of joined) if (net !== ROUTER_NETWORK && !wanted.has(net)) must(['network', 'disconnect', net, ROUTER_CONTAINER]);
    return;
  }
  must(['start', ROUTER_CONTAINER], held);
  // nginx that cannot read its config exits at once; give it a moment, then look.
  await sleep(wait);
  if (routerState(docker).state !== 'running') throw new Error(`the name router did not stay up (docker logs ${ROUTER_CONTAINER} says why).${held}`);
  log(`Started the name router on ${ROUTER_ADDRESS}:443`);
}

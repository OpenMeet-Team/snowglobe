// The name router (lib/router.mjs): its routes, the nginx config it is given, and what it asks
// Docker for, with a docker that only records. No Docker needed; run them alone with
// `npx vitest run snowglobe-router`. That a real router reaches two snowglobes at once by name,
// and a handle made after a command started, was checked by hand with two snowglobes up.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { ROUTER_CONTAINER, ROUTER_IMAGE, ROUTER_NETWORK, claimDomain, dropRoute, globeNetwork, readRoutes, routerConfig, syncRouter, writeRoute } from '../lib/router.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'snowglobe-router-'));
const A = { globe: 'mvpa', domain: 'mvpa.local.snowglobe.at', bind: '127.0.0.6', project: 'mvpa' };
const B = { globe: 'mvpb', domain: 'mvpb.local.snowglobe.at', bind: '127.0.0.7', project: 'mvpb' };
const OLD = { globe: 'atmogroups', domain: 'local.snowglobe.at', bind: '127.0.0.4', project: 'atmogroups' };

// A docker that records each call. inspect answers with `state` ('running', 'stopped' or
// 'missing'), the folder the router reads (`dir`, none by default), the network it was made on
// (`mode`) and those it is joined to (`joined`); network ls lists `there`. A router made with
// create is stopped and on its own network; after start it is running, unless `stays` is false.
// A command in `fails` ('rm', 'network connect', ...) fails.
function fakeDocker(
  state: string,
  { stays = true, dir = '', fails = [] as string[], mode = ROUTER_NETWORK, joined = [ROUTER_NETWORK], there = [ROUTER_NETWORK, 'mvpa_snowglobe', 'mvpb_snowglobe', 'atmogroups_snowglobe'] } = {},
) {
  const calls: string[][] = [];
  const verb = (args: string[]) => (args[0] === 'network' ? `network ${args[1]}` : args[0]);
  const nets = new Set(there);
  let now = state;
  let on = [...joined];
  let made = mode;
  const docker = (args: string[]) => {
    calls.push(args);
    const v = verb(args);
    if (fails.includes(v)) return { status: 1, stdout: '', stderr: 'failed' };
    if (v === 'inspect') return now === 'missing' ? { status: 1, stdout: '', stderr: 'No such object' } : { status: 0, stdout: `${now === 'running'}|${dir}|${made}|${on.map((n) => `${n} `).join('')}\n` };
    if (v === 'network ls') return { status: 0, stdout: [...nets].map((n) => `${n}\n`).join(''), stderr: '' };
    if (v === 'network create') nets.add(args.at(-1)!);
    if (v === 'network rm') nets.delete(args.at(-1)!);
    if (v === 'network connect') on.push(args[2]);
    if (v === 'network disconnect') on = on.filter((n) => n !== args[2]);
    if (v === 'create') [now, made, on] = ['stopped', ROUTER_NETWORK, [ROUTER_NETWORK]];
    if (v === 'start') now = stays ? 'running' : 'stopped';
    if (v === 'rm') now = 'missing';
    return { status: 0, stdout: '', stderr: '' };
  };
  const call = (v: string) => calls.find((c) => verb(c) === v);
  return { docker, calls, call, verbs: () => calls.map(verb), joined: () => on, networks: () => nets };
}

describe('routes', () => {
  it('keeps one file per snowglobe, read back by name, and drops it', () => {
    const d = dir();
    writeRoute(d, B);
    writeRoute(d, A);
    expect(readRoutes(d)).toEqual([A, B]);
    // One file per compose project, naming the globe.
    expect(readFileSync(join(d, 'routes', 'mvpa'), 'utf8')).toBe('mvpa.local.snowglobe.at 127.0.0.6 mvpa\n');
    expect(dropRoute(d, 'mvpa')).toBe(true);
    expect(dropRoute(d, 'mvpa')).toBe(false);
    expect(readRoutes(d)).toEqual([B]);
  });

  it('skips a file that is not a route, and reads none from a folder that is not there', () => {
    const d = dir();
    mkdirSync(join(d, 'routes'));
    writeFileSync(join(d, 'routes', 'bad'), 'not a route\n');
    writeFileSync(join(d, 'routes', 'far'), 'far.test 10.0.0.1 far\n'); // not loopback
    expect(readRoutes(d)).toEqual([]);
    expect(readRoutes(join(d, 'nope'))).toEqual([]);
  });

  it('leaves no second route from a write that stopped half way', () => {
    const d = dir();
    // A folder where the route would go makes the rename fail, after the file aside was written.
    mkdirSync(join(d, 'routes', 'mvpb', 'x'), { recursive: true });
    expect(() => writeRoute(d, B)).toThrow();
    writeRoute(d, A);
    expect(readRoutes(d)).toEqual([A]);
  });

  it('claims a domain: refused while another snowglobe there is up, and taken from one that is not', () => {
    const d = dir();
    const MINE = { globe: 'mine', domain: A.domain, bind: '127.0.0.9', project: 'mine' };
    for (const r of [A, B, OLD]) writeRoute(d, r);
    expect(claimDomain(d, MINE, (p: string) => p === 'mvpa')).toEqual(A);
    expect(readRoutes(d)).toEqual([OLD, A, B]);
    // mvpa stopped without snowglobe down: its route goes, since nginx refuses two at one domain.
    // The one above it (local.snowglobe.at), though not up either, is another domain and stays.
    const said: string[] = [];
    expect(claimDomain(d, MINE, () => false, (m: string) => said.push(m))).toBeNull();
    expect(readRoutes(d)).toEqual([OLD, MINE, B]);
    expect(said).toHaveLength(1);
    expect(routerConfig(readRoutes(d)).match(/^\s+\.mvpa\.local\.snowglobe\.at /gm)).toHaveLength(1);
  });

});

describe('the router\'s nginx.conf', () => {
  it('passes each domain and every name under it to that snowglobe\'s nginx by container name, longest first, and closes the rest', () => {
    const conf: string = routerConfig([OLD, B, A]);
    // In its own container: Docker publishes the port, so it listens on every address there.
    expect(conf).toMatch(/^\s+listen 443;$/m);
    expect(conf).toContain('ssl_preread on;');
    expect(conf).toContain('hostnames;');
    // Docker's DNS, which knows the containers on the networks the router is joined to.
    expect(conf).toMatch(/^\s+resolver 127\.0\.0\.11 /m);
    const lines = conf.split('\n').filter((l) => /^\s+\.\S+ \S+-nginx-1:443;/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '));
    expect(lines).toEqual(['.mvpa.local.snowglobe.at mvpa-nginx-1:443;', '.mvpb.local.snowglobe.at mvpb-nginx-1:443;', '.local.snowglobe.at atmogroups-nginx-1:443;']);
    expect(conf).toMatch(/default unix:\S+;/);
    // The TLS stays the snowglobe's own: nothing here holds a certificate.
    expect(conf).not.toMatch(/ssl_certificate|proxy_ssl/);
  });

  it('names the compose project\'s nginx, not the globe\'s, when SG_PROJECT gave the project another name', () => {
    const mine = { ...A, project: 'mine' };
    expect(routerConfig([mine])).toMatch(/^\s+\.mvpa\.local\.snowglobe\.at mine-nginx-1:443;/m);
    expect(globeNetwork('mine')).toBe('mine_snowglobe');
  });
});

describe('syncRouter', () => {
  // The value given after `flag` in a docker command.
  const opt = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('makes the router when there is none: stock nginx publishing 127.0.0.1:443 from a network of its own, joined to the snowglobe\'s network', async () => {
    const d = dir();
    writeRoute(d, A);
    const f = fakeDocker('missing', { there: ['mvpa_snowglobe'] });
    await syncRouter({ dir: d, docker: f.docker, wait: 0 });
    expect(f.verbs()).toEqual(['inspect', 'network ls', 'network create', 'create', 'network connect', 'start', 'inspect']);
    // The container, not a network of the same name.
    expect(f.calls[0]).toEqual(expect.arrayContaining(['--type', 'container']));
    expect(f.calls[0].at(-1)).toBe(ROUTER_CONTAINER);
    expect(f.call('network create')!.at(-1)).toBe(ROUTER_NETWORK);
    const create = f.call('create')!;
    expect(create).toEqual(expect.arrayContaining(['--name', ROUTER_CONTAINER, '--restart', 'unless-stopped', ROUTER_IMAGE]));
    expect(opt(create, '--network')).toBe(ROUTER_NETWORK);
    expect(opt(create, '-p')).toBe('127.0.0.1:443:443');
    expect(create).toContain(`${d}:/etc/snowglobe-router:ro`);
    expect(f.call('network connect')).toEqual(['network', 'connect', 'mvpa_snowglobe', ROUTER_CONTAINER]);
    expect(readFileSync(join(d, 'nginx.conf'), 'utf8')).toBe(routerConfig([A]));
  });

  it('reloads a running router, joining a new snowglobe\'s network before and leaving an unrouted one\'s after', async () => {
    const d = dir();
    writeRoute(d, A);
    writeRoute(d, B);
    const f = fakeDocker('running', { joined: [ROUTER_NETWORK, 'mvpa_snowglobe', 'gone_snowglobe'] });
    await syncRouter({ dir: d, docker: f.docker, wait: 0 });
    expect(f.verbs()).toEqual(['inspect', 'network ls', 'network connect', 'exec', 'network disconnect']);
    expect(f.call('network connect')![2]).toBe('mvpb_snowglobe');
    // With the config named, so the reload fails when nginx would refuse it.
    expect(f.call('exec')).toEqual(['exec', ROUTER_CONTAINER, 'nginx', '-s', 'reload', '-c', '/etc/snowglobe-router/nginx.conf']);
    expect(f.call('network disconnect')![2]).toBe('gone_snowglobe');
    expect(f.joined().sort()).toEqual([ROUTER_NETWORK, 'mvpa_snowglobe', 'mvpb_snowglobe'].sort());
    expect(readFileSync(join(d, 'nginx.conf'), 'utf8')).toContain('.mvpb.local.snowglobe.at');
  });

  it('makes a stopped router again, since it may be joined to a network that is gone', async () => {
    const d = dir();
    writeRoute(d, A);
    const f = fakeDocker('stopped', { joined: [ROUTER_NETWORK, 'mvpa_snowglobe', 'gone_snowglobe'] });
    await syncRouter({ dir: d, docker: f.docker, wait: 0 });
    expect(f.verbs()).toEqual(['inspect', 'network ls', 'rm', 'create', 'network connect', 'start', 'inspect']);
    expect(f.joined()).toEqual([ROUTER_NETWORK, 'mvpa_snowglobe']);
  });

  it('makes a router from 0.5.0, on the host\'s network, again as an ordinary container', async () => {
    const d = dir();
    writeRoute(d, A);
    const f = fakeDocker('running', { mode: 'host', joined: ['host'] });
    await syncRouter({ dir: d, docker: f.docker, wait: 0 });
    expect(f.verbs()).toEqual(['inspect', 'network ls', 'rm', 'create', 'network connect', 'start', 'inspect']);
    expect(opt(f.call('create')!, '--network')).toBe(ROUTER_NETWORK);
  });

  it('routes the others when a snowglobe\'s network is not there, and says which it left out', async () => {
    const d = dir();
    const GONE = { globe: 'gone', domain: 'gone.local.snowglobe.at', bind: '127.0.0.8', project: 'gone' };
    writeRoute(d, A);
    writeRoute(d, GONE);
    const said: string[] = [];
    const f = fakeDocker('missing', { there: ['mvpa_snowglobe'] });
    await syncRouter({ dir: d, docker: f.docker, wait: 0, log: (m: string) => said.push(m) });
    expect(f.calls.filter((c) => c[0] === 'network' && c[1] === 'connect').map((c) => c[2])).toEqual(['mvpa_snowglobe']);
    expect(f.verbs()).toContain('start');
    expect(said.filter((m) => m.includes(GONE.project))).toHaveLength(1);
  });

  it('removes the router and its network when no route is left, and asks nothing more when there is none', async () => {
    const d = dir();
    const running = fakeDocker('running');
    await syncRouter({ dir: d, docker: running.docker, wait: 0 });
    expect(running.calls.slice(-2)).toEqual([['rm', '-f', ROUTER_CONTAINER], ['network', 'rm', ROUTER_NETWORK]]);
    expect(running.networks().has(ROUTER_NETWORK)).toBe(false);
    const missing = fakeDocker('missing');
    await syncRouter({ dir: d, docker: missing.docker, wait: 0 });
    expect(missing.verbs()).toEqual(['inspect']);
  });

  it('fails, and says nothing was removed, when the router cannot be removed or reloaded', async () => {
    const d = dir();
    const said: string[] = [];
    const rm = fakeDocker('running', { fails: ['rm'] });
    await expect(syncRouter({ dir: d, docker: rm.docker, wait: 0, log: (m: string) => said.push(m) })).rejects.toThrow();
    expect(said).toEqual([]);
    writeRoute(d, A);
    const reload = fakeDocker('running', { fails: ['exec'] });
    await expect(syncRouter({ dir: d, docker: reload.docker, wait: 0 })).rejects.toThrow();
  });

  it('fails, and says it started nothing, when the router cannot start (something else on 127.0.0.1:443)', async () => {
    const d = dir();
    writeRoute(d, A);
    const said: string[] = [];
    const f = fakeDocker('missing', { fails: ['start'] });
    await expect(syncRouter({ dir: d, docker: f.docker, wait: 0, log: (m: string) => said.push(m) })).rejects.toThrow();
    expect(said).toEqual([]);
  });

  it('runs the change under its lock, and leaves the router alone when nothing changed', async () => {
    const d = dir();
    const f = fakeDocker('running');
    await syncRouter({ dir: d, docker: f.docker, wait: 0, change: () => false });
    expect(f.calls).toEqual([]);
    // A change that throws (a domain refused) leaves the router as it was, and the lock free.
    const refused = syncRouter({ dir: d, docker: f.docker, wait: 0, change: () => { throw new Error('refused'); } });
    await expect(refused).rejects.toThrow();
    expect(f.calls).toEqual([]);
    await syncRouter({ dir: d, docker: f.docker, wait: 0, change: () => writeRoute(d, A) });
    expect(f.verbs()).toEqual(['inspect', 'network ls', 'network connect', 'exec']);
  });

  it('makes one router for two ups at once, with both routes and both networks', async () => {
    const d = dir();
    const f = fakeDocker('missing');
    await Promise.all([A, B].map((r) => syncRouter({ dir: d, docker: f.docker, wait: 0, change: () => writeRoute(d, r) })));
    expect(f.verbs().filter((v) => v === 'create')).toHaveLength(1);
    expect(readFileSync(join(d, 'nginx.conf'), 'utf8')).toBe(routerConfig([A, B]));
    expect(f.joined().sort()).toEqual([ROUTER_NETWORK, 'mvpa_snowglobe', 'mvpb_snowglobe'].sort());
  });

  it('refuses a running router that reads another folder: it would never see these routes', async () => {
    const d = dir();
    writeRoute(d, A);
    const joined = [ROUTER_NETWORK, 'mvpa_snowglobe'];
    const same = fakeDocker('running', { dir: d, joined });
    await syncRouter({ dir: d, docker: same.docker, wait: 0 });
    expect(same.verbs()).toEqual(['inspect', 'network ls', 'exec']);
    // The same folder through a link (a HOME reached by another path) is the same router.
    const link = join(dir(), 'link');
    symlinkSync(d, link);
    const linked = fakeDocker('running', { dir: link, joined });
    await syncRouter({ dir: d, docker: linked.docker, wait: 0 });
    expect(linked.verbs()).toEqual(['inspect', 'network ls', 'exec']);
    const other = fakeDocker('running', { dir: '/home/someone/.local/share/snowglobe/.router', joined });
    await expect(syncRouter({ dir: d, docker: other.docker, wait: 0 })).rejects.toThrow(/another HOME/);
    expect(other.verbs()).toEqual(['inspect']);
  });

  it('says where to look when the router does not stay up', async () => {
    const d = dir();
    writeRoute(d, A);
    const f = fakeDocker('missing', { stays: false });
    await expect(syncRouter({ dir: d, docker: f.docker, wait: 0 })).rejects.toThrow(/docker logs snowglobe-router/);
  });
});

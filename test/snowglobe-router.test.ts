// The name router (lib/router.mjs): its routes, the nginx config it is given, and what it asks
// Docker for, with a docker that only records. No Docker needed; run them alone with
// `npx vitest run snowglobe-router`. That a real router reaches two snowglobes at once by name,
// and a handle made after a command started, was checked by hand with two snowglobes up.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { ROUTER_CONTAINER, ROUTER_IMAGE, domainTaken, dropRoute, readRoutes, routerConfig, syncRouter, writeRoute } from '../lib/router.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'snowglobe-router-'));
const A = { globe: 'mvpa', domain: 'mvpa.local.snowglobe.at', bind: '127.0.0.6', project: 'mvpa' };
const B = { globe: 'mvpb', domain: 'mvpb.local.snowglobe.at', bind: '127.0.0.7', project: 'mvpb' };
const OLD = { globe: 'atmogroups', domain: 'local.snowglobe.at', bind: '127.0.0.4', project: 'atmogroups' };

// A docker that records each call and answers inspect with `state` ('running', 'stopped' or
// 'missing'); after run or start the router is running, unless `stays` is false.
function fakeDocker(state: string, { stays = true } = {}) {
  const calls: string[][] = [];
  let now = state;
  const docker = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'inspect') return now === 'missing' ? { status: 1, stdout: '', stderr: 'No such object' } : { status: 0, stdout: now === 'running' ? 'true\n' : 'false\n' };
    if (args[0] === 'run' || args[0] === 'start') now = stays ? 'running' : 'stopped';
    if (args[0] === 'rm') now = 'missing';
    return { status: 0, stdout: '', stderr: '' };
  };
  return { docker, calls, verbs: () => calls.map((c) => c[0]) };
}

describe('routes', () => {
  it('keeps one file per snowglobe, read back by name, and drops it', () => {
    const d = dir();
    writeRoute(d, B);
    writeRoute(d, A);
    expect(readRoutes(d)).toEqual([A, B]);
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

  it('finds another snowglobe at exactly the same domain, and not one above or below it', () => {
    expect(domainTaken([A, OLD], 'mine', 'mvpa.local.snowglobe.at')).toEqual(A);
    expect(domainTaken([A, OLD], 'mvpa', 'mvpa.local.snowglobe.at')).toBeNull();
    expect(domainTaken([OLD], 'mine', 'mine.local.snowglobe.at')).toBeNull();
  });
});

describe('the router\'s nginx.conf', () => {
  it('passes each domain and every name under it to that snowglobe\'s 443, longest first, and closes the rest', () => {
    const conf: string = routerConfig([OLD, B, A]);
    expect(conf).toContain('listen 127.0.0.1:443;');
    expect(conf).toContain('ssl_preread on;');
    expect(conf).toContain('hostnames;');
    const lines = conf.split('\n').filter((l) => /^\s+\.\S+ 127\./.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '));
    expect(lines).toEqual(['.mvpa.local.snowglobe.at 127.0.0.6:443;', '.mvpb.local.snowglobe.at 127.0.0.7:443;', '.local.snowglobe.at 127.0.0.4:443;']);
    expect(conf).toMatch(/default unix:\S+;/);
    // The TLS stays the snowglobe's own: nothing here holds a certificate.
    expect(conf).not.toMatch(/ssl_certificate|proxy_ssl/);
  });
});

describe('syncRouter', () => {
  it('makes the router when there is none: stock nginx on the host network, its folder mounted', async () => {
    const d = dir();
    writeRoute(d, A);
    const f = fakeDocker('missing');
    await syncRouter({ dir: d, docker: f.docker, wait: 0 });
    expect(f.verbs()).toEqual(['inspect', 'run', 'inspect']);
    const run = f.calls[1];
    expect(run).toEqual(expect.arrayContaining(['--name', ROUTER_CONTAINER, '--network', 'host', '--restart', 'unless-stopped', ROUTER_IMAGE]));
    expect(run).toContain(`${d}:/etc/snowglobe-router:ro`);
    expect(readFileSync(join(d, 'nginx.conf'), 'utf8')).toBe(routerConfig([A]));
  });

  it('reloads a running router with the new routes, and starts a stopped one', async () => {
    const d = dir();
    writeRoute(d, A);
    writeRoute(d, B);
    const running = fakeDocker('running');
    await syncRouter({ dir: d, docker: running.docker, wait: 0 });
    expect(running.calls).toEqual([['inspect', '-f', '{{.State.Running}}', ROUTER_CONTAINER], ['exec', ROUTER_CONTAINER, 'nginx', '-s', 'reload']]);
    expect(readFileSync(join(d, 'nginx.conf'), 'utf8')).toContain('.mvpb.local.snowglobe.at');
    const stopped = fakeDocker('stopped');
    await syncRouter({ dir: d, docker: stopped.docker, wait: 0 });
    expect(stopped.verbs()).toEqual(['inspect', 'start', 'inspect']);
  });

  it('removes the router when no route is left, and asks nothing more when there is none', async () => {
    const d = dir();
    const running = fakeDocker('running');
    await syncRouter({ dir: d, docker: running.docker, wait: 0 });
    expect(running.calls.at(-1)).toEqual(['rm', '-f', ROUTER_CONTAINER]);
    const missing = fakeDocker('missing');
    await syncRouter({ dir: d, docker: missing.docker, wait: 0 });
    expect(missing.verbs()).toEqual(['inspect']);
  });

  it('says where to look when the router does not stay up, as when something else holds 127.0.0.1:443', async () => {
    const d = dir();
    writeRoute(d, A);
    const f = fakeDocker('missing', { stays: false });
    await expect(syncRouter({ dir: d, docker: f.docker, wait: 0 })).rejects.toThrow(/docker logs snowglobe-router/);
  });
});

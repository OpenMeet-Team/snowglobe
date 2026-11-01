// snowglobe up, down and run, without a globe: what up writes and checks before Docker, the guard
// on the project, the name router up and down keep, and what run hands a command. Run them alone
// with `npx vitest run snowglobe-up`. The CLI runs on a copy of bin/ and lib/ in a temporary root,
// with a docker on PATH that only records what it was asked; bringing a globe up for real is
// checked by hand on an isolated copy.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { accountPrefixes, endingClash, mergeRoutes, startedAfterRelay } from '../lib/up.mjs';

const ROOT = join(__dirname, '..');
const FOUR = join(ROOT, 'test/snowglobe/four.yml');
// The name router runs on Linux only (lib/env.mjs routerRuns).
const linux = process.platform === 'linux';

describe('what up writes', () => {
  it('finds a PDS named for an app\'s handle ending', () => {
    const apps = [{ name: 'atmo', port: 5173, ending: 'ev' }, { name: 'probe', port: 5480, ending: null }];
    expect(endingClash(['alpha', 'ev'], apps)).toEqual({ pds: 'ev', app: 'atmo' });
    expect(endingClash(['alpha', 'beta'], apps)).toBeNull();
  });

  it('restarts the relay when a PDS or nginx started after it did', () => {
    // Docker's StartedAt, to the nanosecond.
    const relay = ['2026-10-30T21:53:50.510123456Z'];
    const before = '2026-10-30T21:53:40.000000001Z';
    const after = '2026-10-30T21:54:21.060000000Z';
    // A first up: pass 2 recreates the PDS after pass 1 started the relay.
    expect(startedAfterRelay(relay, { 'pds-main': [after], nginx: [before] })).toBe('pds-main');
    // New certificates restart nginx.
    expect(startedAfterRelay(relay, { 'pds-main': [before], nginx: [after] })).toBe('nginx');
    // A rerun that changed nothing, a container that never started, a service with no container.
    expect(startedAfterRelay(relay, { 'pds-main': [before], nginx: [before] })).toBeNull();
    expect(startedAfterRelay(relay, { 'pds-main': ['0001-01-01T00:00:00Z'], nginx: [] })).toBeNull();
  });
});

// A root with bin/ and lib/, the four-PDS globe as its snowglobe.yml, rendered with its certificates
// into the state under HOME (~/.local/share/snowglobe/four), and a docker on PATH that writes what
// it was asked to docker.log and fails, unless SHIM_EXIT says otherwise: a guard that let up
// through then ends the run at once instead of waiting on a globe. It says the name router is
// running once it was started (router.up), and that the project named other has an nginx up.
function globeRoot() {
  // realpath: on macOS tmpdir() is under /var, a link to /private/var, which is what a command's cwd reports.
  const r = mkdtempSync(join(realpathSync(tmpdir()), 'snowglobe-up-'));
  for (const d of ['bin', 'lib', 'stack/https/dns', 'stack/https/proxy', 'stack/pdsls', 'stack/jetstream']) cpSync(join(ROOT, d), join(r, d), { recursive: true });
  cpSync(join(ROOT, 'stack/https/nginx.conf.template'), join(r, 'stack/https/nginx.conf.template'));
  symlinkSync(join(ROOT, 'node_modules'), join(r, 'node_modules'));
  writeFileSync(join(r, 'package.json'), '{"type": "module"}\n');
  for (const f of ['docker-compose.yml', 'docker-compose.test.yml', 'docker-compose.relay.yml', 'init/init.sh']) { mkdirSync(dirname(join(r, 'stack', f)), { recursive: true }); cpSync(join(ROOT, 'stack', f), join(r, 'stack', f)); }
  const shim = join(r, 'shim');
  mkdirSync(shim);
  symlinkSync(process.execPath, join(shim, 'node'));
  const up = join(r, 'router.up');
  writeFileSync(
    join(shim, 'docker'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${join(r, 'docker.log')}`,
      // A command starting with SHIM_FAIL fails.
      '[ -n "$SHIM_FAIL" ] && case "$*" in "$SHIM_FAIL"*) exit 1;; esac',
      'case "$*" in',
      `  *'ps -a --format'*) echo 'exited 0';;`,
      // Running, on its own network, joined to the networks of four and two.
      `  'inspect --type container -f '*' snowglobe-router') [ -f ${up} ] && echo 'true||snowglobe-router|snowglobe-router four_snowglobe two_snowglobe ' && exit 0;;`,
      `  'network ls'*) printf 'mine_snowglobe\\nfour_snowglobe\\ntwo_snowglobe\\n';;`,
      `  'start snowglobe-router') touch ${up};;`,
      `  'rm -f snowglobe-router') rm -f ${up};;`,
      `  *'com.docker.compose.project=other'*) echo 0123abcd; exit 0;;`,
      'esac',
      'exit "${SHIM_EXIT:-1}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  cpSync(FOUR, join(r, 'snowglobe.yml'));
  for (const args of [['render'], ['certs']]) expect(sg(r, args).status).toBe(0);
  return r;
}
// An address no globe is on, so nothing here can reach one.
function sg(r: string, args: string[], env: Record<string, string> = {}, path = `${join(r, 'shim')}:${process.env.PATH}`) {
  const base = { PATH: path, HOME: r, SG_BIND: '127.77.0.9' };
  return spawnSync(join(r, 'shim/node'), [join(r, 'bin/snowglobe.mjs'), ...args], { cwd: r, env: { ...base, ...env }, encoding: 'utf8', timeout: 60000 });
}
// The four-PDS globe's state folder, and the user's CA beside it.
const state = (r: string, f = '') => join(r, '.local/share/snowglobe/four', f);
const dockerLog = (r: string) => (existsSync(join(r, 'docker.log')) ? readFileSync(join(r, 'docker.log'), 'utf8') : '');

describe('snowglobe up and down', () => {
  it('refuse the shared devnet before any docker command', () => {
    const r = globeRoot();
    for (const cmd of [['up'], ['down', '-v']]) {
      const shared = sg(r, cmd, { SG_PROJECT: 'devnet-spaces' });
      expect(shared.status, cmd[0]).toBe(3);
      expect(shared.stderr).toContain('devnet-spaces');
    }
    expect(dockerLog(r)).toBe('');
  });

  it('name the compose project for the file, unless SG_PROJECT is set', () => {
    const r = globeRoot();
    expect(sg(r, ['down'], { SHIM_EXIT: '0' }).status).toBe(0);
    expect(sg(r, ['down'], { SG_PROJECT: 'mine', SHIM_EXIT: '0' }).status).toBe(0);
    expect(dockerLog(r).split('\n').map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual(['compose -p four', 'compose -p mine', '']);
  });

  it('down stops the project on the rendered globe, with its volumes on -v', () => {
    const r = globeRoot();
    expect(sg(r, ['down', '-v'], { SG_PROJECT: 'mine', SHIM_EXIT: '0' }).status).toBe(0);
    expect(sg(r, ['down'], { SG_PROJECT: 'devnet-spaces', SG_RESET_OK: '1', SHIM_EXIT: '0' }).status).toBe(0);
    expect(dockerLog(r)).toBe(
      `compose -p mine --project-directory ${r} -f ${state(r, 'globe/compose.yml')} down --remove-orphans -v\n` +
        `compose -p devnet-spaces --project-directory ${r} -f ${state(r, 'globe/compose.yml')} down --remove-orphans\n`,
    );
    expect(sg(r, ['down', '--force'], { SG_PROJECT: 'mine' }).status).toBe(2);
  });

  it('up refuses a PDS named for an app\'s ending, and leaves the render as it was', () => {
    const r = globeRoot();
    writeFileSync(state(r, 'https/apps'), 'atmo 5173 beta\n');
    const before = readFileSync(state(r, 'globe/globe.env'), 'utf8');
    const res = sg(r, ['up'], { SG_PROJECT: 'mine' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('atmo');
    expect(readFileSync(state(r, 'globe/globe.env'), 'utf8')).toBe(before);
    expect(dockerLog(r)).toBe('');
  });

  it('up refuses a saved ending named app, naming the line, and starts nothing', () => {
    const r = globeRoot();
    writeFileSync(state(r, 'https/apps'), 'ok 5000\nold 5173 app\n');
    const before = readFileSync(state(r, 'globe/globe.env'), 'utf8');
    const res = sg(r, ['up'], { SG_PROJECT: 'mine' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('"old 5173 app"');
    expect(res.stderr).toContain('app --remove old');
    expect(readFileSync(state(r, 'globe/globe.env'), 'utf8')).toBe(before);
    expect(dockerLog(r)).toBe('');
    // render refuses it too, so the nginx server for it is never written.
    expect(sg(r, ['app', '--render']).status).toBe(1);
  });

  it('up restarts nginx when its template changed since it last started, even with the leaf current', () => {
    const r = globeRoot();
    // 127.0.0.1, not the file's 127.77.0.9: nothing answers there, so the wait fails at once; macOS has only 127.0.0.1
    // on loopback, and a connect to any other 127.x address hangs.
    const env = { SG_PROJECT: 'mine', SHIM_EXIT: '0', SG_NGINX_WAIT: '1', SG_BIND: '127.0.0.1' };
    // No stamp yet, as after an upgrade: the leaf is current (render and certs ran), the template is not known.
    expect(existsSync(state(r, 'https/nginx-template.sha256'))).toBe(false);
    sg(r, ['up'], env);
    const calls = () => dockerLog(r).split('\n').filter((l) => / (restart nginx|exec -T nginx nginx -s reload)$/.test(l)).map((l) => l.replace(/^.* (restart|exec) /, '$1 '));
    expect(calls()).toEqual(['restart nginx']);
    expect(existsSync(state(r, 'https/nginx-template.sha256'))).toBe(true);
    // Unchanged template: a reload only.
    sg(r, ['up'], env);
    expect(calls()).toEqual(['restart nginx', 'exec -T nginx nginx -s reload']);
    // A changed template: restarted again.
    writeFileSync(join(r, 'stack/https/nginx.conf.template'), readFileSync(join(r, 'stack/https/nginx.conf.template'), 'utf8') + '# changed\n');
    sg(r, ['up'], env);
    expect(calls()).toEqual(['restart nginx', 'exec -T nginx nginx -s reload', 'restart nginx']);
    // A changed network page config, such as a new health path: restarted again.
    mkdirSync(join(r, 'stack/page'), { recursive: true });
    writeFileSync(join(r, 'stack/page/snowglobe.conf'), '# changed\n');
    sg(r, ['up'], env);
    expect(calls()).toEqual(['restart nginx', 'exec -T nginx nginx -s reload', 'restart nginx', 'restart nginx']);
  });

  it('up refuses a SG_BIND that is not loopback before any docker command', () => {
    const r = globeRoot();
    expect(sg(r, ['up'], { SG_PROJECT: 'mine', SG_BIND: '0.0.0.0' }).status).toBe(1);
    expect(dockerLog(r)).toBe('');
  });
});

describe('the name router', () => {
  const routes = (r: string, f = '') => join(r, '.local/share/snowglobe/.router/routes', f);

  it.skipIf(!linux)('up routes the globe\'s domain to its nginx, joins its network, and starts the router after pass 1', () => {
    const r = globeRoot();
    // nginx never answers at 127.77.0.9, so up stops at the wait after the router step.
    sg(r, ['up'], { SG_PROJECT: 'mine', SHIM_EXIT: '0', SG_NGINX_WAIT: '1' });
    // Keyed by the compose project, which is what is unique on a machine.
    expect(readFileSync(routes(r, 'mine'), 'utf8')).toBe('four.test 127.77.0.9 four\n');
    const conf = readFileSync(join(r, '.local/share/snowglobe/.router/nginx.conf'), 'utf8');
    expect(conf).toContain('.four.test mine-nginx-1:443;');
    const log = dockerLog(r).split('\n');
    const create = log.findIndex((l) => l.startsWith('create --name snowglobe-router'));
    const joined = log.indexOf('network connect mine_snowglobe snowglobe-router');
    const start = log.indexOf('start snowglobe-router');
    expect(create).toBeGreaterThan(log.findIndex((l) => l.endsWith('up -d --remove-orphans')));
    expect(joined).toBeGreaterThan(create);
    expect(start).toBeGreaterThan(joined);
    // An ordinary container: a published port, on a network of its own.
    expect(log[create]).toContain('-p 127.0.0.1:443:443');
    expect(log[create]).toContain('--network snowglobe-router');
    expect(log[create]).not.toContain('--network host');
    expect(log[create]).toContain(`${join(r, '.local/share/snowglobe/.router')}:/etc/snowglobe-router:ro`);
  });

  it.skipIf(!linux)('up refuses a domain another running snowglobe is routed at, before any compose command', () => {
    const r = globeRoot();
    mkdirSync(routes(r), { recursive: true });
    writeFileSync(routes(r, 'other'), 'four.test 127.0.0.3 other\n');
    const res = sg(r, ['up'], { SG_PROJECT: 'mine', SHIM_EXIT: '0' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('compose project other');
    expect(dockerLog(r)).not.toContain('compose -p');
    // A route whose project has no nginx up is stale, and no bar: it is dropped, since nginx
    // refuses the whole config with two routes at one domain.
    unlinkSync(routes(r, 'other'));
    writeFileSync(routes(r, 'gone'), 'four.test 127.0.0.3 gone\n');
    sg(r, ['up'], { SG_PROJECT: 'mine', SHIM_EXIT: '0', SG_NGINX_WAIT: '1' });
    expect(dockerLog(r)).toContain('compose -p mine');
    expect(existsSync(routes(r, 'gone'))).toBe(false);
    const conf = readFileSync(join(r, '.local/share/snowglobe/.router/nginx.conf'), 'utf8');
    expect(conf.match(/^\s+\.four\.test /gm)).toEqual([expect.stringContaining('.four.test')]);
    expect(conf).toContain('.four.test mine-nginx-1:443;');
  });

  it.skipIf(!linux)('leaves the router alone for a globe on its own address, and says why', () => {
    const r = globeRoot();
    const res = sg(r, ['up'], { SG_PROJECT: 'mine', SHIM_EXIT: '0', SG_NGINX_WAIT: '1', SG_BIND: '127.0.0.1' });
    expect(res.stderr).toContain('the name router\'s address');
    expect(existsSync(routes(r, 'mine'))).toBe(false);
    expect(dockerLog(r)).not.toContain('snowglobe-router');
  });

  it.skipIf(!linux)('down stops routing to the globe and leaves its network before compose takes it down, and removes the router with the last route', () => {
    const r = globeRoot();
    mkdirSync(routes(r), { recursive: true });
    writeFileSync(routes(r, 'four'), 'four.test 127.77.0.9 four\n');
    writeFileSync(routes(r, 'two'), 'two.local.snowglobe.at 127.0.0.3 two\n');
    writeFileSync(join(r, 'router.up'), '');
    expect(sg(r, ['down'], { SHIM_EXIT: '0' }).status).toBe(0);
    expect(existsSync(routes(r, 'four'))).toBe(false);
    let log = dockerLog(r).split('\n');
    const composeDown = () => log.findIndex((l) => l.startsWith('compose -p four ') && l.includes(' down '));
    expect(log).toContain('exec snowglobe-router nginx -s reload -c /etc/snowglobe-router/nginx.conf');
    // Compose cannot remove a network the router is still joined to.
    expect(log.indexOf('network disconnect four_snowglobe snowglobe-router')).toBeGreaterThan(-1);
    expect(log.indexOf('network disconnect four_snowglobe snowglobe-router')).toBeLessThan(composeDown());
    expect(log).not.toContain('network disconnect two_snowglobe snowglobe-router');
    expect(readFileSync(join(r, '.local/share/snowglobe/.router/nginx.conf'), 'utf8')).not.toContain('four.test');
    // The last one: the router and its network go, before compose.
    writeFileSync(join(r, 'docker.log'), '');
    writeFileSync(routes(r, 'four'), 'four.test 127.77.0.9 four\n');
    unlinkSync(routes(r, 'two'));
    expect(sg(r, ['down'], { SHIM_EXIT: '0' }).status).toBe(0);
    log = dockerLog(r).split('\n');
    expect(log.indexOf('rm -f snowglobe-router')).toBeGreaterThan(-1);
    expect(log.indexOf('network rm snowglobe-router')).toBeGreaterThan(log.indexOf('rm -f snowglobe-router'));
    expect(log.indexOf('network rm snowglobe-router')).toBeLessThan(composeDown());
    expect(existsSync(join(r, 'router.up'))).toBe(false);
  });

  it.skipIf(!linux)('down takes the globe down when the router cannot leave its network, then fails', () => {
    const r = globeRoot();
    mkdirSync(routes(r), { recursive: true });
    writeFileSync(routes(r, 'four'), 'four.test 127.77.0.9 four\n');
    writeFileSync(routes(r, 'two'), 'two.local.snowglobe.at 127.0.0.3 two\n');
    writeFileSync(join(r, 'router.up'), '');
    const res = sg(r, ['down'], { SHIM_EXIT: '0', SHIM_FAIL: 'network disconnect' });
    expect(res.status).not.toBe(0);
    expect(dockerLog(r)).toMatch(/^compose -p four .* down --remove-orphans$/m);
  });

  it('ls names the router and what it routes, and lists no snowglobe for its folder', () => {
    const r = globeRoot();
    mkdirSync(routes(r), { recursive: true });
    writeFileSync(routes(r, 'four'), 'four.test 127.77.0.9 four\n');
    const res = sg(r, ['ls']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('Name router on 127.0.0.1:443: not running, routing four.test to four');
    expect(res.stdout).not.toMatch(/^\.router/m);
    // A route can outlive its state folder; ls still shows it.
    rmSync(state(r), { recursive: true });
    const none = sg(r, ['ls']);
    expect(none.stdout).toContain('No snowglobes in');
    expect(none.stdout).toContain('routing four.test to four');
  });
});

describe('snowglobe run', () => {
  it('maps no names: the command sees the machine\'s own hosts file and resolver', () => {
    const r = globeRoot();
    const res = sg(r, ['run', 'node', '-e', 'process.stdout.write(require("fs").readFileSync("/etc/hosts", "utf8"))']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(readFileSync('/etc/hosts', 'utf8'));
  });

  it('trusts the globe\'s CA in Node, and exits with the command\'s code', () => {
    const r = globeRoot();
    const ca = sg(r, ['run', 'node', '-e', 'console.log(process.env.NODE_EXTRA_CA_CERTS)']);
    expect(ca.stdout.trim()).toBe(join(r, '.local/share/snowglobe/ca/ca.crt'));
    expect(sg(r, ['run', 'sh', '-c', 'exit 7']).status).toBe(7);
  });

  it('hands the app\'s settings over, logins too, over the environment, and says which it replaced', () => {
    const r = globeRoot();
    writeFileSync(join(r, 'snowglobe.yml'), `${readFileSync(FOUR, 'utf8')}apps:\n  - name: web\n    env:\n      PLC: \${services.plc.url}\n      PW: \${accounts.alice.password}\n      KEEP: \${domain}\n`);
    writeFileSync(state(r, 'accounts.env'), 'ALICE_PASSWORD=hunter2\n');
    const show = ['node', '-e', 'console.log([process.env.PLC, process.env.PW, process.env.KEEP].join(" "))'];
    const res = sg(r, ['run', '--', ...show], { PLC: 'https://plc.directory', KEEP: 'four.test' });
    expect(res.stdout.trim()).toBe('https://plc.four.test hunter2 four.test');
    // One line, naming only what changed, and no value.
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr).toContain('replaced PLC from the environment');
    expect(res.stderr).not.toMatch(/KEEP|hunter2|plc\.directory/);
    expect(sg(r, ['run', '--app', 'web', ...show]).stdout.trim()).toBe('https://plc.four.test hunter2 four.test');
    expect(sg(r, ['run', '--app', 'nope', ...show]).status).toBe(2);
  });

  it('names a CA setting it replaced, and stays quiet when the value is the same', () => {
    const r = globeRoot();
    const ca = join(r, '.local/share/snowglobe/ca/ca.crt');
    writeFileSync(join(r, 'snowglobe.yml'), `${readFileSync(FOUR, 'utf8')}apps:\n  - name: web\n    env:\n      NODE_EXTRA_CA_CERTS: \${ca.file}\n`);
    const show = ['node', '-e', 'console.log(process.env.NODE_EXTRA_CA_CERTS)'];
    // A real file, or node itself warns about it at start.
    const elsewhere = join(r, 'elsewhere.crt');
    copyFileSync(ca, elsewhere);
    const other = sg(r, ['run', ...show], { NODE_EXTRA_CA_CERTS: elsewhere });
    expect(other.stdout.trim()).toBe(ca);
    expect(other.stderr).toContain('replaced NODE_EXTRA_CA_CERTS from the environment');
    expect(sg(r, ['run', ...show], { NODE_EXTRA_CA_CERTS: ca }).stderr).toBe('');
    // Without its own mapping, run's CA is not "a replaced setting".
    writeFileSync(join(r, 'snowglobe.yml'), readFileSync(FOUR, 'utf8'));
    expect(sg(r, ['run', ...show], { NODE_EXTRA_CA_CERTS: elsewhere }).stderr).toBe('');
  });

  it('needs no bubblewrap: only the command itself on PATH', () => {
    const r = globeRoot();
    const res = sg(r, ['run', 'node', '-e', 'process.exit(3)'], {}, join(r, 'shim'));
    expect(res.status, res.stderr).toBe(3);
  });

  it('takes no empty command', () => {
    const r = globeRoot();
    expect(sg(r, ['run']).status).toBe(2);
    expect(sg(r, ['run', '--']).status).toBe(2);
  });
});

describe('what up seeds from the file', () => {
  it('sets the file\'s app routes and keeps the others', () => {
    const routes = [{ name: 'probe', port: 5480, ending: null }, { name: 'atmo', port: 1, ending: null }];
    const file = [{ name: 'atmo', local: { port: 5173, handles: 'ev' } }, { name: 'web', local: { port: 8080, handles: null } }, { name: 'far', local: null }];
    expect(mergeRoutes(routes, file)).toEqual([
      { name: 'probe', port: 5480, ending: null },
      { name: 'atmo', port: 5173, ending: 'ev' },
      { name: 'web', port: 8080, ending: null },
    ]);
    expect(() => mergeRoutes([{ name: 'other', port: 1, ending: 'ev' }], file)).toThrow();
  });

  it('keeps each account\'s login under its name on the home PDS, with the PDS elsewhere', () => {
    const accounts = [{ name: 'alice', pds: 'alpha' }, { name: 'bob', pds: 'regular' }, { name: 'my-bot', pds: 'alpha' }, { name: '1st', pds: 'alpha' }];
    expect(accountPrefixes(accounts, 'alpha').map((a: { prefix: string }) => a.prefix)).toEqual(['ALICE', 'BOB_REGULAR', 'MY_BOT', '_1ST']);
    expect(() => accountPrefixes([{ name: 'bob', pds: 'regular' }, { name: 'bob-regular', pds: 'alpha' }], 'alpha')).toThrow();
  });
});

// snowglobe up, down and run, without a globe: what up writes and checks before Docker, the guard
// on the project, and the names run maps. Run them alone with `npx vitest run snowglobe-up`. The
// CLI runs on a copy of bin/ and lib/ in a temporary root, with a docker on PATH that only records
// what it was asked; bringing a globe up for real is checked by hand on an isolated copy.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { accountPrefixes, endingClash, mergeRoutes, startedAfterRelay } from '../lib/up.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { hostsFile, runNames } from '../lib/hosts.mjs';

const ROOT = join(__dirname, '..');
const FOUR = join(ROOT, 'test/snowglobe/four.yml');
const bwrapWorks = spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true']).status === 0;

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

describe('what run maps', () => {
  it('maps the leaf\'s names but its wildcards, handles, apps and extras, each once', () => {
    const names = runNames({
      leafNames: 'four.test\nalpha.four.test\n*.four.test\nplc.directory\n*.app.four.test\n',
      domain: 'four.test',
      handles: 'carol.four.test\nnot a name\nalpha.four.test\n',
      apps: [{ name: 'probe', port: 5480, ending: null }],
      extra: ' x.example  y.example ',
    });
    expect(names).toEqual(['four.test', 'alpha.four.test', 'plc.directory', 'carol.four.test', 'probe.app.four.test', 'x.example', 'y.example']);
  });

  it('keeps the machine\'s hosts file but the lines naming one of ours', () => {
    const etc = '127.0.0.1 localhost\n10.0.0.5 plc.directory other\n# a comment\n';
    expect(hostsFile(etc, ['plc.directory', 'four.test'], '127.0.0.2')).toBe(
      '127.0.0.1 localhost\n# a comment\n# snowglobe (bin/snowglobe.mjs run)\n127.0.0.2 plc.directory\n127.0.0.2 four.test\n',
    );
  });
});

// A root with bin/ and lib/, the four-PDS globe as its snowglobe.yml, rendered with its certificates
// into the state under HOME (~/.local/share/snowglobe/four), and a docker on PATH that writes what
// it was asked to docker.log and fails, unless SHIM_EXIT says otherwise: a guard that let up
// through then ends the run at once instead of waiting on a globe.
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
  writeFileSync(join(shim, 'docker'), `#!/bin/sh\necho "$*" >> ${join(r, 'docker.log')}\ncase "$*" in *'ps -a --format'*) echo 'exited 0';; esac\nexit "\${SHIM_EXIT:-1}"\n`, { mode: 0o755 });
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

describe('snowglobe run', () => {
  it.skipIf(!bwrapWorks)('maps every PDS, handle and app name to SG_BIND, for the command alone', () => {
    const r = globeRoot();
    writeFileSync(state(r, 'https/apps'), 'probe 5480\n');
    writeFileSync(state(r, 'https/names'), 'carol.beta.four.test\n');
    const names = ['four.test', 'alpha.four.test', 'beta.four.test', 'regular.four.test', 'prod.four.test', 'plc.directory', 'carol.beta.four.test', 'probe.app.four.test', 'x.example'];
    const res = sg(r, ['run', '--', 'getent', 'hosts', ...names], { SG_BIND: '127.0.0.9', HTTPS_RUN_EXTRA_NAMES: 'x.example' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim().split('\n').map((l) => l.split(/\s+/))).toEqual(names.map((n) => ['127.0.0.9', n]));
    // Outside run, none of the globe's own names resolves.
    expect(spawnSync('getent', ['hosts', 'beta.four.test']).status).not.toBe(0);
  });

  it.skipIf(!bwrapWorks)('trusts the globe\'s CA in Node, and exits with the command\'s code', () => {
    const r = globeRoot();
    const ca = sg(r, ['run', 'node', '-e', 'console.log(process.env.NODE_EXTRA_CA_CERTS)']);
    expect(ca.stdout.trim()).toBe(join(r, '.local/share/snowglobe/ca/ca.crt'));
    expect(sg(r, ['run', 'sh', '-c', 'exit 7']).status).toBe(7);
  });

  it.skipIf(!bwrapWorks)('hands the app\'s settings over, logins too, over the environment, and says which it replaced', () => {
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

  it.skipIf(!bwrapWorks)('names a CA setting it replaced, and stays quiet when the value is the same', () => {
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

  it('says plainly that it needs bubblewrap when there is none', () => {
    const r = globeRoot();
    const res = sg(r, ['run', 'true'], {}, join(r, 'shim'));
    expect(res.status).toBe(1);
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr).toContain('bubblewrap');
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

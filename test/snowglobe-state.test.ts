// Where a snowglobe's state is and which file last brought it up (lib/state.mjs, lib/env.mjs): the
// state folder per user, the file found from the folder you are in, the compose project from its
// name, a second file with the same name taking it over (and what it says), and the notice for a
// checkout's old data/.
// No Docker needed: the CLI runs on a copy of bin/ and lib/ in a temporary root, with a docker on
// PATH that only records what it was asked. Run them alone with `npx vitest run snowglobe-state`.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { oldDataNotice, renamedDefaultNotice, stateRoot } from '../lib/env.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { findFile, pointedAt } from '../lib/state.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { list, stateWord } from '../lib/commands/ls.mjs';

const ROOT = join(__dirname, '..');
const FOUR = join(ROOT, 'test/snowglobe/four.yml');

describe('stateRoot', () => {
  const home = '/home/u';
  it('is under XDG_DATA_HOME, else ~/.local/share', () => {
    expect(stateRoot({ XDG_DATA_HOME: '/x/data' }, { platform: 'linux', home })).toBe('/x/data/snowglobe');
    expect(stateRoot({}, { platform: 'linux', home })).toBe('/home/u/.local/share/snowglobe');
    expect(stateRoot({}, { platform: 'darwin', home })).toBe('/home/u/.local/share/snowglobe');
  });

  it('ignores a relative XDG_DATA_HOME, as the XDG rules say', () => {
    expect(stateRoot({ XDG_DATA_HOME: 'data' }, { platform: 'linux', home })).toBe('/home/u/.local/share/snowglobe');
  });

  it('is under LOCALAPPDATA on Windows', () => {
    const win = stateRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, { platform: 'win32', home: 'C:\\Users\\u' });
    expect(win.startsWith('C:\\Users\\u\\AppData\\Local')).toBe(true);
    expect(win.endsWith('snowglobe')).toBe(true);
  });
});

describe('findFile', () => {
  const tree = () => {
    const top = mkdtempSync(join(tmpdir(), 'snowglobe-find-'));
    mkdirSync(join(top, 'a/b/c'), { recursive: true });
    return top;
  };

  it('takes the file given, then SG_FILE, then the nearest snowglobe.yml at or above the folder', () => {
    const top = tree();
    writeFileSync(join(top, 'snowglobe.yml'), 'globe: top\n');
    writeFileSync(join(top, 'a/snowglobe.yml'), 'globe: mid\n');
    expect(findFile({ file: 'x.yml', env: { SG_FILE: 'y.yml' }, cwd: top })).toBe('x.yml');
    expect(findFile({ env: { SG_FILE: 'y.yml' }, cwd: top })).toBe('y.yml');
    expect(findFile({ env: {}, cwd: top })).toBe('snowglobe.yml');
    expect(findFile({ env: {}, cwd: join(top, 'a/b/c') })).toBe(join(top, 'a/snowglobe.yml'));
  });

  it('refuses to fall back to the default for a command that starts something', () => {
    expect(() => findFile({ env: {}, cwd: tmpdir(), allowDefault: false })).toThrow(/up --default/);
    expect(findFile({ env: { SG_FILE: 'y.yml' }, cwd: tmpdir(), allowDefault: false })).toBe('y.yml');
  });

  it('falls back to the default globe at the repo root', () => {
    expect(findFile({ env: {}, cwd: tmpdir() })).toBe(join(ROOT, 'snowglobe.default.yml'));
  });
});

describe('oldDataNotice', () => {
  const checkout = (files: string[]) => {
    const r = mkdtempSync(join(tmpdir(), 'snowglobe-old-'));
    for (const f of files) {
      mkdirSync(join(r, 'data', f, '..'), { recursive: true });
      writeFileSync(join(r, 'data', f), f === 'devnet.env' ? 'SG_PROJECT=devnet-spaces\n' : 'x\n');
    }
    return r;
  };

  it('is null for a checkout with no globe in data/ (the plain http stack keeps its logins there)', () => {
    expect(oldDataNotice(checkout(['accounts.env']), '/s/four')).toBeNull();
  });

  it('names the move, and the compose project the old globe ran under', () => {
    const text = oldDataNotice(checkout(['devnet.env', 'accounts.env', 'globe/compose.yml']), '/s/four', 'linux');
    expect(text).toContain('mkdir -p "/s/four/https"');
    expect(text).toMatch(/mv ".*\/data\/accounts\.env" "\/s\/four\/accounts\.env"/);
    expect(text).toMatch(/mv ".*\/data\/globe" "\/s\/four\/globe"/);
    expect(text).toContain('SG_PROJECT=devnet-spaces snowglobe up');
    expect(text).toContain('Nothing was changed');
  });

  it('says it in PowerShell on Windows', () => {
    const text = oldDataNotice(checkout(['devnet.env']), 'C:\\s\\four', 'win32');
    expect(text).toContain('Move-Item');
    expect(text).toContain('$env:SG_PROJECT=devnet-spaces');
  });

  it('is null once the state folder has the globe', () => {
    const r = checkout(['devnet.env']);
    const s = mkdtempSync(join(tmpdir(), 'snowglobe-state-'));
    mkdirSync(join(s, 'globe'));
    writeFileSync(join(s, 'globe/compose.yml'), 'services: {}\n');
    expect(oldDataNotice(r, s)).toBeNull();
  });
});

describe('renamedDefaultNotice', () => {
  // A state root holding an install made when the default snowglobe was still called devnet.
  const root = (old: boolean) => {
    const s = mkdtempSync(join(tmpdir(), 'snowglobe-renamed-'));
    if (old) {
      mkdirSync(join(s, 'devnet/globe'), { recursive: true });
      writeFileSync(join(s, 'devnet/globe/compose.yml'), 'services: {}\n');
    }
    return s;
  };

  it('is null when nothing was made under the old name', () => {
    const s = root(false);
    expect(renamedDefaultNotice('/repo', join(s, 'snowglobe'))).toBeNull();
  });

  it('names the old folder and the commands to keep it or drop it, and changes nothing', () => {
    const s = root(true);
    const text = renamedDefaultNotice('/repo', join(s, 'snowglobe'), 'linux');
    expect(text).toContain(`mv "${join(s, 'devnet')}" "${join(s, 'snowglobe')}"`);
    expect(text).toContain('SG_PROJECT=devnet snowglobe up --default');
    expect(text).toContain(`docker compose -p devnet --project-directory "/repo" -f "${join(s, 'devnet/globe/compose.yml')}" down -v`);
    expect(text).toContain('Nothing was changed');
    expect(existsSync(join(s, 'devnet/globe/compose.yml'))).toBe(true);
    expect(existsSync(join(s, 'snowglobe'))).toBe(false);
  });

  it('says it in PowerShell on Windows', () => {
    const s = root(true);
    const text = renamedDefaultNotice('C:\\repo', join(s, 'snowglobe'), 'win32');
    expect(text).toContain('Move-Item');
    expect(text).toContain("$env:SG_PROJECT='devnet'");
  });

  it('is null once the snowglobe folder has its globe', () => {
    const s = root(true);
    mkdirSync(join(s, 'snowglobe/globe'), { recursive: true });
    writeFileSync(join(s, 'snowglobe/globe/compose.yml'), 'services: {}\n');
    expect(renamedDefaultNotice('/repo', join(s, 'snowglobe'))).toBeNull();
  });
});

// A root with bin/ and lib/, a docker on PATH that writes what it was asked to docker.log and
// fails, and HOME (so the state) inside it.
function box() {
  const r = mkdtempSync(join(tmpdir(), 'snowglobe-box-'));
  for (const d of ['bin', 'lib', 'stack/https/dns', 'stack/https/proxy', 'stack/pdsls']) cpSync(join(ROOT, d), join(r, d), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(r, 'node_modules'));
  writeFileSync(join(r, 'package.json'), '{"type": "module"}\n');
  for (const f of ['docker-compose.yml', 'docker-compose.test.yml', 'docker-compose.relay.yml', 'init/init.sh']) { mkdirSync(dirname(join(r, 'stack', f)), { recursive: true }); cpSync(join(ROOT, 'stack', f), join(r, 'stack', f)); }
  cpSync(join(ROOT, 'snowglobe.default.yml'), join(r, 'snowglobe.default.yml'));
  const shim = join(r, 'shim');
  mkdirSync(shim);
  symlinkSync(process.execPath, join(shim, 'node'));
  writeFileSync(join(shim, 'docker'), `#!/bin/sh\necho "$*" >> ${join(r, 'docker.log')}\nexit "\${SHIM_EXIT:-1}"\n`, { mode: 0o755 });
  return r;
}
function sg(r: string, cwd: string, args: string[], env: Record<string, string> = {}) {
  const base = { PATH: `${join(r, 'shim')}:${process.env.PATH}`, HOME: r, SG_BIND: '127.77.0.9' };
  return spawnSync(join(r, 'shim/node'), [join(r, 'bin/snowglobe.mjs'), ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8', timeout: 60000 });
}
const dockerLog = (r: string) => (existsSync(join(r, 'docker.log')) ? readFileSync(join(r, 'docker.log'), 'utf8') : '');
const tree = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name])) : [];

describe('a snowglobe is found from the folder you are in', () => {
  it('renders the same file from a subfolder, into the user\'s state and not the checkout', () => {
    const r = box();
    mkdirSync(join(r, 'proj/src/deep'), { recursive: true });
    cpSync(FOUR, join(r, 'proj/snowglobe.yml'));
    const here = sg(r, join(r, 'proj'), ['render']);
    const below = sg(r, join(r, 'proj/src/deep'), ['render']);
    expect(here.status, here.stderr).toBe(0);
    expect(below.status, below.stderr).toBe(0);
    expect(here.stdout).toContain('snowglobe.yml:');
    expect(below.stdout).toContain(`${join(r, 'proj/snowglobe.yml')}:`);
    expect(existsSync(join(r, '.local/share/snowglobe/four/globe/compose.yml'))).toBe(true);
    expect(readFileSync(join(r, '.local/share/snowglobe/four/owner'), 'utf8').trim()).toContain('proj/snowglobe.yml');
    expect(existsSync(join(r, 'data'))).toBe(false);
  });

  it('puts the state under XDG_DATA_HOME when it is set', () => {
    const r = box();
    cpSync(FOUR, join(r, 'snowglobe.yml'));
    expect(sg(r, r, ['render'], { XDG_DATA_HOME: join(r, 'xdg') }).status).toBe(0);
    expect(existsSync(join(r, 'xdg/snowglobe/four/globe/compose.yml'))).toBe(true);
    expect(existsSync(join(r, '.local'))).toBe(false);
  });

  it('keeps the state apart by globe name, so a second snowglobe needs no second checkout', () => {
    const r = box();
    mkdirSync(join(r, 'one'));
    mkdirSync(join(r, 'two'));
    cpSync(FOUR, join(r, 'one/snowglobe.yml'));
    writeFileSync(join(r, 'two/snowglobe.yml'), readFileSync(FOUR, 'utf8').replace('globe: four', 'globe: other'));
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    expect(sg(r, join(r, 'two'), ['render']).status).toBe(0);
    expect(readdirSync(join(r, '.local/share/snowglobe')).sort()).toEqual(['four', 'other']);
  });

  it('takes a second file with the same globe name as the same snowglobe, the last to render it deciding, and says so', () => {
    const r = box();
    mkdirSync(join(r, 'one'));
    mkdirSync(join(r, 'two'));
    cpSync(FOUR, join(r, 'one/snowglobe.yml'));
    cpSync(FOUR, join(r, 'two/snowglobe.yml'));
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    const res = sg(r, join(r, 'two'), ['render']);
    expect(res.status).toBe(0);
    const lines = res.stderr.split('\n').filter((l) => l.includes('was last brought up from'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(r, 'one/snowglobe.yml'));
    expect(lines[0]).toContain(join(r, 'two/snowglobe.yml'));
    expect(readdirSync(join(r, '.local/share/snowglobe'))).toEqual(['four']);
    expect(readFileSync(join(r, '.local/share/snowglobe/four/owner'), 'utf8')).toContain(join(r, 'two'));
    // The same file again says nothing.
    expect(sg(r, join(r, 'two'), ['render']).stderr).not.toContain('was last brought up from');
  });

  it('lets a file take over a name whose first file is gone', () => {
    const r = box();
    mkdirSync(join(r, 'one'));
    mkdirSync(join(r, 'two'));
    cpSync(FOUR, join(r, 'one/snowglobe.yml'));
    cpSync(FOUR, join(r, 'two/snowglobe.yml'));
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    spawnSync('rm', ['-r', join(r, 'one')]);
    expect(sg(r, join(r, 'two'), ['render']).status).toBe(0);
    expect(readFileSync(join(r, '.local/share/snowglobe/four/owner'), 'utf8')).toContain(join(r, 'two'));
  });

  it('says so when up brings up a snowglobe another file brought up before', () => {
    const r = box();
    mkdirSync(join(r, 'one'));
    mkdirSync(join(r, 'two'));
    cpSync(FOUR, join(r, 'one/snowglobe.yml'));
    cpSync(FOUR, join(r, 'two/snowglobe.yml'));
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    const res = sg(r, join(r, 'two'), ['up']);
    const lines = res.stderr.split('\n').filter((l) => l.includes('was last brought up from'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(r, 'one/snowglobe.yml'));
    expect(lines[0]).toContain(join(r, 'two/snowglobe.yml'));
  });

  it('keeps the record, and says nothing, when a second file\'s up or render is refused', () => {
    const r = box();
    for (const d of ['one', 'two', 'three']) mkdirSync(join(r, d));
    cpSync(FOUR, join(r, 'one/snowglobe.yml'));
    // two's app claims the ending one's route holds; three's group host has nowhere to get an image.
    writeFileSync(join(r, 'two/snowglobe.yml'), `${readFileSync(FOUR, 'utf8')}apps:\n  - { name: x, local: { port: 4001, handles: hh } }\n`);
    writeFileSync(join(r, 'three/snowglobe.yml'), `${readFileSync(FOUR, 'utf8')}grouphosts:\n  - { name: gh, kind: opensocial }\n`);
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    expect(sg(r, join(r, 'one'), ['app', 'other', '4000', 'hh']).status).toBe(0);
    for (const [dir, cmd] of [['two', 'up'], ['three', 'render']]) {
      const res = sg(r, join(r, dir), [cmd]);
      expect(res.status, `${dir} ${cmd}`).not.toBe(0);
      expect(res.stderr).not.toContain('was last brought up from');
      expect(readFileSync(join(r, '.local/share/snowglobe/four/owner'), 'utf8')).toContain(join(r, 'one'));
    }
  });

  it('warns once when env reads a file that differs from what the last up rendered, and not for the same globe', () => {
    const r = box();
    for (const d of ['one', 'two', 'three']) mkdirSync(join(r, d));
    cpSync(FOUR, join(r, 'one/snowglobe.yml'));
    const other = readFileSync(FOUR, 'utf8').replace('domain: four.test', 'domain: other.test').replace(/^ {2}- \{ name: beta,.*\n/m, '');
    writeFileSync(join(r, 'two/snowglobe.yml'), other);
    writeFileSync(join(r, 'three/snowglobe.yml'), other);
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    expect(sg(r, join(r, 'two'), ['render']).status).toBe(0);
    const warned = (dir: string) => sg(r, join(r, dir), ['env']).stderr.split('\n').filter((l) => l.includes('differs from the snowglobe four'));
    const lines = warned('one');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(r, 'two/snowglobe.yml'));
    expect(lines[0]).toContain('other.test');
    expect(lines[0]).toContain('alpha regular prod');
    // The file that rendered it, and a copy of it elsewhere (a second worktree), are the running globe.
    expect(warned('two')).toEqual([]);
    expect(warned('three')).toEqual([]);
  });

  it('warns when an account of the file is kept under another handle', () => {
    const r = box();
    mkdirSync(join(r, 'one'));
    writeFileSync(join(r, 'one/snowglobe.yml'), readFileSync(FOUR, 'utf8').replace('accounts: [alice@alpha, bob@alpha]', 'accounts: [alice@alpha, bob@alpha, carol@alpha]'));
    expect(sg(r, join(r, 'one'), ['render']).status).toBe(0);
    expect(sg(r, join(r, 'one'), ['env']).stderr).not.toContain('differs from the snowglobe four');
    // As another file's carol@beta keeps it, once beta is the seed PDS there.
    writeFileSync(join(r, '.local/share/snowglobe/four/accounts.env'), 'CAROL_HANDLE=carol.beta.four.test\nCAROL_DID=did:plc:carolonbeta\n');
    const lines = sg(r, join(r, 'one'), ['env']).stderr.split('\n').filter((l) => l.includes('differs from the snowglobe four'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('carol.beta.four.test');
  });

  it('refuses a bare up with no snowglobe.yml here or above, starts nothing, and says how to use the default', () => {
    const r = box();
    mkdirSync(join(r, 'empty/deep'), { recursive: true });
    const res = sg(r, join(r, 'empty/deep'), ['up']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(join(r, 'empty/deep'));
    expect(res.stderr).toContain('snowglobe up --default');
    expect(dockerLog(r)).toBe('');
    expect(existsSync(join(r, '.local'))).toBe(false);
  });

  it('takes up --default as the way to run the default file, but not with a file', () => {
    const r = box();
    mkdirSync(join(r, 'empty'));
    // The shim docker fails, so up gets as far as docker: past the refusal.
    const res = sg(r, join(r, 'empty'), ['up', '--default']);
    expect(res.stderr).not.toContain('--default');
    expect(res.stderr).toContain('globe snowglobe');
    expect(dockerLog(r)).not.toBe('');
    expect(sg(r, join(r, 'empty'), ['up', '--default', FOUR]).status).toBe(2);
  });

  it('keeps the old checkout\'s data/ as it was, and starts nothing, when up finds a globe in it', () => {
    const r = box();
    cpSync(FOUR, join(r, 'snowglobe.yml'));
    mkdirSync(join(r, 'data/globe'), { recursive: true });
    mkdirSync(join(r, 'data/https'), { recursive: true });
    writeFileSync(join(r, 'data/globe/compose.yml'), 'services: {}\n');
    writeFileSync(join(r, 'data/devnet.env'), 'SG_PROJECT=mine\n');
    writeFileSync(join(r, 'data/https/ca.crt'), 'x');
    const before = tree(join(r, 'data'));
    const res = sg(r, r, ['up']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('mv ');
    expect(res.stderr).toContain('SG_PROJECT=mine snowglobe up');
    expect(tree(join(r, 'data'))).toEqual(before);
    expect(dockerLog(r)).toBe('');
    expect(existsSync(join(r, '.local'))).toBe(false);
  });
});

describe('ls', () => {
  it('says so when there are no snowglobes, and asks Docker nothing', () => {
    const r = box();
    const res = sg(r, r, ['ls']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('No snowglobes');
    expect(dockerLog(r)).not.toContain('up');
  });

  it('lists each snowglobe in the state root with its domain and its file, and "unknown" when Docker does not answer', () => {
    const r = box();
    cpSync(FOUR, join(r, 'snowglobe.yml'));
    expect(sg(r, r, ['render']).status).toBe(0);
    mkdirSync(join(r, '.local/share/snowglobe/ca'), { recursive: true });
    const res = sg(r, r, ['ls']);
    expect(res.status, res.stderr).toBe(0);
    const rows = res.stdout.trimEnd().split('\n');
    expect(rows[0].split(/\s+/)).toEqual(['NAME', 'DOMAIN', 'STATE', 'FILE']);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^four\s+\S+\s+unknown\s+/);
    expect(rows[1]).toContain(join(r, 'snowglobe.yml'));
  });

  it('reads up and down off compose\'s status, one-shots that exited aside, and shows a file that is gone', () => {
    const r = box();
    const base = join(r, 'sg');
    for (const n of ['a', 'b', 'c', 'd']) mkdirSync(join(base, 'snowglobe', n), { recursive: true });
    mkdirSync(join(base, 'snowglobe/ca'));
    writeFileSync(join(base, 'snowglobe/d/owner'), '/no/such/snowglobe.yml\n');
    const statuses = new Map([
      ['a', 'running(5)'],
      ['b', 'exited(1), running(10)'],
      ['c', 'exited(5)'],
    ]);
    const rows = list({ root: r, env: { XDG_DATA_HOME: base }, statuses });
    expect(rows.map((x: { name: string; state: string }) => [x.name, x.state])).toEqual([
      ['a', 'up'],
      ['b', 'up'],
      ['c', 'down'],
      ['d', 'down'],
    ]);
    expect(rows[3].file).toBe('/no/such/snowglobe.yml (gone)');
    expect(stateWord(undefined)).toBe('down');
  });
});

describe('up and down by file or name', () => {
  const rendered = () => {
    const r = box();
    mkdirSync(join(r, 'proj'));
    cpSync(FOUR, join(r, 'proj/snowglobe.yml'));
    expect(sg(r, join(r, 'proj'), ['render']).status).toBe(0);
    return r;
  };

  it('takes a snowglobe by name from any folder', () => {
    const r = rendered();
    mkdirSync(join(r, 'elsewhere'));
    const res = sg(r, join(r, 'elsewhere'), ['down', 'four']);
    expect(res.stderr).not.toContain('no snowglobe.yml');
    expect(dockerLog(r)).toMatch(/compose -p four .* down --remove-orphans/);
  });

  it('takes a file by -f, or by its path, from any folder', () => {
    const r = rendered();
    mkdirSync(join(r, 'elsewhere'));
    for (const args of [['-f', join(r, 'proj/snowglobe.yml')], [join(r, 'proj/snowglobe.yml')]]) {
      const res = sg(r, join(r, 'elsewhere'), ['down', ...args]);
      expect(res.stderr, args.join(' ')).not.toContain('no snowglobe.yml');
    }
    expect(dockerLog(r).match(/-p four .* down /g)).toHaveLength(2);
  });

  it('stops a snowglobe by name even when its file is gone', () => {
    const r = rendered();
    spawnSync('rm', ['-r', join(r, 'proj')]);
    sg(r, r, ['down', '-v', 'four']);
    expect(dockerLog(r)).toMatch(/-p four .* down --remove-orphans -v/);
  });

  it('refuses up by name, before docker, when its file now says another globe: name', () => {
    const r = rendered();
    const file = join(r, 'proj/snowglobe.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^globe: four$/m, 'globe: renamed'));
    const before = dockerLog(r);
    const res = sg(r, r, ['up', 'four']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('says globe: renamed now, not four');
    expect(res.stderr).toContain('globe: four back');
    expect(dockerLog(r)).toBe(before);
    expect(existsSync(join(r, '.local/share/snowglobe/renamed'))).toBe(false);
  });

  it('down -v drops the fixed secrets only when compose succeeded; a plain down keeps them', () => {
    const r = rendered();
    const secrets = join(r, '.local/share/snowglobe/four/secrets.env');
    const fixed = 'SG_DB_PASSWORD=postgres\nSG_PDS_ADMIN_PASSWORD=keepme\n';
    for (const [args, env, kept] of [
      [['down', 'four'], { SHIM_EXIT: '0' }, true],
      [['down', '-v', 'four'], {}, true],
      [['down', '-v', 'four'], { SHIM_EXIT: '0' }, false],
    ] as [string[], Record<string, string>, boolean][]) {
      writeFileSync(secrets, fixed);
      sg(r, r, args, env);
      const now = readFileSync(secrets, 'utf8');
      expect(now.includes('SG_DB_PASSWORD=postgres'), `${args.join(' ')} ${JSON.stringify(env)}`).toBe(kept);
      expect(now).toContain('SG_PDS_ADMIN_PASSWORD=keepme');
    }
  });

  it('refuses up by name when its file is gone, and says how to give one', () => {
    const r = rendered();
    spawnSync('rm', ['-r', join(r, 'proj')]);
    const before = dockerLog(r);
    const res = sg(r, r, ['up', 'four']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('is gone');
    expect(res.stderr).toContain('up -f <file>');
    expect(dockerLog(r)).toBe(before);
  });

  it('refuses a name nobody has, and a file and a name together, before docker', () => {
    const r = rendered();
    const res = sg(r, r, ['down', 'nothing']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('snowglobe ls');
    const both = sg(r, r, ['down', 'four', '-f', join(r, 'proj/snowglobe.yml')]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('not both');
    expect(dockerLog(r)).toBe('');
  });

  it('refuses --default with a file or -f', () => {
    const r = rendered();
    expect(sg(r, r, ['up', '--default', '-f', FOUR]).status).toBe(2);
    expect(sg(r, r, ['up', '--default', FOUR]).status).toBe(2);
  });
});

describe('pointedAt', () => {
  it('is a file that exists before a name, a name when a state folder has it, else an error', () => {
    const base = mkdtempSync(join(tmpdir(), 'snowglobe-point-'));
    mkdirSync(join(base, 'snowglobe/mine'), { recursive: true });
    const env = { XDG_DATA_HOME: base };
    expect(pointedAt({ env })).toEqual({});
    expect(pointedAt({ file: 'x.yml', env })).toEqual({ file: 'x.yml' });
    expect(pointedAt({ word: FOUR, env })).toEqual({ file: FOUR });
    expect(pointedAt({ word: 'mine', env })).toEqual({ name: 'mine' });
    expect(() => pointedAt({ word: 'other', env })).toThrow(/snowglobe ls/);
    expect(() => pointedAt({ word: '../mine', env })).toThrow(/is not a file/);
  });
});

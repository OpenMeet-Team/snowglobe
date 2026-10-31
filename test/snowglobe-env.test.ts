// The shared core of the snowglobe subcommands (lib/env.mjs): reading settings as
// compose reads .env, the refusals, and the env files that hold logins. No Docker needed; run
// them alone with `npx vitest run snowglobe-env`.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { adoptOldNames, chooseBind, envCompose, envGet, envPut, makePrivate, resolveBind, resolveDomain } from '../lib/env.mjs';

// A snowglobe's state folder is not in the checkout.
const state = (r: string) => join(r, 'state', 'g');
const rd = (o: { root: string; env: Record<string, string>; rendering?: boolean }) => resolveDomain({ ...o, state: state(o.root) });

function root(dotenv?: string, globeDomain?: string) {
  const r = mkdtempSync(join(tmpdir(), 'snowglobe-env-'));
  if (dotenv !== undefined) writeFileSync(join(r, '.env'), dotenv);
  if (globeDomain !== undefined) {
    mkdirSync(join(state(r), 'globe'), { recursive: true });
    writeFileSync(join(state(r), 'globe/globe.env'), `# rendered\nSG_DOMAIN=${globeDomain}\n`);
  }
  return r;
}

describe('envCompose', () => {
  const file = (text: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'snowglobe-env-')), '.env');
    writeFileSync(f, text);
    return f;
  };

  it('reads a value as compose does', () => {
    expect(envCompose('D', file('D=a.test\n'))).toBe('a.test');
    expect(envCompose('D', file('export D=a.test\n'))).toBe('a.test');
    expect(envCompose('D', file('  D = a.test  \n'))).toBe('a.test');
    expect(envCompose('D', file('D="a.test" # note\n'))).toBe('a.test');
    expect(envCompose('D', file("D='a b'\n"))).toBe('a b');
    expect(envCompose('D', file('D=a.test # note\n'))).toBe('a.test');
    expect(envCompose('D', file('D=a.test\r\nE=x\r\n'))).toBe('a.test');
  });

  it('takes the last value, and tells unset from empty', () => {
    expect(envCompose('D', file('D=a.test\nD=b.test\n'))).toBe('b.test');
    expect(envCompose('D', file('D=\n'))).toBe('');
    expect(envCompose('D', file('DD=a.test\n'))).toBeUndefined();
    expect(envCompose('D', join(tmpdir(), 'no-such-file.env'))).toBeUndefined();
  });

  it('envGet reads only NAME=value lines the scripts write', () => {
    const f = file('A=1\n A=2\nA=3\nAB=4\n');
    expect(envGet('A', f)).toBe('3');
    expect(envGet('B', f)).toBe('');
  });

  it('envGet finds an SG_ name a file written before 2026-10-20 has under its old name', () => {
    const f = file('DEVNET_DOMAIN=old.lan\nSNOWGLOBE_PDS=alpha beta\n');
    expect(envGet('SG_DOMAIN', f)).toBe('old.lan');
    expect(envGet('SG_PDS', f)).toBe('alpha beta');
    expect(envGet('SG_DOMAIN', file('DEVNET_DOMAIN=old.lan\nSG_DOMAIN=new.lan\n'))).toBe('new.lan');
    expect(envGet('DOMAIN', f)).toBe('');
  });
});

describe('adoptOldNames', () => {
  const run = (env: Record<string, string>, dotenv?: string) => {
    const warnings: string[] = [];
    const taken = adoptOldNames({ root: root(dotenv), env, warn: (m: string) => warnings.push(m) });
    return { env, taken, warnings };
  };

  it('copies DEVNET_ and SNOWGLOBE_ settings to their SG_ names, with one warning', () => {
    const { env, taken, warnings } = run({ DEVNET_BIND: '127.0.0.2', SNOWGLOBE_FILE: 'x.yml', DEVNET_PUBLIC: '' });
    expect(env).toMatchObject({ SG_BIND: '127.0.0.2', SG_FILE: 'x.yml', SG_PUBLIC: '' });
    expect(taken.sort()).toEqual(['DEVNET_BIND', 'DEVNET_PUBLIC', 'SNOWGLOBE_FILE']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('DEVNET_BIND is now SG_BIND');
  });

  it('leaves an SG_ setting alone, from the environment or .env', () => {
    const { env, taken, warnings } = run({ SG_BIND: '127.0.0.5', DEVNET_BIND: '127.0.0.2' }, 'SG_DOMAIN=new.lan\nDEVNET_DOMAIN=old.lan\n');
    expect(env.SG_BIND).toBe('127.0.0.5');
    expect(env.SG_DOMAIN).toBeUndefined();
    expect(taken).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('takes an old name from .env, after the environment\'s', () => {
    const { env, taken } = run({ DEVNET_DOMAIN: 'env.lan' }, 'export DEVNET_DOMAIN="dot.lan"\nDEVNET_PROJECT=p # note\n');
    expect(env.SG_DOMAIN).toBe('env.lan');
    expect(env.SG_PROJECT).toBe('p');
    expect(taken).toContain('DEVNET_PROJECT (in .env)');
  });

  it('says nothing when there is nothing old', () => {
    expect(run({ SG_BIND: '127.0.0.1', HOME: '/h' }, 'SG_DOMAIN=a.lan\n').warnings).toEqual([]);
  });
});

describe('resolveDomain', () => {
  it('takes the environment, then .env, then the rendered globe, then the globe\'s own domain', () => {
    expect(rd({ root: root('SG_DOMAIN=env.test\n'), env: { SG_DOMAIN: 'x.test' }, rendering: true }).domain).toBe('x.test');
    expect(rd({ root: root('SG_DOMAIN=env.test\n'), env: {} }).domain).toBe('env.test');
    expect(rd({ root: root(undefined, 'globe.test'), env: {} }).domain).toBe('globe.test');
    // Named for its state folder, g.
    expect(rd({ root: root(), env: {} }).domain).toBe('g.local.snowglobe.at');
  });

  it('lets an empty setting in the environment win over .env, and fall through to the globe', () => {
    const r = root('SG_DOMAIN=env.test\n', 'globe.test');
    expect(rd({ root: r, env: { SG_DOMAIN: '' } })).toEqual({ domain: 'globe.test', set: '' });
  });

  it('refuses a stale render, unless this run renders again', () => {
    const r = root(undefined, 'globe.test');
    expect(() => rd({ root: r, env: { SG_DOMAIN: 'other.test' } })).toThrow(/rendered for globe\.test/);
    expect(rd({ root: r, env: { SG_DOMAIN: 'other.test' }, rendering: true }).domain).toBe('other.test');
  });

  it('refuses what is not a domain name', () => {
    for (const d of ['a b.test', '.a.test', 'a.test.', 'a..test', '${X}.test'])
      expect(() => rd({ root: root(), env: { SG_DOMAIN: d } }), d).toThrow(/not a domain name/);
  });
});

describe('resolveBind', () => {
  it('takes a loopback address from the environment or .env, 127.0.0.1 by default', () => {
    expect(resolveBind({ root: root(), env: {} })).toBe('127.0.0.1');
    expect(resolveBind({ root: root('SG_BIND=127.0.0.2\n'), env: {} })).toBe('127.0.0.2');
    expect(resolveBind({ root: root('SG_BIND=127.0.0.2\n'), env: { SG_BIND: '127.0.0.3' } })).toBe('127.0.0.3');
  });

  it('refuses anything that is not 127.x.y.z', () => {
    for (const b of ['0.0.0.0', '192.168.1.2', '127.0.0', '127.0.0.256', '127.0.0.x', 'localhost'])
      expect(() => resolveBind({ root: root(), env: { SG_BIND: b } }), b).toThrow(/not a loopback/);
  });
});

describe('env files with logins', () => {
  it('envPut replaces the matching lines and keeps the file at mode 600', () => {
    const f = join(root(), 'accounts.env');
    writeFileSync(f, 'A_DID=1\nB_DID=2\nA_PASSWORD=x\n', { mode: 0o644 });
    envPut(f, /^A_(DID|PASSWORD)=/, ['A_DID=3', 'A_PASSWORD=y']);
    expect(readFileSync(f, 'utf8')).toBe('B_DID=2\nA_DID=3\nA_PASSWORD=y\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('envPut makes a missing file', () => {
    const f = join(root(), 'new.env');
    envPut(f, /^V=/, ['V=1']);
    expect(readFileSync(f, 'utf8')).toBe('V=1\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('makePrivate makes a file mode 600 and leaves a missing one alone', () => {
    const r = root();
    const f = join(r, 'accounts.json');
    writeFileSync(f, '{}\n', { mode: 0o644 });
    makePrivate(f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, 'utf8')).toBe('{}\n');
    expect(() => makePrivate(join(r, 'missing'))).not.toThrow();
  });
});

describe('chooseBind', () => {
  // A user's snowglobes sit side by side: <top>/<name>/, each with its own bind file.
  const top = () => mkdtempSync(join(tmpdir(), 'snowglobe-bind-'));
  const globe = (t: string, name: string, bind?: string) => {
    const d = join(t, name);
    mkdirSync(d, { recursive: true });
    if (bind) writeFileSync(join(d, 'bind'), `${bind}\n`);
    return d;
  };
  const none = async () => false;
  // On Linux, where the name router runs and holds 127.0.0.1, unless a case says otherwise.
  const mine = (t: string, name: string, extra = {}) => ({ root: root(), state: globe(t, name), project: name, env: {}, listening: none, ownUp: () => false, platform: 'linux', ...extra });

  it('gives a first snowglobe 127.0.0.2 where the name router runs, and keeps it', async () => {
    const t = top();
    const o = mine(t, 'one');
    expect(await chooseBind(o)).toBe('127.0.0.2');
    expect(readFileSync(join(o.state, 'bind'), 'utf8')).toBe('127.0.0.2\n');
    expect(resolveBind({ root: o.root, state: o.state, env: {} })).toBe('127.0.0.2');
  });

  it('gives a first snowglobe 127.0.0.1 where no router runs: not on Linux, or SG_ROUTER=off', async () => {
    const t = top();
    expect(await chooseBind(mine(t, 'mac', { platform: 'darwin' }))).toBe('127.0.0.1');
    const off = top();
    expect(await chooseBind(mine(off, 'off', { env: { SG_ROUTER: 'off' } }))).toBe('127.0.0.1');
  });

  it('moves a snowglobe that kept 127.0.0.1 off the router\'s address when it is down, and leaves a running one there', async () => {
    const t = top();
    const old = mine(t, 'old');
    writeFileSync(join(old.state, 'bind'), '127.0.0.1\n');
    expect(await chooseBind({ ...old, ownUp: () => true })).toBe('127.0.0.1');
    expect(await chooseBind(old)).toBe('127.0.0.2');
    expect(readFileSync(join(old.state, 'bind'), 'utf8')).toBe('127.0.0.2\n');
    // Without the router there is nothing to move off.
    const mac = mine(t, 'mac', { platform: 'darwin' });
    writeFileSync(join(mac.state, 'bind'), '127.0.0.1\n');
    expect(await chooseBind(mac)).toBe('127.0.0.1');
  });

  it('gives a second snowglobe the next address no other one has kept', async () => {
    const t = top();
    globe(t, 'one', '127.0.0.1');
    globe(t, 'three', '127.0.0.2');
    expect(await chooseBind(mine(t, 'two'))).toBe('127.0.0.3');
  });

  it('skips an address something answers on, even one no snowglobe kept', async () => {
    const t = top();
    expect(await chooseBind(mine(t, 'two', { listening: async (a: string) => a === '127.0.0.1' }))).toBe('127.0.0.2');
  });

  it('keeps a running snowglobe from before on 127.0.0.1, though something answers there: it is itself', async () => {
    const t = top();
    expect(await chooseBind(mine(t, 'old', { listening: async () => true, ownUp: () => true }))).toBe('127.0.0.1');
  });

  it('leaves a kept address alone, and writes nothing when SG_BIND is set', async () => {
    const t = top();
    const kept = mine(t, 'kept');
    writeFileSync(join(kept.state, 'bind'), '127.0.0.7\n');
    expect(await chooseBind(kept)).toBe('127.0.0.7');
    const set = mine(t, 'set', { env: { SG_BIND: '127.0.0.9' } });
    expect(await chooseBind(set)).toBe('127.0.0.9');
    expect(() => readFileSync(join(set.state, 'bind'))).toThrow();
  });

  it('gives two first starts at once different addresses', async () => {
    const t = top();
    const slow = async () => (await new Promise((r) => setTimeout(r, 20)), false);
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((n) => chooseBind(mine(t, n, { listening: slow }))));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(existsSync(join(t, '.bind-lock'))).toBe(false);
  });

  it('stops at a lock left by a process that died, and leaves it: two starts taking it over at once could both hold it', async () => {
    const t = top();
    const lock = join(t, '.bind-lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 120000);
    utimesSync(lock, old, old);
    const one = mine(t, 'one');
    await expect(chooseBind(one)).rejects.toThrow();
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(one.state, 'bind'))).toBe(false);
  });

  it('says so when no address up to 127.0.0.50 is free', async () => {
    await expect(chooseBind(mine(top(), 'x', { listening: async () => true }))).rejects.toThrow(/SG_BIND/);
  });
});

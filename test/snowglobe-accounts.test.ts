// snowglobe account, invite and lexicons (lib/commands/), run as an app runs
// them, against a fake globe: one https server on a loopback address of its own, port 443, that
// answers as each PDS by its Host. No Docker needed; run them alone with
// `npx vitest run snowglobe-accounts`. PATH holds node alone, so nothing here needs jq, openssl or
// curl. Skipped where port 443 cannot be bound without root.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { ensureCerts } from '../lib/certs.mjs';

const ROOT = join(__dirname, '..');
const D = 'acct.test';
const BIND = '127.77.0.1';
const PDS = ['alpha', 'beta', 'regular'];

// Linux says which ports a user may bind. macOS has no such file, and a user cannot listen on 443 there
// (EACCES even on 127.0.0.1), so these tests are skipped.
const canBind443 = (() => {
  try {
    return Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8').trim() || 1024) <= 443;
  } catch {
    return false;
  }
})();

type Req = { pds: string; nsid: string; auth?: string; body: any; query: URLSearchParams };

// A PDS per name, as far as these commands use one.
function fakeGlobe() {
  const seen: Req[] = [];
  const accounts = new Map<string, { did: string; password: string; pds: string }>();
  const invites = new Map<string, { pds: string; left: number }>();
  const records = new Map<string, unknown>();
  let n = 0;
  const handle = (r: Req): [number, unknown] => {
    const required = r.pds === 'alpha' || r.pds === 'beta';
    switch (r.nsid) {
      case 'com.atproto.server.createInviteCode': {
        if (r.auth !== `Basic ${Buffer.from('admin:test-admin-password').toString('base64')}`) return [401, { error: 'AuthRequired' }];
        const code = `${r.pds}-code-${++n}`;
        invites.set(code, { pds: r.pds, left: r.body.useCount });
        return [200, { code }];
      }
      case 'com.atproto.server.createAccount': {
        if (required) {
          const inv = invites.get(r.body.inviteCode);
          if (!inv || inv.pds !== r.pds || inv.left < 1) return [400, { error: 'InvalidInviteCode', message: 'bad code' }];
          inv.left--;
        }
        if (accounts.has(r.body.handle)) return [400, { error: 'HandleNotAvailable' }];
        const did = `did:plc:fake${++n}`;
        accounts.set(r.body.handle, { did, password: r.body.password, pds: r.pds });
        return [200, { did, handle: r.body.handle, accessJwt: 'jwt-create' }];
      }
      case 'com.atproto.server.createSession': {
        const a = [...accounts.entries()].find(([h, v]) => h === r.body.identifier || v.did === r.body.identifier);
        if (!a || a[1].password !== r.body.password || a[1].pds !== r.pds) return [401, { error: 'AuthenticationRequired' }];
        return [200, { did: a[1].did, handle: a[0], accessJwt: `jwt-secret-${a[1].did}` }];
      }
      case 'com.atproto.repo.getRecord': {
        const v = records.get(`${r.query.get('repo')}/${r.query.get('collection')}/${r.query.get('rkey')}`);
        return v ? [200, { uri: 'at://x', value: v }] : [400, { error: 'RecordNotFound' }];
      }
      case 'com.atproto.repo.putRecord': {
        if (!r.auth?.startsWith('Bearer jwt-secret-')) return [401, { error: 'AuthRequired' }];
        records.set(`${r.body.repo}/${r.body.collection}/${r.body.rkey}`, r.body.record);
        return [200, { uri: `at://${r.body.repo}/${r.body.collection}/${r.body.rkey}` }];
      }
    }
    return [404, { error: 'MethodNotImplemented' }];
  };
  return { seen, accounts, invites, records, handle };
}

let root: string;
// Where the snowglobe `g` keeps its files for the user whose HOME is root.
const STATE = () => join(root, '.local/share/snowglobe/g');
let server: Server;
let globe: ReturnType<typeof fakeGlobe>;
let bin: string;

beforeAll(async () => {
  if (!canBind443) return;
  root = mkdtempSync(join(tmpdir(), 'snowglobe-accounts-'));
  for (const d of ['bin', 'lib']) cpSync(join(ROOT, d), join(root, d), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type": "module"}\n');
  // The user's state is under HOME: ~/.local/share/snowglobe/g, and the CA beside it.
  writeFileSync(join(root, 'snowglobe.yml'), 'globe: g\n');
  mkdirSync(join(STATE(), 'globe'), { recursive: true });
  writeFileSync(
    join(STATE(), 'globe/globe.env'),
    [
      `SG_DOMAIN=${D}`,
      `SG_PDS=${PDS.join(' ')}`,
      'SG_SEED_PDS=alpha',
      'SG_BARE_PDS=alpha',
      'SG_INVITE_PDS=alpha beta',
      'SG_AUTHORITY_PDS=alpha',
      `SG_TAKEN=plc relay lex-authority ${PDS.join(' ')}`,
      '',
    ].join('\n'),
  );
  await ensureCerts({ dir: join(STATE(), 'https'), caDir: join(STATE(), '../ca'), domain: D, names: [D, `*.${D}`] });
  globe = fakeGlobe();
  server = createServer(
    { key: readFileSync(join(STATE(), 'https/leaf.key')), cert: readFileSync(join(STATE(), 'https/leaf.crt')) },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url!, 'https://x');
        const r: Req = {
          pds: req.headers.host!.split('.')[0],
          nsid: url.pathname.replace('/xrpc/', ''),
          auth: req.headers.authorization,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
          query: url.searchParams,
        };
        globe.seen.push(r);
        const [status, json] = globe.handle(r);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      });
    },
  );
  await new Promise<void>((done) => server.listen(443, BIND, done));
  // PATH with node and nothing else.
  bin = mkdtempSync(join(tmpdir(), 'snowglobe-bin-'));
  symlinkSync(process.execPath, join(bin, 'node'));
});
afterAll(() => server?.close());

// The CLI, as an app runs it; spawned, not spawnSync, so the fake globe in this process answers.
function sg(args: string[], env: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(join(bin, 'node'), [join(root, 'bin/snowglobe.mjs'), ...args], {
      cwd: root,
      env: { PATH: bin, HOME: root, SG_BIND: BIND, SG_PDS_ADMIN_PASSWORD: 'test-admin-password', ...env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}
const accountsFile = () => join(STATE(), 'accounts.env');
const envOf = (f: string) => Object.fromEntries(readFileSync(f, 'utf8').trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

describe.skipIf(!canBind443)('snowglobe account', () => {
  it('creates an account with bare handles, sending a single-use invite; prints the DID alone, and no secret', async () => {
    const r = await sg(['account', 'owner', 'APP_OWNER']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^did:plc:fake\d+\n$/);
    expect(r.stderr).toContain(`Created owner.${D} on https://alpha.${D}`);
    const env = envOf(accountsFile());
    expect(env).toMatchObject({ APP_OWNER_HANDLE: `owner.${D}`, APP_OWNER_DID: r.stdout.trim(), APP_OWNER_PDS: `https://alpha.${D}` });
    expect(env.APP_OWNER_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
    expect(r.stdout + r.stderr).not.toContain(env.APP_OWNER_PASSWORD);
    expect(statSync(accountsFile()).mode & 0o777).toBe(0o600);
    // Nothing keeps a list of handles: the name router reaches every one by its domain.
    expect(existsSync(join(STATE(), 'https/names'))).toBe(false);
    const minted = globe.seen.filter((q) => q.nsid === 'com.atproto.server.createInviteCode');
    expect(minted.map((q) => [q.pds, q.body.useCount])).toEqual([['alpha', 1]]);
  });

  it('finds the account on a rerun, and prints the same DID', async () => {
    const before = envOf(accountsFile()).APP_OWNER_DID;
    const r = await sg(['account', 'owner', 'APP_OWNER']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(before);
    expect(r.stderr).toContain('Found');
  });

  it('makes <name>.<pds>.<domain> on another PDS, with an invite only where invites are required', async () => {
    const from = globe.seen.length;
    const open = await sg(['account', 'reader', 'APP_READER', 'regular']);
    expect(open.status, open.stderr).toBe(0);
    expect(envOf(accountsFile()).APP_READER_HANDLE).toBe(`reader.regular.${D}`);
    const sent = globe.seen.slice(from);
    expect(sent.map((q) => q.nsid)).toEqual(['com.atproto.server.createAccount']);
    expect(sent[0].body).not.toHaveProperty('inviteCode');
    expect(sent[0].auth).toBeUndefined();

    const closed = await sg(['account', 'member', 'APP_MEMBER', 'beta']);
    expect(closed.status, closed.stderr).toBe(0);
    expect(globe.accounts.get(`member.beta.${D}`)?.pds).toBe('beta');
  });

  it('takes SG_INVITE_CODE when it is set', async () => {
    expect((await sg(['invite', 'SPARE', join(root, 'spare.env'), '--pds', 'alpha'])).status).toBe(0);
    const code = envOf(join(root, 'spare.env')).SPARE;
    const r = await sg(['account', 'given', 'APP_GIVEN'], { SG_INVITE_CODE: code });
    expect(r.status, r.stderr).toBe(0);
    expect(globe.seen.at(-1)!.body.inviteCode).toBe(code);
  });

  it('refuses a bare handle that is a globe name, a name that is not a label, and a PDS not in the globe', async () => {
    for (const args of [
      ['plc', 'X'],
      ['beta', 'X'],
      ['lex-authority', 'X'],
      ['Owner', 'X'],
      ['ok', 'lower'],
      ['ok', 'X', 'gamma'],
    ]) {
      const r = await sg(['account', ...args]);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stdout).toBe('');
    }
    // On a PDS without bare handles the same name is only a handle's first label.
    expect((await sg(['account', 'plc', 'APP_PLC', 'regular'])).status).toBe(0);
  });

  it('lets snowglobe up make the lexicon authority under its own prefix', async () => {
    const r = await sg(['account', 'lex-authority', 'LEX_AUTHORITY']);
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(accountsFile()).LEX_AUTHORITY_HANDLE).toBe(`lex-authority.${D}`);
  });

  it('says why a PDS refused, and saves nothing', async () => {
    const r = await sg(['account', 'nope', 'APP_NOPE'], { SG_INVITE_CODE: 'not-a-code' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('InvalidInviteCode');
    expect(envOf(accountsFile())).not.toHaveProperty('APP_NOPE_DID');
  });
});

describe.skipIf(!canBind443)('snowglobe invite', () => {
  it('asks which PDS when more than one takes invite codes', async () => {
    const r = await sg(['invite', 'V']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--pds');
  });

  it('writes <VAR>=<code> to the file, mode 600, and never prints the code', async () => {
    const f = join(root, 'app/.env');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, 'KEEP=1\nV=old\n');
    const r = await sg(['invite', 'V', f, '--pds', 'beta'], { INVITE_USES: '5' });
    expect(r.status, r.stderr).toBe(0);
    const env = envOf(f);
    expect(env.KEEP).toBe('1');
    expect(globe.invites.get(env.V)).toEqual({ pds: 'beta', left: 5 });
    expect(r.stdout + r.stderr).not.toContain(env.V);
    expect(r.stdout).toBe('');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('refuses a PDS whose invites are open, and sends it nothing', async () => {
    const from = globe.seen.length;
    const r = await sg(['invite', 'V', '--pds', 'regular']);
    expect(r.status).toBe(2);
    expect(globe.seen.length).toBe(from);
  });

  it('refuses a bad INVITE_USES or variable name', async () => {
    expect((await sg(['invite', 'V', '--pds', 'beta'], { INVITE_USES: '0' })).status).toBe(2);
    expect((await sg(['invite', 'v', '--pds', 'beta'])).status).toBe(2);
  });
});

describe.skipIf(!canBind443)('snowglobe lexicons', () => {
  const lex = (id: string) => ({ lexicon: 1, id, defs: { main: { type: 'record', key: 'tid', record: { type: 'object', properties: {} } } } });
  let dir: string;

  beforeAll(() => {
    if (!canBind443) return;
    dir = mkdtempSync(join(tmpdir(), 'snowglobe-lex-'));
    mkdirSync(join(dir, 'com/example'), { recursive: true });
    writeFileSync(join(dir, 'com/example/one.json'), JSON.stringify(lex('com.example.one')));
    writeFileSync(join(dir, 'two.json'), JSON.stringify(lex('com.example.two'), null, 2));
    writeFileSync(join(dir, 'package.json'), '{"name": "not-a-lexicon"}');
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    writeFileSync(join(dir, 'README.md'), '# lexicons');
  });

  it('publishes each lexicon, prints its NSID, and skips other JSON', async () => {
    const r = await sg(['lexicons', dir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('com.example.one\ncom.example.two\n');
    expect(r.stderr).toContain('2 published, 0 unchanged, 2 skipped');
    const did = envOf(accountsFile()).LEX_AUTHORITY_DID;
    expect([...globe.records.keys()].filter((k) => k.startsWith(`${did}/com.atproto.lexicon.schema/`)).sort()).toEqual([
      `${did}/com.atproto.lexicon.schema/com.example.one`,
      `${did}/com.atproto.lexicon.schema/com.example.two`,
    ]);
    expect(globe.records.get(`${did}/com.atproto.lexicon.schema/com.example.one`)).toMatchObject({ $type: 'com.atproto.lexicon.schema', id: 'com.example.one' });
    expect(r.stdout + r.stderr).not.toContain('jwt-secret');
  });

  it('leaves an unchanged record alone, and republishes a changed one', async () => {
    const again = await sg(['lexicons', dir]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toContain('0 published, 2 unchanged');
    expect(again.stdout).toBe('com.example.one\ncom.example.two\n');
    const changed = lex('com.example.two');
    changed.defs.main.key = 'any';
    writeFileSync(join(dir, 'two.json'), JSON.stringify(changed));
    const third = await sg(['lexicons', dir]);
    expect(third.stderr).toContain('1 published, 1 unchanged');
  });

  it('needs the authority login', async () => {
    const r = await sg(['lexicons', dir], { ACCOUNTS_FILE: join(root, 'empty.env') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('LEX_AUTHORITY');
  });
});

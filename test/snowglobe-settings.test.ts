// An app's settings (apps[].env in snowglobe.yml): the names, their checks, and snowglobe env. No
// Docker needed. Run them alone with `npx vitest run snowglobe-settings`.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs module, without types
import { checkGlobe, loadGlobe } from '../lib/config.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { lookup, parseValue } from '../lib/settings.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { formatEnv } from '../lib/commands/env.mjs';

const ROOT = join(__dirname, '..');
const FIXTURE = join(__dirname, 'snowglobe/settings.yml');

const PDS_A = { name: 'alpha', image: 'spaces-alpha', bare_handles: true };
const PDS_B = { name: 'regular', image: 'ghcr.io/bluesky-social/pds:0.4.5037' };
const withEnv = (env: object, extra: object = {}) => ({ globe: 'mine', pds: [PDS_A, PDS_B], apps: [{ name: 'web', env }], ...extra });
const errorsOf = (env: object, extra: object = {}) => checkGlobe(withEnv(env, extra)).errors;

describe('the value names', () => {
  const { globe, errors } = loadGlobe(FIXTURE);

  // After-up values come from a stand-in, so what is checked is that they are asked for.
  const later = (name: string) => `<${name}>`;
  const env = Object.fromEntries(
    Object.entries(globe?.apps[0].env ?? {}).map(([k, v]) => [k, parseValue(v as string).parts.map((p: { text?: string; name?: string }) => p.text ?? lookup(globe, p.name, later).value).join('')]),
  );

  it('loads the file that uses every name', () => {
    expect(errors).toEqual([]);
  });

  it('gives every name in the design\'s table the value the table gives', () => {
    expect(env).toEqual({
      N_DOMAIN: 'sg.test',
      N_GLOBE: 'setg',
      N_PAGE: 'https://sg.test/',
      PDS_URL: 'https://regular.sg.test',
      PDS_HOST: 'regular.sg.test',
      PDS_DID: 'did:web:regular.sg.test',
      GH_URL: 'https://gh.sg.test',
      GH_HOST: 'gh.sg.test',
      GH_DID: 'did:web:gh.sg.test',
      APP_URL: 'https://web.app.sg.test',
      APP_HOST: 'web.app.sg.test',
      PLC: 'https://plc.sg.test',
      RELAY_URL: 'https://relay.sg.test',
      RELAY_WS: 'wss://relay.sg.test',
      JET_URL: 'https://jetstream.sg.test',
      JET_WS: 'wss://jetstream.sg.test/subscribe',
      SLING: 'https://slingshot.sg.test',
      PDSLS: 'https://pdsls.sg.test',
      MAIL: '<services.mail.url>',
      ALICE_HANDLE: 'alice.sg.test',
      ALICE_PDS: 'https://alpha.sg.test',
      ALICE_DID: '<accounts.alice.did>',
      ALICE_PASSWORD: '<accounts.alice.password>',
      BOB_HANDLE: 'bob.regular.sg.test',
      BOB_PDS: 'https://regular.sg.test',
      ACCOUNTS_FILE: '<accounts.file>',
      AUTH_DID: '<lexicons.authority.did>',
      AUTH_HANDLE: 'lex-authority.sg.test',
      CA: '<ca.file>',
      MIXED: 'https://alpha.sg.test/x?q=${not}&w=$5',
    });
  });

  it('gives the default file\'s names the values the table gives on it', () => {
    const { globe: d } = loadGlobe(join(ROOT, 'docs/examples/atmo.yml'));
    const v = (n: string) => lookup(d, n).value;
    expect([v('pds.alpha.url'), v('pds.alpha.did'), v('accounts.alice.handle'), v('accounts.alice.pds'), v('services.relay.ws'), v('lexicons.authority.handle')]).toEqual([
      'https://alpha.local.snowglobe.at',
      'did:web:alpha.local.snowglobe.at',
      'alice.local.snowglobe.at',
      'https://alpha.local.snowglobe.at',
      'wss://relay.local.snowglobe.at',
      'lex-authority.local.snowglobe.at',
    ]);
  });

  it('says what is missing when an after-up value has no state yet', () => {
    expect(lookup(globe, 'accounts.alice.did', () => undefined).error).toContain('snowglobe up');
  });
});

describe('the names are checked with the file', () => {
  it('names the PDSs when one is not in the file, at the setting', () => {
    expect(errorsOf({ PDS: '${pds.nope.url}' })).toEqual(['apps[0].env.PDS: pds.nope is not a PDS in this file: alpha, regular']);
    expect(errorsOf({ G: '${grouphosts.x.url}' })[0]).toContain('grouphosts.x is not a group host in this file: none');
    expect(errorsOf({ A: '${apps.x.url}' })[0]).toContain('apps.x is not an app in this file: web');
    expect(errorsOf({ A: '${accounts.x.handle}' })[0]).toContain('accounts.x is not an account in this file: none');
  });

  it('says a service the file turns off is off', () => {
    expect(errorsOf({ R: '${services.relay.url}' }, { pds: [PDS_A], services: { relay: false, jetstream: false, slingshot: false } })).toEqual([
      'apps[0].env.R: services.relay is off in this file, so it has no address',
    ]);
    expect(errorsOf({ R: '${services.jetstream.ws}' }, { services: { jetstream: false, slingshot: false } })[0]).toContain('services.jetstream is off');
    expect(errorsOf({ R: '${services.tap.url}' })[0]).toContain('services.tap is off');
    expect(errorsOf({ R: '${services.tap.url}' }, { services: { tap: true } })).toEqual([]);
  });

  it('teaches the pattern on a wrong field or section', () => {
    expect(errorsOf({ P: '${pds.alpha.port}' })[0]).toContain('pds.alpha.url, pds.alpha.host, pds.alpha.did');
    expect(errorsOf({ P: '${nonsense.x}' })[0]).toContain('Sections: domain, globe');
  });

  it('refuses a setting that is not a name, not a string, or has a broken placeholder', () => {
    expect(checkGlobe(withEnv({ 'A-B': 'x' })).errors[0]).toMatch(/^apps\[0\]\.env\.A-B: /);
    expect(checkGlobe(withEnv({ A: ['x'] })).errors[0]).toMatch(/^apps\[0\]\.env\.A: /);
    expect(checkGlobe(withEnv({ A: 'a ${pds.alpha.url' })).errors[0]).toMatch(/^apps\[0\]\.env\.A: .*closing/);
    expect(checkGlobe({ globe: 'mine', pds: [PDS_A], apps: [{ name: 'web', env: ['x'] }] }).errors[0]).toMatch(/^apps\[0\]\.env: /);
  });

  it('takes a number or a boolean as the text it is, and a $ that starts no placeholder as written', () => {
    const { globe, errors } = checkGlobe(withEnv({ SEALED: true, PORT: 8080, PRICE: 'costs $5' }));
    expect(errors).toEqual([]);
    expect(globe.apps[0].env).toEqual({ SEALED: 'true', PORT: '8080', PRICE: 'costs $5' });
  });

  it('refuses two accounts of one name, on any PDS', () => {
    const errs = checkGlobe({ globe: 'mine', pds: [PDS_A, PDS_B], accounts: ['alice@alpha', 'alice@regular'] }).errors;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^accounts\[1\]: "alice" is already alice@alpha \(accounts\[0\]\)/);
  });
});

// snowglobe env, from a folder holding a snowglobe.yml, with a state folder of its own.
function folder(yml: string, accountsEnv?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'snowglobe-settings-'));
  writeFileSync(join(dir, 'snowglobe.yml'), yml);
  const data = join(dir, 'data');
  if (accountsEnv !== undefined) {
    mkdirSync(join(data, 'snowglobe/setg'), { recursive: true });
    writeFileSync(join(data, 'snowglobe/setg/accounts.env'), accountsEnv);
  }
  return { dir, data };
}
function sg(f: { dir: string; data: string }, args: string[], extra: Record<string, string> = {}) {
  const env = { PATH: process.env.PATH, HOME: f.dir, XDG_DATA_HOME: f.data, ...extra };
  return spawnSync('node', [join(ROOT, 'bin/snowglobe.mjs'), ...args], { cwd: f.dir, env, encoding: 'utf8' });
}

const LOGINS = 'ALICE_DID=did:plc:alice\nALICE_PASSWORD=hunter2\nLEX_AUTHORITY_DID=did:plc:auth\n';
const APP_YML = `globe: setg
domain: sg.test
pds: [{ name: alpha, image: spaces-alpha, bare_handles: true }]
accounts: [alice@alpha]
apps:
  - name: web
    env:
      PDS: \${pds.alpha.url}
      LOGIN: \${accounts.alice.handle}
      PW: \${accounts.alice.password}
      DID: \${accounts.alice.did}
      AUTH: \${lexicons.authority.did}
      QUOTED: it's \${domain}
`;

describe('snowglobe env', () => {
  it('prints export lines for eval, then the CA, and leaves a password out with a comment', () => {
    const f = folder(APP_YML, LOGINS);
    const r = sg(f, ['env']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      "export PDS='https://alpha.sg.test'",
      "export LOGIN='alice.sg.test'",
      "export DID='did:plc:alice'",
      "export AUTH='did:plc:auth'",
      "export QUOTED='it'\\''s sg.test'",
      '# PW left out: accounts.alice.password is a secret; --secrets includes it',
      `export NODE_EXTRA_CA_CERTS='${join(f.data, 'snowglobe/ca/ca.crt')}'`,
      '',
    ]);
    expect(r.stdout).not.toContain('hunter2');
    expect(r.stdout.match(/PASSWORD=/g)).toBeNull();
  });

  it('includes the password with --secrets, and prints NAME=value with --dotenv', () => {
    const f = folder(APP_YML, LOGINS);
    expect(sg(f, ['env', '--secrets']).stdout).toContain("export PW='hunter2'");
    const dot = sg(f, ['env', '--dotenv']);
    expect(dot.stdout).toContain('PDS=https://alpha.sg.test\n');
    expect(dot.stdout).toContain('QUOTED=`it\'s sg.test`\n');
    expect(dot.stdout).not.toContain('export');
  });

  it('says what is not known before up, instead of printing a blank', () => {
    const r = sg(folder(APP_YML), ['env']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps[0].env.DID');
    expect(r.stderr).toContain('snowglobe up');
  });

  it('needs --app when the file lists several, and prints only the CA when it lists none', () => {
    const two = `${APP_YML}  - name: other\n    env:\n      X: \${domain}\n`;
    const f = folder(two, LOGINS);
    const r = sg(f, ['env']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--app');
    expect(sg(f, ['env', '--app', 'other']).stdout).toBe(`export X='sg.test'\nexport NODE_EXTRA_CA_CERTS='${join(f.data, 'snowglobe/ca/ca.crt')}'\n`);
    expect(sg(f, ['env', '--app', 'nope']).status).toBe(2);
    const none = sg(folder('globe: setg\npds: [{ name: alpha, image: spaces-alpha }]\n'), ['env']);
    expect(none.stdout.trim().split('\n')).toHaveLength(1);
    expect(none.stdout).toMatch(/^export NODE_EXTRA_CA_CERTS=/);
  });

  it('uses the app\'s own NODE_EXTRA_CA_CERTS rather than a second one', () => {
    const f = folder('globe: setg\npds: [{ name: alpha, image: spaces-alpha }]\napps:\n  - name: a\n    env:\n      NODE_EXTRA_CA_CERTS: ${ca.file}\n', '');
    mkdirSync(join(f.data, 'snowglobe/ca'), { recursive: true });
    writeFileSync(join(f.data, 'snowglobe/ca/ca.crt'), 'x');
    expect(sg(f, ['env']).stdout.match(/NODE_EXTRA_CA_CERTS/g)).toHaveLength(1);
  });

  it('exits nonzero with the file\'s problems when a name is wrong', () => {
    const r = sg(folder(APP_YML.replace('pds.alpha.url', 'pds.nope.url')), ['env']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps[0].env.PDS: pds.nope is not a PDS in this file: alpha');
  });
});

describe('formatEnv', () => {
  it('names every secret left out, one comment each', () => {
    const text = formatEnv({ vars: [], left: [{ name: 'A', via: ['accounts.a.password'] }, { name: 'B', via: ['accounts.a.password', 'accounts.b.password'] }] });
    expect(text.trim().split('\n')).toEqual([
      '# A left out: accounts.a.password is a secret; --secrets includes it',
      '# B left out: accounts.a.password, accounts.b.password are secrets; --secrets includes it',
    ]);
  });
});

// dotenv 16's reading of one NAME=value line (lib/main.js: its LINE pattern, quotes stripped, \n and
// \r expanded only inside double quotes), which Vite uses; then what Vite's expansion would change.
function dotenvRead(line: string) {
  const m = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/m.exec(line);
  let value = (m?.[2] ?? '').trim();
  const q = value[0];
  value = value.replace(/^(['"`])([\s\S]*)\1$/m, '$2');
  if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  return value;
}

describe('env --dotenv', () => {
  const dot = (value: string) => formatEnv({ vars: [{ name: 'V', value }], left: [] }, { dotenv: true }).trimEnd();

  it('writes a value so dotenv reads back exactly what it was given', () => {
    for (const value of ['https://alpha.sg.test', '', 'C:\\Users\\a b\\ca.crt', 'two words', 'a # b', "it's", 'say "hi"', 'it\'s "both"'.replace('"both"', 'x'), 'line1\nline2', 'a\\nb', 'price $5', 'a$', ' padded ', 'back`tick'])
      expect(dotenvRead(dot(value)), JSON.stringify(value)).toBe(value);
  });

  it('keeps a Windows path and a literal \\n as written', () => {
    expect(dot('C:\\a\\new')).toBe("V='C:\\a\\new'");
  });

  it('refuses, naming the setting, a value no dotenv form can hold', () => {
    for (const value of ['${UNCHANGED}', 'x$HOME', 'a\rb', `'"\``]) expect(() => dot(value), JSON.stringify(value)).toThrow(/^V cannot be written as a dotenv value/);
  });
});

describe('a value no process can be given', () => {
  const nul = (extra = '') => `globe: setg
pds: [{ name: alpha, image: spaces-alpha, bare_handles: true }]
accounts: [alice@alpha]
apps:
  - name: web
    env:
      PW: "prefix\\0\${accounts.alice.password}"
${extra}`;

  it('is refused by check, without the password in anything printed', () => {
    const f = folder(nul(), 'ALICE_PASSWORD=hunter2\n');
    for (const args of [['check'], ['env', '--secrets'], ['run', 'true']]) {
      const r = sg(f, args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toContain('apps[0].env.PW: must not contain a NUL');
      expect(r.stdout + r.stderr).not.toContain('hunter2');
    }
  });

  it('is refused when it is the login that holds it, naming the setting and never the value', () => {
    const f = folder(nul().replace('prefix\\0', 'prefix'), 'ALICE_PASSWORD=hun\0ter2\n');
    const r = sg(f, ['env', '--secrets']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps[0].env.PW');
    expect(r.stdout + r.stderr).not.toMatch(/hun|ter2/);
  });
});

describe('what is not known until up', () => {
  const yml = `globe: setg
pds: [{ name: alpha, image: spaces-alpha }]
apps:
  - name: web
    env:
      CREDS: \${accounts.file}
      CA: \${ca.file}
      MAIL: \${services.mail.url}
`;

  it('says so, for each, in a snowglobe that was never started', () => {
    const r = sg(folder(yml), ['env']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps[0].env.CREDS');
    expect(r.stderr).toContain('snowglobe up');
    for (const name of ['CA', 'MAIL']) {
      const only = yml.split('\n').filter((l) => !/^      (CREDS|CA|MAIL):/.test(l) || l.includes(`${name}:`)).join('\n');
      const one = sg(folder(only), ['env']);
      expect(one.status, name).toBe(1);
      expect(one.stderr).toContain(`env.${name}`);
    }
  });

  it('gives each its value once the state has it', () => {
    const f = folder(yml, 'ALICE_DID=x\n');
    mkdirSync(join(f.data, 'snowglobe/ca'), { recursive: true });
    writeFileSync(join(f.data, 'snowglobe/ca/ca.crt'), 'x');
    mkdirSync(join(f.data, 'snowglobe/setg/globe'), { recursive: true });
    writeFileSync(join(f.data, 'snowglobe/setg/globe/compose.yml'), 'x');
    const r = sg(f, ['env']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`export CREDS='${join(f.data, 'snowglobe/setg/accounts.env')}'`);
    expect(r.stdout).toContain(`export CA='${join(f.data, 'snowglobe/ca/ca.crt')}'`);
    expect(r.stdout).toContain("export MAIL='http://127.0.0.1:1081'");
  });
});

describe('services.tap.url', () => {
  const yml = `globe: setg
pds: [{ name: alpha, image: spaces-alpha }]
services: { tap: true }
apps:
  - name: web
    env:
      TAP: \${services.tap.url}
`;
  const started = () => {
    const f = folder(yml);
    mkdirSync(join(f.data, 'snowglobe/setg/globe'), { recursive: true });
    writeFileSync(join(f.data, 'snowglobe/setg/globe/compose.yml'), 'x');
    return f;
  };

  it('is on the snowglobe\'s own address, at the Tap port', () => {
    expect(sg(started(), ['env']).stdout).toContain("export TAP='http://127.0.0.1:2480'");
    const r = sg(started(), ['env'], { SG_BIND: '127.0.0.4', SG_TAP_PORT: '2490' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("export TAP='http://127.0.0.4:2490'");
  });

  it('is on the address the first up chose and kept, when SG_BIND is not set', () => {
    const f = started();
    writeFileSync(join(f.data, 'snowglobe/setg/bind'), '127.0.0.7\n');
    const r = sg(f, ['env']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("export TAP='http://127.0.0.7:2480'");
  });
});

describe('a setting named __proto__', () => {
  it('is checked like any other', () => {
    const f = folder('globe: setg\npds: [{ name: alpha, image: spaces-alpha }]\napps:\n  - name: web\n    env:\n      __proto__: ${pds.nope.url}\n');
    const r = sg(f, ['check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps[0].env.__proto__: pds.nope is not a PDS');
  });
});

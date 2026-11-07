// snowglobe certs (lib/certs.mjs): the globe's CA and leaf, made in Node. No Docker
// needed; run them alone with `npx vitest run snowglobe-certs`. Where openssl is installed, it
// checks the result as a second opinion and makes a CA the way the old scripts/https-ca.sh did;
// those cases are skipped without it. The CLI runs on a copy of bin/ and lib/ in a temporary root.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
// @ts-expect-error: a plain .mjs module, without types
import { ensureCerts, leafLacks, leafNames } from '../lib/certs.mjs';
// @ts-expect-error: a plain .mjs module, without types
import { nameReaches, snowglobeRequest, paths } from '../lib/env.mjs';

const ROOT = join(__dirname, '..');
const D = 'certs.test';
const NAMES = [D, `alpha.${D}`, `*.${D}`, `regular.${D}`, `*.regular.${D}`, `plc.${D}`, 'plc.directory', `*.app.${D}`];
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

// A root with bin/ and lib/, a snowglobe.yml and a rendered globe's leaf-names in the user's state
// folder (under XDG_DATA_HOME), as snowglobe up leaves it. The CA is the user's, beside the globes'.
const stateDir = (r: string) => join(r, 'xdg/snowglobe/g');
function globeRoot(names = NAMES) {
  const r = mkdtempSync(join(tmpdir(), 'snowglobe-certs-'));
  for (const d of ['bin', 'lib']) cpSync(join(ROOT, d), join(r, d), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(r, 'node_modules'));
  writeFileSync(join(r, 'package.json'), '{"type": "module"}\n');
  writeFileSync(join(r, 'snowglobe.yml'), 'globe: g\n');
  mkdirSync(join(stateDir(r), 'globe'), { recursive: true });
  writeFileSync(join(stateDir(r), 'globe/globe.env'), `SG_DOMAIN=${D}\n`);
  writeFileSync(join(stateDir(r), 'globe/leaf-names'), names.join('\n') + '\n');
  return r;
}
const certs = (r: string, args: string[] = [], env: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { ...process.env, XDG_DATA_HOME: join(r, 'xdg'), ...env };
  delete e.SG_DOMAIN;
  delete e.SG_FILE;
  delete e.HTTPS_EXTRA_NAMES;
  Object.assign(e, env);
  return spawnSync('node', [join(r, 'bin/snowglobe.mjs'), 'certs', ...args], { encoding: 'utf8', cwd: r, env: e });
};
const https = (r: string) => join(stateDir(r), 'https');
const caDir = (r: string) => join(r, 'xdg/snowglobe/ca');
// ca.* are in the CA's folder, the leaf's files in the snowglobe's.
const at = (r: string, f: string) => join(f.startsWith('ca.') ? caDir(r) : https(r), f);
const cert = (r: string, f: string) => new X509Certificate(readFileSync(at(r, f)));
const sans = (c: X509Certificate) => (c.subjectAltName ?? '').split(', ').map((s) => s.replace(/^DNS:/, ''));
const openssl = (...args: string[]) => spawnSync('openssl', args, { encoding: 'utf8' });
// The leaf's issuer and the CA's subject as bytes. Go (the relay, TAP) finds a leaf's CA by these
// bytes alone, where openssl and Node also accept an issuer that only reads the same.
const der = (r: string, f: string) => Buffer.from(readFileSync(at(r, f), 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
const tbs = (r: string, f: string) => AsnConvert.parse(der(r, f), Certificate).tbsCertificate;
const issuerBytesMatch = (r: string) =>
  Buffer.from(AsnConvert.serialize(tbs(r, 'leaf.crt').issuer)).equals(Buffer.from(AsnConvert.serialize(tbs(r, 'ca.crt').subject)));

// A CA and leaf made with the same openssl commands as the old scripts/https-ca.sh (at 62ee2c2).
function oldScriptCerts(dir: string, names: string[]) {
  mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  run('req', '-x509', '-new', '-nodes', '-sha256', '-days', '730', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/O=atproto-devnet/CN=atproto-devnet local CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'extendedKeyUsage=serverAuth',
    '-addext', `nameConstraints=critical,permitted;DNS:${D},permitted;DNS:plc.directory,excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0`);
  writeFileSync(join(dir, 'leaf.ext'), [
    'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth',
    'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid,issuer', `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`,
  ].join('\n'));
  run('req', '-new', '-nodes', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/O=atproto-devnet/CN=${D}`);
  run('x509', '-req', '-sha256', '-days', '397', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'leaf.ext', '-out', 'leaf.crt');
}

describe('snowglobe certs', () => {
  it('makes a CA and a leaf carrying every name, keys at mode 600', () => {
    const r = globeRoot();
    const res = certs(r);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toMatch(/Made a new CA: O=snowglobe, CN=snowglobe local CA \d{4}-\d\d-\d\d [0-9a-f]{6}/);
    const ca = cert(r, 'ca.crt');
    const leaf = cert(r, 'leaf.crt');
    expect(ca.ca).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(sans(leaf).sort()).toEqual([...NAMES].sort());
    expect(leaf.subject).toBe(`O=snowglobe\nCN=${D}`);
    expect(issuerBytesMatch(r)).toBe(true);
    for (const f of ['ca.key', 'leaf.key']) expect(statSync(at(r, f)).mode & 0o777, f).toBe(0o600);
    for (const f of ['ca.crt', 'leaf.crt']) expect(statSync(at(r, f)).mode & 0o777, f).toBe(0o644);
    expect(createPrivateKey(readFileSync(join(https(r), 'leaf.key'))).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });

  it.skipIf(!hasOpenssl)('makes a CA openssl reads as the old one: constrained to the globe, server auth only', () => {
    const r = globeRoot();
    expect(certs(r).status).toBe(0);
    const text = openssl('x509', '-in', at(r, 'ca.crt'), '-noout', '-text').stdout;
    expect(text).toMatch(/Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    expect(text).toMatch(/Key Usage: critical\s+Certificate Sign, CRL Sign/);
    expect(text).toMatch(/Extended Key Usage:\s+TLS Web Server Authentication/);
    expect(text).toMatch(new RegExp(`Name Constraints: critical\\s+Permitted:\\s+DNS:local.snowglobe.at\\s+DNS:${D}\\\s+DNS:plc.directory\\s+Excluded:\\s+IP:0.0.0.0/0.0.0.0\\s+IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0`));
    const verify = openssl('verify', '-CAfile', at(r, 'ca.crt'), at(r, 'leaf.crt'));
    expect(verify.status, verify.stderr).toBe(0);
  });

  it('keeps the CA, and the leaf too when it carries every name', () => {
    const r = globeRoot();
    expect(certs(r).status).toBe(0);
    const ca = cert(r, 'ca.crt').fingerprint256;
    const leaf = cert(r, 'leaf.crt').fingerprint256;
    expect(certs(r, ['--check']).status).toBe(0);
    const again = certs(r);
    expect(again.status).toBe(0);
    expect(again.stderr).toMatch(/Keeping the existing CA/);
    expect(cert(r, 'ca.crt').fingerprint256).toBe(ca);
    expect(cert(r, 'leaf.crt').fingerprint256).toBe(leaf);
  });

  it("reissues the leaf in place when an app claims an ending, from the same CA", () => {
    const r = globeRoot();
    expect(certs(r).status).toBe(0);
    const ca = cert(r, 'ca.crt').fingerprint256;
    const inode = statSync(join(https(r), 'leaf.crt')).ino;
    const keyInode = statSync(join(https(r), 'leaf.key')).ino;
    writeFileSync(join(https(r), 'apps'), 'atmo 5173 ev\nplain 5600\n');
    expect(certs(r, ['--check']).status).toBe(1);
    expect(certs(r).status).toBe(0);
    expect(sans(cert(r, 'leaf.crt'))).toContain(`*.ev.${D}`);
    expect(cert(r, 'ca.crt').fingerprint256).toBe(ca);
    expect(statSync(join(https(r), 'leaf.crt')).ino).toBe(inode);
    expect(statSync(join(https(r), 'leaf.key')).ino).toBe(keyInode);
  });

  it('refuses a name the CA cannot vouch for, and leaves the leaf as it was', () => {
    const r = globeRoot();
    expect(certs(r).status).toBe(0);
    const leaf = cert(r, 'leaf.crt').fingerprint256;
    const res = certs(r, [], { HTTPS_EXTRA_NAMES: 'example.com' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/cannot vouch for example\.com/);
    expect(cert(r, 'leaf.crt').fingerprint256).toBe(leaf);
  });

  it('refuses when only one of ca.crt and ca.key is there', () => {
    const r = globeRoot();
    mkdirSync(caDir(r), { recursive: true });
    writeFileSync(at(r, 'ca.crt'), 'x');
    const res = certs(r);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(`Only one of ${at(r, 'ca.crt')} and ca.key`);
    expect(existsSync(at(r, 'ca.key'))).toBe(false);
  });

  it.skipIf(!hasOpenssl)("keeps a CA and leaf the old https-ca.sh made, and reissues from that CA", () => {
    const r = globeRoot();
    const old = join(r, 'old-certs');
    oldScriptCerts(old, NAMES);
    mkdirSync(caDir(r), { recursive: true });
    mkdirSync(https(r), { recursive: true });
    for (const f of ['ca.crt', 'ca.key']) copyFileSync(join(old, f), at(r, f));
    for (const f of ['leaf.crt', 'leaf.key']) copyFileSync(join(old, f), at(r, f));
    const ca = cert(r, 'ca.crt').fingerprint256;
    const leaf = cert(r, 'leaf.crt').fingerprint256;
    expect(certs(r, ['--check']).status).toBe(0);
    expect(certs(r).status).toBe(0);
    expect(cert(r, 'leaf.crt').fingerprint256).toBe(leaf);

    const more = certs(r, [], { HTTPS_EXTRA_NAMES: `x.alpha.${D}` });
    expect(more.status, more.stderr).toBe(0);
    expect(cert(r, 'ca.crt').fingerprint256).toBe(ca);
    expect(cert(r, 'leaf.crt').verify(cert(r, 'ca.crt').publicKey)).toBe(true);
    expect(issuerBytesMatch(r)).toBe(true);
    const verify = openssl('verify', '-CAfile', at(r, 'ca.crt'), at(r, 'leaf.crt'));
    expect(verify.status, verify.stderr).toBe(0);
  });

  it('leafNames reads the rendered names, app endings and extra names', () => {
    const r = globeRoot();
    mkdirSync(https(r), { recursive: true });
    writeFileSync(join(https(r), 'apps'), 'atmo 5173 ev\nplain 5600\n');
    expect(leafNames(paths(r, stateDir(r)), D, ' x.alpha.certs.test ')).toEqual([...NAMES, `*.ev.${D}`, `x.alpha.${D}`]);
    expect(leafLacks(https(r), NAMES)).toBe(true);
  });

  it('reissues a leaf the user\'s CA did not sign, and keeps one it did', async () => {
    const r = globeRoot();
    expect(certs(r).status).toBe(0);
    expect(leafLacks(https(r), NAMES, caDir(r))).toBe(false);
    // Another CA's files in the CA's place: the leaf carries every name but is not its leaf.
    const other = join(r, 'other');
    await ensureCerts({ dir: other, domain: D, names: NAMES });
    copyFileSync(join(other, 'ca.crt'), at(r, 'ca.crt'));
    copyFileSync(join(other, 'ca.key'), at(r, 'ca.key'));
    expect(leafLacks(https(r), NAMES, caDir(r))).toBe(true);
    expect(certs(r, ['--check']).status).toBe(1);
    expect(certs(r).status).toBe(0);
    expect(cert(r, 'leaf.crt').verify(cert(r, 'ca.crt').publicKey)).toBe(true);
  });
});

describe('snowglobeRequest', () => {
  it("reaches a globe name on the bind address, trusting only the globe's CA", async () => {
    const r = globeRoot();
    const names = [...NAMES, `pds.${D}`];
    await ensureCerts({ dir: https(r), caDir: caDir(r), domain: D, names });
    const server = createServer(
      { key: readFileSync(join(https(r), 'leaf.key')), cert: readFileSync(join(https(r), 'leaf.crt')) },
      (req, res) => res.end(`hello ${req.headers.host}`),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await snowglobeRequest(`https://pds.${D}:${port}/xrpc/_health`, { root: r, state: stateDir(r), env: {} });
      expect(ok).toEqual({ status: 200, body: `hello pds.${D}:${port}` });
      // A name the leaf does not carry fails the TLS check.
      await expect(snowglobeRequest(`https://other.example:${port}/`, { root: r, state: stateDir(r), env: {} })).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

describe('nameReaches', () => {
  // Two snowglobes' leaves from one CA, as on a machine running two: each carries the same names,
  // so only the leaf itself tells them apart.
  async function two() {
    const mine = globeRoot();
    const other = globeRoot();
    await ensureCerts({ dir: https(mine), caDir: caDir(mine), domain: D, names: NAMES });
    await ensureCerts({ dir: https(other), caDir: caDir(mine), domain: D, names: NAMES });
    return { mine, other, leaf: readFileSync(join(https(mine), 'leaf.crt'), 'utf8') };
  }
  async function serve(r: string, host = '127.0.0.1') {
    const server = createServer({ key: readFileSync(join(https(r), 'leaf.key')), cert: readFileSync(join(https(r), 'leaf.crt')) }, (_req, res) => res.end());
    await new Promise<void>((done) => server.listen(0, host, done));
    return { server, port: (server.address() as { port: number }).port };
  }
  // A resolver that answers every name with these addresses, in order, as dns.lookup does with all.
  type Found = { address: string; family: number }[];
  const at =
    (...addresses: string[]) =>
    (_name: string, _opts: unknown, cb: (e: Error | null, a?: Found) => void) =>
      cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  // A plain TCP server on 127.0.0.1 that does `then` with each connection.
  async function tcp(then: (s: import('node:net').Socket) => void) {
    const server = (await import('node:net')).createServer(then);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { server, port: (server.address() as { port: number }).port };
  }

  it("reaches the globe where its own leaf answers, and tells another snowglobe's apart", async () => {
    const { mine, other, leaf } = await two();
    const a = await serve(mine);
    const b = await serve(other);
    try {
      expect(await nameReaches(D, { leaf, lookup: at('127.0.0.1'), port: a.port })).toEqual({ reached: true, address: '127.0.0.1' });
      expect(await nameReaches(D, { leaf, lookup: at('127.0.0.1'), port: b.port })).toEqual({ reached: false, why: 'another', address: '127.0.0.1' });
    } finally {
      a.server.close();
      b.server.close();
    }
  });

  it('says when nothing answers at the address, or the name has none', async () => {
    const { mine, leaf } = await two();
    // A port that was just closed: nothing listens there.
    const a = await serve(mine);
    await new Promise((done) => a.server.close(done));
    expect(await nameReaches(D, { leaf, lookup: at('127.0.0.1'), port: a.port })).toEqual({ reached: false, why: 'unanswered', address: '127.0.0.1', code: 'ECONNREFUSED' });
    const none = (_name: string, _opts: unknown, cb: (e: Error) => void) => cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
    expect(await nameReaches(D, { leaf, lookup: none })).toEqual({ reached: false, why: 'unresolved', code: 'ENOTFOUND' });
  });

  it('counts anything that takes the connection without this leaf as another, not as nothing', async () => {
    const { leaf } = await two();
    // A plain http server on 443, something that closes every connection (as the name router does
    // a name it does not route), and something that takes it and never speaks.
    const http = await tcp((s) => s.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    const closes = await tcp((s) => s.destroy());
    const silent = await tcp(() => {});
    try {
      for (const { port } of [http, closes, silent])
        expect(await nameReaches(D, { leaf, lookup: at('127.0.0.1'), port, timeout: 300 })).toMatchObject({ reached: false, why: 'another', address: '127.0.0.1' });
    } finally {
      for (const { server } of [http, closes, silent]) server.close();
    }
  });

  it('tries every address the name has, as an app falling back does, and reports the first', async () => {
    const { mine, leaf } = await two();
    const a = await serve(mine);
    try {
      // Nothing on ::1 (or no IPv6 at all), the globe on 127.0.0.1.
      expect(await nameReaches(D, { leaf, lookup: at('::1', '127.0.0.1'), port: a.port })).toEqual({ reached: true, address: '127.0.0.1' });
      expect(await nameReaches(D, { leaf, lookup: at('127.0.0.2', '127.77.0.9'), port: a.port })).toMatchObject({ reached: false, why: 'unanswered', address: '127.0.0.2' });
    } finally {
      a.server.close();
    }
  });

  it("looks the name up through the machine's own resolver by default, hosts file included", async () => {
    const { mine, leaf } = await two();
    // localhost comes from the hosts file, and the server takes whichever address it resolves to first.
    const a = await serve(mine, 'localhost');
    try {
      expect(await nameReaches('localhost', { leaf, port: a.port })).toMatchObject({ reached: true });
    } finally {
      a.server.close();
    }
  });
});

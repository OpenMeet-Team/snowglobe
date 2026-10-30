#!/usr/bin/env node
// The package as a user installs it: npm pack of this checkout, installed into an empty folder with
// no lockfile, so npm resolves every dependency afresh, as `npm install @openmeet/snowglobe` does.
// Then the installed lib/certs.mjs makes a CA and a leaf in an empty folder, the first thing a new
// user's up does. The repo's tests run on package-lock.json, which can hide a dependency that
// resolves differently: 0.3.0 pinned two @peculiar/asn1-* packages that @peculiar/x509 also asks for,
// npm installed a second copy of each for x509, and no new install could make its CA.
//
//   node scripts/packed.mjs
//
// Needs npm and its registry. One line per step, ok or FAIL, and exit 0 only when every step
// passed. Its folder is left for a look.

import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The packages lib/certs.mjs imports beside @peculiar/x509, which must be the copies x509 uses.
const SHARED = ['@peculiar/asn1-schema', '@peculiar/asn1-x509'];

const root = mkdtempSync(join(tmpdir(), 'snowglobe-packed-'));
const install = join(root, 'install');
mkdirSync(install);
writeFileSync(join(install, 'package.json'), '{"private": true}\n');

let failed = 0;
function step(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}
const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 300_000 });
// The last line of a failed command's stderr, which names what went wrong.
const why = (r) => (r.error?.message ?? r.stderr ?? '').trim().split('\n').pop();

console.log(`folder: ${root}`);
console.log(`node ${process.version}; npm ${npm(['--version']).stdout.trim()}\n`);

try {
  let r = npm(['pack', '--json', '--pack-destination', root], SRC);
  if (!step('npm pack', r.status === 0, why(r))) throw new Error('pack failed');
  const tarball = join(root, JSON.parse(r.stdout)[0].filename);

  r = npm(['install', '--no-audit', '--no-fund', tarball], install);
  if (!step('npm install of the tarball, no lockfile', r.status === 0, why(r))) throw new Error('install failed');

  for (const name of SHARED) {
    r = npm(['query', `#${name}`], install);
    if (r.status !== 0) {
      step(`one copy of ${name}`, false, why(r));
      continue;
    }
    const copies = JSON.parse(r.stdout);
    const versions = [...new Set(copies.map((n) => n.version))].join(' and ');
    step(`one copy of ${name}`, copies.length === 1, `${copies.length} installed, ${versions}`);
  }

  const pkg = join(install, 'node_modules/@openmeet/snowglobe');
  const { ensureCerts } = await import(pathToFileURL(join(pkg, 'lib/certs.mjs')).href);
  const dir = join(root, 'certs');
  try {
    await ensureCerts({ dir, domain: 'local.snowglobe.at', names: ['local.snowglobe.at', '*.local.snowglobe.at'] });
    const ca = new X509Certificate(readFileSync(join(dir, 'ca.crt')));
    const leaf = new X509Certificate(readFileSync(join(dir, 'leaf.crt')));
    step('a new CA and its leaf', leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  } catch (e) {
    step('a new CA and its leaf', false, e.message);
  }
} catch (e) {
  if (!/ failed$/.test(e.message)) step('packed', false, e.message);
}

console.log(`\n${failed ? `${failed} step(s) FAILED` : 'every step passed'}; the folder is ${root}`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Builds the images snowglobe up pulls instead of building (lib/prebuilt.mjs PUBLISHED), labels each
// with the hash of the files it is built from, and with --push, pushes it to the registry under
// the tag the rendered compose file names. CI runs it on a release tag (.github/workflows/images.yml).
//
//   node scripts/publish-images.mjs [--push] [--dry-run]
//
// The tags come from docs/examples/atmo.yml rendered as `up` renders it, which has the relay; a
// default SG_SLINGSHOT_COMMIT or SG_RELAY_INDIGO_COMMIT is whatever the code says today.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGlobe } from '../lib/config.mjs';
import { PUBLISHED, REGISTRY, SOURCE_LABEL, sourceHash } from '../lib/prebuilt.mjs';
import { loadBase, renderGlobe } from '../lib/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_NAMES = ['SG_PDS_ADMIN_PASSWORD', 'SG_PDS_JWT_SECRET', 'SG_PLC_ROTATION_KEY', 'SG_RELAY_ADMIN_PASSWORD', 'SG_COLLECTIONDIR_ADMIN_TOKEN', 'SG_DB_PASSWORD'];
const push = process.argv.includes('--push');
const dry = process.argv.includes('--dry-run');
const registry = process.env.SG_IMAGE_REGISTRY ?? REGISTRY;

const { globe, errors } = loadGlobe(join(ROOT, 'docs/examples/atmo.yml'));
if (errors.length) throw new Error(errors.join('\n'));
const file = join(mkdtempSync(join(tmpdir(), 'snowglobe-publish-')), 'compose.yml');
writeFileSync(file, renderGlobe(globe, loadBase(ROOT), { stateDir: '/state/snowglobe/snowglobe' })['compose.yml']);

// Compose fills in the ${...} defaults, so the tag and build args are the ones `up` would use.
const config = spawnSync('docker', ['compose', '-f', file, '--project-directory', ROOT, 'config', '--format', 'json'], {
  encoding: 'utf8',
  // The file takes every secret as ${SG_...:?}, and compose refuses to read it without one; a
  // build needs none of them, so each gets a placeholder (a name the file does not use is harmless).
  env: { ...process.env, ...Object.fromEntries(SECRET_NAMES.map((n) => [n, 'x'])) },
});
if (config.status !== 0) throw new Error(config.stderr);

const run = (args) => {
  console.log(`docker ${args.join(' ')}`);
  if (dry) return;
  if (spawnSync('docker', args, { stdio: 'inherit' }).status !== 0) throw new Error(`docker ${args[0]} failed`);
};
for (const def of Object.values(JSON.parse(config.stdout).services)) {
  const name = def.image?.split(':')[0];
  if (!def.build || !(name in PUBLISHED)) continue;
  const remote = `${registry}/${def.image}`;
  const args = Object.entries(def.build.args ?? {}).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
  run(['build', '-t', def.image, '-t', remote, '--label', `${SOURCE_LABEL}=${sourceHash(ROOT, name)}`, ...args, def.build.context]);
  if (push) run(['push', remote]);
}

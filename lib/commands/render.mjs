// bin/snowglobe.mjs render [<file>] [--out <dir>] [--domain <domain>]
//
// render checks the file as check does (exit 1 with one line per problem), then writes the https
// globe it describes into <dir> (globe/ in the snowglobe's state folder by default, see
// lib/state.mjs): compose.yml, nginx's servers, the leaf certificate's names and globe.env, the
// facts the other commands read (lib/render.mjs). Nothing in them is secret. --domain replaces the file's domain, for a copy beside another globe. A group
// host with no image or build folder in the file is built from the folder its kind's variable
// names (SG_OPENSOCIAL_BUILD, a checkout of atproto-group-host); with neither, render fails.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { withGroupHostSources } from '../config.mjs';
import { ROOT, paths } from '../env.mjs';
import { loadBase, renderGlobe } from '../render.mjs';
import { claimState, session } from '../state.mjs';
import { checkedGlobe } from './check.mjs';

export const command = {
  name: 'render',
  usage: 'render [<file>] [--out <dir>] [--domain <domain>]',
  options: { out: { type: 'string' }, domain: { type: 'string' } },
  positionals: [0, 1],
};

export function run({ values, positionals }) {
  const { path, globe } = checkedGlobe(positionals[0], { domain: values.domain });
  if (!globe) return 1;
  let out;
  try {
    // Into the state folder, the file takes it over once the render is written (a refused file
    // leaves the record as it was); into --out, it only reads where the state is.
    const s = session({ file: path });
    out = writeGlobe(globe, path, values.out ?? paths(ROOT, s.state).globe, process.env, s.state);
    const took = values.out === undefined ? claimState(s) : null;
    if (took) console.error(took);
  } catch (e) {
    for (const line of e.message.split('\n')) console.error(`${path}: ${line}`);
    return 1;
  }
  console.log(`${path}: wrote ${out}: globe ${globe.globe} at ${globe.domain}, PDSs ${globe.pds.map((p) => p.name).join(' ')}`);
  return 0;
}

/**
 * Write the checked `globe`, read from `path`, into `out`, a folder; returns it. `state` is the
 * snowglobe's state folder, which the compose file mounts from. Throws, before writing anything,
 * when a group host has nowhere to get its image from.
 */
export function writeGlobe(globe, path, out, env, state) {
  globe = withGroupHostSources(globe, env);
  // The compose file mounts nginx's part of the output, by a path from the repo root, which is
  // the compose project directory (lib/env.mjs dc).
  out = resolve(out);
  const rel = relative(ROOT, out);
  const globeDir = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : out;
  const files = renderGlobe(globe, loadBase(ROOT), { stateDir: state, globeDir, source: basename(path) });
  for (const [name, text] of Object.entries(files)) {
    const target = join(out, name);
    mkdirSync(dirname(target), { recursive: true });
    // Written aside and renamed, so nothing reads half a file.
    writeFileSync(`${target}.tmp`, text);
    renameSync(`${target}.tmp`, target);
  }
  return out;
}

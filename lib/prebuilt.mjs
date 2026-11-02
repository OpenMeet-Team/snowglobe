// The images snowglobe builds from its own folders that are also published (scripts/publish-images.mjs),
// so `up` pulls them where it can and builds only what it cannot. A pulled image is used only when
// its source label equals the hash of the folder's files in this checkout, so an edited Dockerfile
// or patch is built, never silently served from the registry.

import { spawnSync } from 'node:child_process';
import { contextHash } from './render.mjs';

export const REGISTRY = 'ghcr.io/openmeet-team';
export const SOURCE_LABEL = 'at.snowglobe.source';

// Image name (the part of the compose image before the tag): its folder, and the files its Dockerfile uses.
export const PUBLISHED = {
  'snowglobe-slingshot': ['stack/slingshot', ['Dockerfile']],
  'snowglobe-pdsls': ['stack/pdsls', ['Dockerfile', 'network.patch', 'server.mjs']],
  'snowglobe-relay': ['stack/relay', ['Dockerfile', 'allow-private-hosts.patch']],
  'snowglobe-collectiondir': ['stack/collectiondir', ['Dockerfile', 'allow-private-hosts.patch', 'crawl-qps.patch']],
};

/** The source label an image of this name should carry for the files in `root`. */
export const sourceHash = (root, name) => contextHash(root, ...PUBLISHED[name]);

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });

/**
 * Of the rendered compose file's services, those whose image is already here or can be pulled
 * from the registry with a matching source label. Returns their names; the caller builds the rest.
 * SG_PREBUILT=0 pulls nothing and uses nothing (an image is then built, as it always was).
 */
export function prebuilt({ root, services, env = process.env, run = docker, log = () => {} }) {
  if (env.SG_PREBUILT === '0') return [];
  const registry = (env.SG_IMAGE_REGISTRY ?? REGISTRY).replace(/\/$/, '');
  const label = (ref) => {
    const r = run(['image', 'inspect', '-f', `{{index .Config.Labels "${SOURCE_LABEL}"}}`, ref]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const ready = [];
  const pulled = [];
  for (const [service, def] of Object.entries(services)) {
    const ref = def.build && def.image;
    const name = ref?.split(':')[0];
    if (!(name in PUBLISHED)) continue;
    const want = sourceHash(root, name);
    if (label(ref) === want) {
      ready.push(service);
      continue;
    }
    if (!registry) continue;
    if (run(['pull', '-q', `${registry}/${ref}`]).status !== 0) continue;
    if (run(['tag', `${registry}/${ref}`, ref]).status === 0 && label(ref) === want) {
      ready.push(service);
      pulled.push(service);
    }
  }
  if (pulled.length) log(`Pulled prebuilt images (${pulled.join(' ')})`);
  return ready;
}

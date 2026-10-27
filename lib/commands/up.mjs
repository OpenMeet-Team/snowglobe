// bin/snowglobe.mjs up [<file> | <name>] [-f <file>] [--default]
//
// up brings up the globe a snowglobe.yml describes, as the compose project named for the file's
// `globe:` (or SG_PROJECT). Safe to rerun: each step keeps what an earlier run made, and a rerun
// is one `docker compose up`.
//
// Everything it makes is kept in the snowglobe's state folder, <state root>/<globe> (lib/env.mjs
// stateRoot: ~/.local/share/snowglobe, or under XDG_DATA_HOME; %LOCALAPPDATA% on Windows), which
// remembers the file that last brought it up; any file with the same `globe:` is the same snowglobe. Below, data/
// means that folder. A checkout that still holds a globe in its own data/ is refused (nothing
// started, nothing moved) with the command that moves it.
//
//   1. render: data/globe/ from <file> (or -f <file>), or the file that last brought up the snowglobe called
//      <name> (snowglobe ls lists them), else SG_FILE, else the nearest snowglobe.yml here or above
//      (none: up refuses; `up --default` runs the default globe, snowglobe.default.yml: one PDS,
//      a PLC directory and Jetstream).
//      SG_DOMAIN, from the environment or .env, replaces the file's domain.
//      A group host with no image in the file is built from its build folder, else from
//      SG_OPENSOCIAL_BUILD (a checkout of atproto-group-host); with neither, up stops here.
//   2. certs, if data/https has no leaf yet, or it lacks a name (the user's CA, in ca/ beside the
//      snowglobes' folders, is made once and kept)
//   3. nginx's app routes and the network page, from data/https/apps (app --render), then each
//      group host built from a folder is built again (Docker's cache keeps that quick)
//   4. pass 1: up. The base init seeds alice, bob and SG_INVITE_CODE into
//      data/accounts.env on the PDS with bare handles (else the first), as it does for the
//      http stacks.
//   5. the lexicon authority, lex-authority on the file's lexicons.authority PDS
//      (LEX_AUTHORITY_* in data/accounts.env), then pass 2: up with
//      SG_LEXICON_AUTHORITY_DID, which recreates the PDSes with it
//   6. what the file seeds: each of its accounts (snowglobe account; the login under <NAME>_* in
//      data/accounts.env, <NAME>_<PDS>_* on a PDS other than the one with bare handles, else the
//      first), and its lexicons.publish folder into the authority (snowglobe lexicons). Its apps'
//      local routes (port, handle ending) are set before step 2, so the leaf and nginx have them.
//   7. an old data/devnet.env, from before snowglobe env, is removed; nothing writes one now
//
// A rerun finds the accounts and leaves unchanged lexicons alone. Anything else an app makes
// (more accounts, invite codes) is its own, with account, invite and lexicons. Nothing secret is
// printed. The tool ports (SG_PLC_PORT, SG_JETSTREAM_PORT, SG_JETSTREAM_METRICS_PORT,
// SG_MAILDEV_WEB_PORT, SG_MAILDEV_SMTP_PORT, SG_PROXY_PORT) are published on the snowglobe's own
// loopback address (SG_BIND, else the one chosen at its first up and kept in its state folder), so
// two snowglobes need no port settings; a port variable moves one, in the environment or .env. devnet-spaces, the shared devnet, is refused (exit 3) as
// the project unless SG_RESET_OK=1, before anything else is done.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { appEnding, appEndingMessage, formatApps, readApps, renderRoutes, writeApps } from '../apps.mjs';
import { loadGlobe } from '../config.mjs';
import { ROOT, addName, chooseBind, dc, ensureSecrets, projectHasData, snowglobeRequest, envGet, guardProject, makePrivate, oldDataNotice, paths, renamedDefaultNotice, resolveBind, resolveDomain } from '../env.mjs';
import { prebuilt } from '../prebuilt.mjs';
import { byName, claimState, pointedAt, session } from '../state.mjs';
import { accountPrefixes, endingClash, mergeRoutes } from '../up.mjs';
import { account } from './account.mjs';
import { lexicons } from './lexicons.mjs';
import { checkedGlobe } from './check.mjs';
import { writeGlobe } from './render.mjs';

export const command = {
  name: 'up',
  usage: 'up [<file> | <name>] [-f <file>] [--default]',
  // --default is the only way up runs the repo's default snowglobe; with no file and no
  // snowglobe.yml in this folder or above, up refuses.
  options: { default: { type: 'boolean' }, file: { type: 'string', short: 'f' } },
  positionals: [0, 1],
  accepts: ({ values, positionals }) => !(values.default && (positionals.length || values.file)),
};

// How long a one-shot (init, relay-init) may take, and nginx to answer again after a restart.
const ONESHOT_SECONDS = 300;
const NGINX_SECONDS = 30;

// Until nginx answers the globe's page over TLS, with any status.
async function waitServing(domain, { root, state, env }) {
  const seconds = Number(env.SG_NGINX_WAIT) || NGINX_SECONDS;
  for (let n = 0; ; n++) {
    try {
      return await snowglobeRequest(`https://${domain}/`, { root, state, env });
    } catch (e) {
      if (n >= seconds) throw new Error(`nginx did not answer https://${domain}/ within ${seconds} s after its restart: ${e.message}`);
      await sleep(1000);
    }
  }
}

export async function run({ values, positionals: [word] }) {
  let file;
  if (values.default) file = join(ROOT, 'snowglobe.default.yml');
  else {
    const at = pointedAt({ file: values.file, word });
    file = at.file;
    if (at.name) {
      // A snowglobe by its name is brought up from the file that last brought it up.
      file = byName(at.name).path;
      if (!file) throw new Error(`the file that last brought up the snowglobe ${at.name} is gone; bring it up from a file: snowglobe up -f <file>`);
      // The file may have been renamed since (globe: changed): up would then start the new name.
      const { globe } = loadGlobe(file);
      if (globe && globe.globe !== at.name)
        throw new Error(`${file} says globe: ${globe.globe} now, not ${at.name}; put globe: ${at.name} back to bring ${at.name} up, or snowglobe up ${file} to start ${globe.globe} as a new snowglobe`);
    }
  }
  await up({ file, log: (m) => console.error(m) });
}

export async function up({ file, root = ROOT, env = process.env, log = () => {} }) {
  // The shared devnet is refused before anything is looked up, even by a file that is not there.
  if (env.SG_PROJECT) guardProject(env);
  const found = session({ file, env, allowDefault: false });
  const project = guardProject(env, found.name);
  const state = found.state;
  const old = oldDataNotice(root, state);
  if (old) throw new Error(old);
  const renamed = resolve(found.path) === join(root, 'snowglobe.default.yml') && renamedDefaultNotice(root, state);
  if (renamed) throw new Error(renamed);
  const p = paths(root, state);
  // Both are read as compose reads them, and refused here when they are not a domain and a
  // loopback address.
  const { set } = resolveDomain({ root, state, env, rendering: true });
  resolveBind({ root, state, env });

  const { path, globe } = checkedGlobe(found.path, { domain: set || undefined });
  if (!globe) throw new Error(`${path} has problems (above); ${p.globe} is as it was`);
  mkdirSync(state, { recursive: true });
  // Its own loopback address for every published port, chosen once, so a second snowglobe starts beside this one.
  const bind = await chooseBind({ root, state, project, env });
  if (bind !== '127.0.0.1') log(`${found.name} publishes its ports on ${bind}`);
  // Checked before the render changes, so a refused file leaves the running globe's render.
  const kept = readApps(p);
  const badEnding = appEnding(kept);
  if (badEnding) throw new Error(appEndingMessage(p.apps, badEnding));
  const routes = mergeRoutes(kept, globe.apps);
  const home = (globe.pds.find((x) => x.bare_handles) ?? globe.pds[0]).name;
  const seedAccounts = accountPrefixes(globe.accounts, home);
  const clash = endingClash(
    [...globe.pds, ...globe.grouphosts].map((x) => x.name),
    routes,
  );
  if (clash)
    throw new Error(
      `the server ${clash.pds} would take the handles under ${clash.pds}.<domain>, the ending app ${clash.app} claimed; rename the server, or snowglobe app --remove ${clash.app}`,
    );
  if (formatApps(routes) !== formatApps(kept)) {
    mkdirSync(p.https, { recursive: true });
    writeApps(p, routes);
  }
  writeGlobe(globe, path, p.globe, env, state);
  // Recorded once the render is this file's, so a refused file leaves the record as it was.
  const took = claimState(found);
  if (took) log(took);
  const domain = globe.domain;
  const ghs = globe.grouphosts.length ? `, group hosts ${globe.grouphosts.map((x) => x.name).join(' ')}` : '';
  log(`${path}: globe ${globe.globe} at ${domain}, PDSs ${globe.pds.map((x) => x.name).join(' ')}${ghs}`);

  // The leaf must carry every name (lib/certs.mjs): a leaf from before the app routes moved lacks
  // *.app.<domain>, and one from before an app claimed a handle ending lacks its wildcard.
  const { ensureCerts, leafLacks, leafNames } = await import('../certs.mjs');
  const names = leafNames(p, domain, env.HTTPS_EXTRA_NAMES);
  const newCerts = leafLacks(p.https, names, p.caDir);
  if (newCerts) await ensureCerts({ dir: p.https, caDir: p.caDir, domain, names, log });
  renderRoutes({ root, state, env });

  const facts = (name) => envGet(name, p.globeEnv).split(' ').filter(Boolean);
  // compose fills the file's ${SG_LEXICON_AUTHORITY_DID} from this.
  const secrets = ensureSecrets({ root, state, env, hasData: () => projectHasData(project, env) });
  if (secrets.kept.length)
    log(`${found.name} has data made before its secrets were random, so it keeps the fixed ${secrets.kept.join(', ')}. snowglobe down -v, then up, starts it over with random ones (every account is lost).`);
  const composeEnv = { ...env, ...secrets.values };
  const compose = (args, opts = {}) => {
    const res = dc(project, args, { root, state, env: composeEnv, ...opts });
    if (res.error) throw res.error;
    if (res.status !== 0)
      throw new Error(`docker compose ${args.join(' ')} failed (exit ${res.status}). If a container crash-loops after you updated snowglobe, an image built earlier may be stale (the slingshot image is tagged by its commit, so a changed stack/slingshot/ folder alone does not rebuild it): run snowglobe down (without -v, which keeps your data), remove the image with docker rmi, then run up again`);
    return res;
  };
  // The nginx template as the running nginx last started with it (stamped after a restart here).
  const templateFile = join(root, 'stack/https/nginx.conf.template');
  const templateStamp = join(p.https, 'nginx-template.sha256');
  const templateHash = createHash('sha256').update(existsSync(templateFile) ? readFileSync(templateFile) : '').digest('hex');
  const templateChanged = !existsSync(templateStamp) || readFileSync(templateStamp, 'utf8').trim() !== templateHash;
  const put = (file, text) => {
    writeFileSync(`${file}.tmp`, `${text}\n`);
    renameSync(`${file}.tmp`, file);
  };
  // Container ids, none when compose cannot say (a project not made yet).
  const ids = (args) => (dc(project, ['ps', ...args], { root, state, stdio: 'pipe', encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean);

  // `up --wait` alone fails as soon as a one-shot service exits, even with 0. So: up, then wait
  // for the one-shots (init seeds data/accounts.env; relay-init registers every PDS with the
  // relay), then for every long-running service to be healthy.
  async function waitDone(service) {
    for (let n = 0; n < ONESHOT_SECONDS; n++) {
      const st = compose(['ps', '-a', '--format', '{{.State}} {{.ExitCode}}', service], { stdio: 'pipe', encoding: 'utf8' }).stdout.split('\n')[0];
      if (st === 'exited 0') return;
      if (st.startsWith('exited')) throw new Error(`${service} failed (exit ${st.slice('exited '.length)})`);
      await sleep(1000);
    }
    throw new Error(`${service} did not finish within ${ONESHOT_SECONDS} s`);
  }
  const waitServices = () => compose(['up', '-d', '--wait', ...facts('SG_SERVICES')]);
  async function upStack() {
    // A service the file no longer runs (a PDS taken out, a service turned off) is stopped.
    compose(['up', '-d', '--remove-orphans']);
    for (const s of facts('SG_ONESHOTS')) await waitDone(s);
    waitServices();
  }

  // What runs before this run: the relay, and every container, to notice a PDS this run makes.
  const relayBefore = ids(['-q', 'relay']);
  const before = new Set(ids(['-aq']));

  // Every image the file builds is built before anything starts, so `up` never builds while
  // containers are being made (on a runner with no images, the relay and the other built services
  // were made, then made again by the next `up`, and Jetstream lost the relay between the two).
  // A group host built from a folder is the folder as it is now; Docker's cache makes an
  // unchanged image quick.
  const builds = facts('SG_BUILDS');
  // The images snowglobe publishes are pulled where the registry has the build of these very files
  // (lib/prebuilt.mjs); only the rest are built. Compose fills in the ${...} defaults (an image's
  // tag follows its commit); if it cannot say, everything is built, as before.
  let toBuild = [];
  try {
    const services = JSON.parse(compose(['config', '--format', 'json'], { stdio: 'pipe', encoding: 'utf8' }).stdout).services;
    const have = prebuilt({ root, services, env, log });
    toBuild = Object.keys(services).filter((s) => services[s].build && !have.includes(s));
  } catch {
    toBuild = [];
    compose(['build', '--quiet']);
  }
  if (toBuild.length) {
    log(`Building images${builds.length ? ` (${builds.join(' ')})` : ''}`);
    compose(['build', '--quiet', ...toBuild]);
  }

  // A rerun starts the PDSes with the authority they already have, so pass 1 changes nothing.
  composeEnv.SG_LEXICON_AUTHORITY_DID = envGet('LEX_AUTHORITY_DID', p.accounts);
  log(`Pass 1: up (project ${project})`);
  await upStack();
  // A running nginx keeps the certificate files it started with, and the template it was started
  // with (the image fills it in at start); new ones need a restart, whether or not the leaf was
  // reissued. The globe's servers may have changed with the render, so a running nginx reloads them.
  if (newCerts || templateChanged) {
    compose(['restart', 'nginx'], { stdio: 'ignore' });
    if (templateChanged) put(templateStamp, templateHash);
    // Its health check is nginx -t, which passes before it listens again, and the next step
    // reaches the PDSes through it.
    await waitServing(domain, { root, state, env });
  } else compose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload'], { stdio: 'ignore' });

  const authority = envGet('SG_AUTHORITY_PDS', p.globeEnv);
  const did = await account({ name: 'lex-authority', prefix: 'LEX_AUTHORITY', pds: authority, file: p.accounts, root, state, env, log });
  if (did !== composeEnv.SG_LEXICON_AUTHORITY_DID) {
    composeEnv.SG_LEXICON_AUTHORITY_DID = did;
    log(`Pass 2: up with the lexicon authority ${did}`);
    // Pass 2 recreates every PDS. Jetstream with no relay reads the first PDS itself and exits
    // while it is gone; on a slow machine (a CI runner) it was still restarting when compose
    // checked it, and up failed with "jetstream is unhealthy". Stopped first, it is started
    // again only once the PDS is healthy.
    const running = facts('SG_SERVICES');
    if (running.includes('jetstream') && !running.includes('relay')) compose(['stop', 'jetstream'], { stdio: 'ignore' });
    await upStack();
  }

  // A relay that was running when a PDS went away redials it with a growing backoff; a PDS
  // added back under that name was not crawled again until the relay restarted (2026-10-20: no
  // dial in the nine minutes after it came back). So when this run made a PDS container beside a
  // relay that was already running, the relay restarts, and the services wait for it again.
  if (relayBefore.length) {
    const fresh = facts('SG_PDS').find((x) => ids(['-q', `pds-${x}`]).some((id) => !before.has(id)));
    if (fresh) {
      log(`Restarting the relay: pds-${fresh} is new beside it`);
      compose(['restart', 'relay'], { stdio: 'ignore' });
      waitServices();
    }
  }

  // init's accounts are on the seed PDS; run maps their handles.
  for (const prefix of ['ALICE', 'BOB']) {
    const handle = envGet(`${prefix}_HANDLE`, p.accounts);
    if (handle) addName(handle, { root, state });
  }

  // What the file seeds. A rerun finds each account by its kept login.
  for (const a of seedAccounts) await account({ ...a, file: p.accounts, root, state, env, log });
  if (globe.lexicons.publish) await lexicons({ dir: resolve(dirname(path), globe.lexicons.publish), root, state, env, log });

  // Written by snowglobe up until snowglobe env replaced it; an app that still sources it would
  // read addresses that no longer follow the file.
  const denv = join(p.data, 'devnet.env');
  if (existsSync(denv)) {
    rmSync(denv);
    log(`Removed the old ${denv}; snowglobe env hands an app these settings now`);
  }

  // init leaves data/accounts.env and data/accounts.json world-readable on every up; both hold
  // logins.
  makePrivate(p.accounts);
  makePrivate(join(p.data, 'accounts.json'));

  log('');
  const ps = dc(project, ['ps', '--format', '{{.Service}} {{.State}} {{.Ports}}'], { root, state, stdio: 'pipe', encoding: 'utf8' });
  log(ps.stdout.trimEnd());
}

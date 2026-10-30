// The https globe a checked snowglobe.yml describes, as files: a compose file with every
// service, nginx's servers for the globe's names, the leaf certificate's names and the
// facts the snowglobe commands read. Pure: a globe (from config.mjs) and the base
// compose files in, file texts out. bin/snowglobe.mjs render writes them.
//
// Each PDS is a plain service on the compose network, pds-<name>, reached by that name, and so
// is each group host, grouphost-<name>. Nothing shares another's network namespace except
// Slingshot, which runs in slingshot-dns's for its DNS. Inside the network nginx also answers to
// every PDS's and group host's https name, so they, the relay and TAP reach each other over TLS
// as on the real network.
//
// The services the plain http stacks share (PLC, Postgres, maildev, Jetstream, TAP, init,
// the relay) start from their definitions in stack/docker-compose.yml, stack/docker-compose.test.yml and
// stack/docker-compose.relay.yml, so a change there reaches the globe too. What only the https
// globe runs is defined here.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { IMAGE_NAMES, RESERVED } from './config.mjs';
import { lookup, parseValue } from './settings.mjs';

// Every PDS listens on this port inside its own container, and every group host on the other.
export const PDS_PORT = 3000;
export const GROUPHOST_PORT = 7070;

const APP_NAMES = './stack/https/app-names.cjs:/https/app-names.cjs:ro';
const NETWORK = 'snowglobe';
const healthy = { condition: 'service_healthy' };

/**
 * A short hash of the files an image is built from (named by the caller: its Dockerfile and what
 * that COPYs), so the image is tagged by its source: a changed file is a new tag, which compose
 * builds, where a fixed tag it already has would be reused stale. Files the build never reads
 * (editor lock files, .DS_Store, tests) cannot change the tag or stop a render.
 */
export function contextHash(root, dir, files) {
  const h = createHash('sha256');
  for (const f of [...files].sort()) h.update(`${f}\0`).update(readFileSync(join(root, dir, f))).update('\0');
  return h.digest('hex').slice(0, 12);
}

// Each image snowglobe builds from its own folder: its folder and the files its Dockerfile uses.
const BUILT = {
  'snowglobe-dns': ['stack/https/dns', ['Dockerfile', 'dns.sh']],
  'snowglobe-proxy': ['stack/https/proxy', ['Dockerfile', 'server.mjs']],
  'snowglobe-pdsls': ['stack/pdsls', ['Dockerfile', 'network.patch', 'server.mjs']],
  'snowglobe-jetstream': ['stack/jetstream', ['Dockerfile']],
};

/** The base compose files' services, which the globe's shared services start from. */
export function loadBase(root) {
  // logLevel: the http overlays' !reset and !override tags are on services not read here.
  const services = (f) => parse(readFileSync(join(root, f), 'utf8'), { logLevel: 'error' }).services;
  return {
    base: services('stack/docker-compose.yml'),
    test: services('stack/docker-compose.test.yml'),
    relay: services('stack/docker-compose.relay.yml'),
    // The tags of the images snowglobe builds from its own folders (see contextHash).
    tags: Object.fromEntries(Object.entries(BUILT).map(([k, [dir, files]]) => [k, `${k}:${contextHash(root, dir, files)}`])),
  };
}

/** TAP's settings from services.tap's map: where it sends events and which collection it follows. */
function tapSettings(globe) {
  const t = globe.tap;
  if (!t) return {};
  const webhook = t.webhook && parseValue(t.webhook).parts.map((x) => (x.text !== undefined ? x.text : lookup(globe, x.name).value)).join('');
  return {
    ...(webhook && { TAP_WEBHOOK_URL: webhook }),
    ...(t.signal_collection && { TAP_SIGNAL_COLLECTION: t.signal_collection }),
    ...(t.collection_filters.length && { TAP_COLLECTION_FILTERS: t.collection_filters.join(',') }),
  };
}

/**
 * Render a checked globe. stateDir is the snowglobe's state folder (an absolute path): the
 * compose file mounts the CA (in ca/ beside it), the leaf and nginx's routes from it, and init
 * writes the logins into it. globeDir is where the files will be, an absolute path, or relative
 * to the compose project directory (the repo root), because the compose file mounts nginx's part
 * of it. Returns { '<path under globeDir>': text }.
 */
export function renderGlobe(globe, base, { stateDir, globeDir = join(stateDir ?? '', 'globe'), source = 'snowglobe.yml' } = {}) {
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('renderGlobe needs stateDir, the snowglobe\'s state folder, as an absolute path');
  const https = (f) => join(stateDir, 'https', f);
  const caFile = join(dirname(stateDir), 'ca', 'ca.crt');
  const CA = `${caFile}:/https/ca.crt:ro`;
  // Go reads every file in /etc/ssl/certs on top of its bundle, so the public roots stay.
  const GO_CA = `${caFile}:/etc/ssl/certs/snowglobe-ca.pem:ro`;
  const D = globe.domain;
  const svc = (p) => `pds-${p.name}`;
  const host = (p) => `${p.name}.${D}`;
  const handleDomain = (p) => (p.bare_handles ? `.${D}` : `.${p.name}.${D}`);
  const handleWildcard = (p) => `*${handleDomain(p)}`;
  // A group host is <name>.<domain>, and its groups' handles are <group>.<name>.<domain>.
  const ghSvc = (g) => `grouphost-${g.name}`;
  const ghUrl = (g) => `http://${ghSvc(g)}:${GROUPHOST_PORT}`;
  const unsourced = globe.grouphosts.filter((g) => !g.image && !g.build).map((g) => g.name);
  if (unsourced.length) throw new Error(`no image or build folder for the group host(s) ${unsourced.join(', ')} (config.mjs withGroupHostSources)`);
  // init seeds alice, bob and the invite code on the PDS with bare handles, else the first.
  const seed = globe.pds.find((p) => p.bare_handles) ?? globe.pds[0];
  const on = globe.services;
  // Where Jetstream and TAP read: the relay, or with one PDS and no relay, that PDS's own
  // firehose (TAP only: Jetstream always has the relay, see config.mjs).
  const feed = on.relay ? 'http://relay:2470' : `http://${svc(globe.pds[0])}:${PDS_PORT}`;
  const copy = (o) => structuredClone(o);

  const services = {};

  services.postgres = {
    ...copy(base.test.postgres),
    // The PLC's database, named, so a `down` without -v keeps every DID.
    volumes: ['plc-db:/var/lib/postgresql/data'],
  };
  delete services.postgres.ports;

  services.maildev = {
    ...copy(base.test.maildev),
    ports: [
      '${SG_BIND:-127.0.0.1}:${SG_MAILDEV_WEB_PORT:-1081}:1080',
      '${SG_BIND:-127.0.0.1}:${SG_MAILDEV_SMTP_PORT:-1026}:1025',
    ],
  };

  services.plc = {
    ...copy(base.base.plc),
    depends_on: { postgres: healthy },
    ports: ['${SG_BIND:-127.0.0.1}:${SG_PLC_PORT:-2582}:2582'],
  };

  const pdsBase = base.base.pds;
  for (const p of globe.pds) {
    services[svc(p)] = {
      image: p.image,
      // Release images run as root; monorepo images run as `node`, which cannot open the
      // root-owned data volume.
      user: 'root',
      restart: 'unless-stopped',
      depends_on: { plc: healthy },
      environment: {
        // The AppView, report service, secrets and logging as docker-compose.yml has them.
        ...copy(pdsBase.environment),
        PDS_PORT: String(PDS_PORT),
        PDS_HOSTNAME: host(p),
        PDS_SERVICE_DID: `did:web:${host(p)}`,
        PDS_SERVICE_HANDLE_DOMAINS: handleDomain(p),
        PDS_HANDLE_DOMAINS: handleDomain(p),
        PDS_INVITE_REQUIRED: p.invites === 'required' ? 'true' : 'false',
        PDS_EMAIL_SMTP_URL: 'smtp://maildev:1025',
        PDS_EMAIL_FROM_ADDRESS: `noreply@${D}`,
        PDS_LEXICON_AUTHORITY_DID: '${SG_LEXICON_AUTHORITY_DID:-}',
        // The public URL is https, so each PDS runs as it would on the real network.
        PDS_DEV_MODE: 'false',
        // Every address a PDS fetches from here (nginx, the PLC, this machine) is an RFC
        // 1918 one, which the SSRF-protected fetch would refuse.
        PDS_DISABLE_SSRF_PROTECTION: 'true',
        NODE_EXTRA_CA_CERTS: '/https/ca.crt',
        // <name>.app.<domain> resolves to nginx inside each PDS (https/app-names.cjs).
        SG_RESOLVE_DOMAIN: `app.${D}`,
        NODE_OPTIONS: '--require /https/app-names.cjs',
      },
      volumes: [`${svc(p)}-data:/pds/data`, CA, APP_NAMES],
      networks: [NETWORK],
      healthcheck: { ...copy(pdsBase.healthcheck), test: ['CMD', 'wget', '-q', '--spider', `http://127.0.0.1:${PDS_PORT}/xrpc/_health`] },
    };
  }

  // Group hosts, of kind opensocial (atproto-group-host): @atproto/pds run as a library, with
  // the group routes on top, so its settings are a PDS's. It makes its groups' accounts itself,
  // so sign-up takes no code. A second kind would render its own service here.
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  for (const g of globe.grouphosts) {
    services[ghSvc(g)] = {
      // Built from the folder (a checkout, with its own Dockerfile) on every up; compose names
      // the image after the project and the service.
      ...(g.image ? { image: g.image } : { build: { context: g.build } }),
      user: 'root',
      restart: 'unless-stopped',
      depends_on: { plc: healthy },
      environment: {
        // The AppView, report service and secrets as every PDS here has them.
        ...pick(pdsBase.environment, [
          'PDS_BSKY_APP_VIEW_URL', 'PDS_BSKY_APP_VIEW_DID', 'PDS_REPORT_SERVICE_URL', 'PDS_REPORT_SERVICE_DID',
          'PDS_ADMIN_PASSWORD', 'PDS_JWT_SECRET', 'PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX',
        ]),
        PDS_PORT: String(GROUPHOST_PORT),
        PDS_HOSTNAME: host(g),
        PDS_SERVICE_HANDLE_DOMAINS: `.${host(g)}`,
        PDS_DATA_DIRECTORY: '/data',
        PDS_BLOBSTORE_DISK_LOCATION: '/data/blocks',
        PDS_DID_PLC_URL: 'http://plc:2582',
        PDS_CRAWLERS: '',
        PDS_INVITE_REQUIRED: 'false',
        PDS_LEXICON_AUTHORITY_DID: '${SG_LEXICON_AUTHORITY_DID:-}',
        PDS_DEV_MODE: 'false',
        PDS_DISABLE_SSRF_PROTECTION: 'true',
        LOG_ENABLED: 'true',
        LOG_LEVEL: 'info',
        NODE_ENV: 'development',
        // Its own URL (and so its did:web), how it calls its own PDS, and the PLC it reads.
        HOST_PUBLIC_URL: `https://${host(g)}`,
        HOST_LOOPBACK_URL: `http://127.0.0.1:${GROUPHOST_PORT}`,
        HOST_PLC_URL: 'http://plc:2582',
        NODE_EXTRA_CA_CERTS: '/https/ca.crt',
        // Every name under the domain, its members' handles too, resolves to nginx.
        NODE_OPTIONS: '--require /https/app-names.cjs',
        SG_RESOLVE_DOMAIN: D,
      },
      volumes: [`${ghSvc(g)}-data:/data`, CA, APP_NAMES],
      networks: [NETWORK],
      healthcheck: {
        test: ['CMD', 'node', '-e', `fetch('http://127.0.0.1:${GROUPHOST_PORT}/xrpc/_health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  }

  if (on.relay) {
    const relay = copy(base.relay.relay);
    delete relay.network_mode;
    // Every host is a wss:// one.
    delete relay.environment.RELAY_ALLOW_INSECURE_HOSTS;
    services.relay = {
      ...relay,
      // Its own tag, so an image built from an older relay/ patch is never reused.
      image: 'snowglobe-relay:https-${SG_RELAY_INDIGO_COMMIT:-b2619d864df00a66455bd9f5f0c83c1ac13ad73d}',
      depends_on: { nginx: healthy },
      volumes: [...relay.volumes, GO_CA],
      networks: [NETWORK],
    };
    // The relay adds a host only through its admin API, so a PDS cannot register itself with
    // requestCrawl. Bare names are https/wss hosts to the relay.
    services['relay-init'] = {
      image: 'alpine:3.20',
      depends_on: { relay: healthy, nginx: healthy, ...Object.fromEntries(globe.pds.map((p) => [svc(p), healthy])) },
      environment: {
        RELAY_ADMIN_PASSWORD: base.relay.relay.environment.RELAY_ADMIN_PASSWORD,
        RELAY_HOSTS: globe.pds.map(host).join(' '),
      },
      entrypoint: '/bin/sh',
      command: [
        '-c',
        [
          'set -eu',
          'apk add --no-cache curl >/dev/null 2>&1',
          'for host in $$RELAY_HOSTS; do',
          '  echo "[relay-init] crawl $$host"',
          '  curl -sf -u "admin:$$RELAY_ADMIN_PASSWORD" -H "Content-Type: application/json" \\',
          '    -d "{\\"hostname\\": \\"$$host\\"}" http://relay:2470/admin/pds/requestCrawl',
          '  echo',
          'done',
          '',
        ].join('\n'),
      ],
      networks: [NETWORK],
      restart: 'no',
    };
  }

  if (on.jetstream) {
    // Its first backfill asks each PDS for its repos at the PDS's https name, through nginx.
    services.jetstream = {
      ...copy(base.base.jetstream),
      build: './stack/jetstream',
      image: base.tags['snowglobe-jetstream'],
      depends_on: { relay: healthy },
      environment: { ...copy(base.base.jetstream.environment), JETSTREAM_RELAY_URL: feed },
      volumes: [...base.base.jetstream.volumes, GO_CA],
      ports: [
        '${SG_BIND:-127.0.0.1}:${SG_JETSTREAM_PORT:-6008}:6008',
        '${SG_BIND:-127.0.0.1}:${SG_JETSTREAM_METRICS_PORT:-6009}:6009',
      ],
    };
  }

  if (on.tap) {
    // TAP runs in tap-dns's network namespace, whose DNS answers every name under the domain with
    // nginx: so it reaches the webhook's app and checks a handle at its https name. It follows the
    // stream and finds an account when it writes in the signal collection; its crawl of the
    // collection's repos is refused by the PDS (HTTP 401) and finds none.
    services.tap = {
      ...copy(base.base.tap),
      depends_on: on.relay ? { relay: healthy } : { [svc(globe.pds[0])]: healthy },
      environment: { ...copy(base.base.tap.environment), TAP_RELAY_URL: feed, ...tapSettings(globe) },
      volumes: [...base.base.tap.volumes, GO_CA],
      network_mode: 'service:tap-dns',
      depends_on: { 'tap-dns': { condition: 'service_started' }, ...(on.relay ? { relay: healthy } : { [svc(globe.pds[0])]: healthy }) },
    };
    delete services.tap.networks;
    delete services.tap.ports;
  }

  // init seeds alice and bob (data/accounts.env) on the seed PDS, under its handle domain.
  // init.sh names http://pds:3000, so it is pointed at the seed PDS's service.
  services.init = {
    ...copy(base.base.init),
    depends_on: { [svc(seed)]: healthy, plc: healthy },
    environment: {
      ...copy(base.base.init.environment),
      PDS_HOSTNAME: host(seed),
      HANDLE_DOMAIN: handleDomain(seed),
      SG_DOMAIN: D,
    },
    // The logins init writes go to the snowglobe's state folder, not the checkout's data/.
    volumes: ['./stack/init:/scripts:ro', `${stateDir}:/devnet-data`],
    entrypoint: '/bin/sh',
    command: ['-c', `sed "s#http://pds:3000#http://${svc(seed)}:${PDS_PORT}#" /scripts/init.sh > /tmp/init.sh && sh /tmp/init.sh`],
  };

  services.nginx = {
    image: 'nginx:1.30-alpine',
    restart: 'unless-stopped',
    depends_on: { plc: healthy, ...Object.fromEntries(globe.pds.map((p) => [svc(p), healthy])) },
    ports: ['${SG_BIND:-127.0.0.1}:443:443'],
    extra_hosts: [
      // This machine, where an app registered with bin/snowglobe.mjs app listens.
      'host.docker.internal:host-gateway',
    ],
    environment: {
      // The image fills ${SG_DOMAIN} into the template at start, and only names starting
      // SG_, so nginx's own $host and the like are left alone.
      SG_DOMAIN: D,
      NGINX_ENVSUBST_FILTER: '^SG_',
    },
    volumes: [
      './stack/https/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro',
      `${https('leaf.crt')}:/etc/nginx/https/leaf.crt:ro`,
      `${https('leaf.key')}:/etc/nginx/https/leaf.key:ro`,
      // The app routes and the page's snowglobe.json, which bin/snowglobe.mjs app writes (a
      // directory, so a rewrite shows up).
      `${https('nginx')}:/etc/nginx/snowglobe:ro`,
      // The globe's own servers and the page's relays to its PDSes, rendered here.
      `${isAbsolute(globeDir) ? globeDir : `./${globeDir}`}/nginx:/etc/nginx/globe:ro`,
      // The network's page, the one a hosted globe serves, and its relays.
      './stack/page/index.html:/srv/page/index.html:ro',
      './stack/page/fonts:/srv/page/fonts:ro',
      './stack/page/snowglobe.conf:/etc/nginx/page/snowglobe.conf:ro',
    ],
    networks: {
      // Inside the network every PDS's and group host's https name is nginx, so they, the relay
      // and TAP reach each other over TLS at their public URLs.
      [NETWORK]: { aliases: [...globe.pds.map(host), ...globe.grouphosts.map(host)] },
    },
    healthcheck: { test: ['CMD', 'nginx', '-t', '-q'], interval: '5s', timeout: '3s', retries: 10 },
  };

  if (on.tap) {
    services['tap-dns'] = {
      build: './stack/https/dns',
      image: base.tags['snowglobe-dns'],
      restart: 'unless-stopped',
      environment: { SG_DOMAIN: D },
      dns: ['127.0.0.1'],
      depends_on: { nginx: healthy },
      ports: ['${SG_BIND:-127.0.0.1}:${SG_TAP_PORT:-2480}:2480'],
      networks: [NETWORK],
    };
  }

  if (on.slingshot) {
    // Slingshot (microcosm-rs) answers com.bad-example.identity.resolveMiniDoc, a handle's DID
    // and PDS, from this globe's PLC and Jetstream. It reaches the handles' names over TLS,
    // which needs the CA as its only root and a DNS that answers any name under the domain:
    // slingshot-dns, whose network namespace it runs in, so nginx reaches it as slingshot-dns:8080.
    services['slingshot-dns'] = {
      build: './stack/https/dns',
      image: base.tags['snowglobe-dns'],
      restart: 'unless-stopped',
      environment: { SG_DOMAIN: D },
      dns: ['127.0.0.1'],
      depends_on: { nginx: healthy },
      networks: [NETWORK],
    };
    services.slingshot = {
      // SG_SLINGSHOT_COMMIT is a full microcosm-rs commit: it picks what is built and names
      // the image, so the tag is always the source.
      build: {
        context: './stack/slingshot',
        args: { MICROCOSM_COMMIT: '${SG_SLINGSHOT_COMMIT:-3137b07d5268812d2de0f3177664be92196994d8}' },
      },
      image: 'snowglobe-slingshot:${SG_SLINGSHOT_COMMIT:-3137b07d5268812d2de0f3177664be92196994d8}',
      restart: 'unless-stopped',
      network_mode: 'service:slingshot-dns',
      depends_on: { 'slingshot-dns': { condition: 'service_started' }, plc: healthy, jetstream: healthy },
      environment: {
        SLINGSHOT_PLC_DIRECTORY: 'http://plc:2582',
        SLINGSHOT_JETSTREAM: 'ws://jetstream:6008/subscribe',
        SLINGSHOT_CACHE_DIR: '/data',
        SLINGSHOT_BIND: '0.0.0.0:8080',
        // The CA is the only root; the names it reaches are all the globe's.
        SSL_CERT_FILE: '/https/ca.crt',
      },
      volumes: [CA, 'slingshot-data:/data'],
      // A Docker host may start a container at 1024 open files; on one, slingshot stopped with
      // "too many open files" (2026-10-20). Its own limit makes it independent of the host.
      ulimits: { nofile: { soft: 65536, hard: 65536 } },
      healthcheck: { test: ['CMD-SHELL', "bash -c 'echo > /dev/tcp/127.0.0.1/8080'"], interval: '5s', timeout: '3s', retries: 10 },
    };
  }

  // A browser on another computer reaches the globe through this, with no launch flags and no
  // hosts file: http://127.0.0.1:<SG_PROXY_PORT>/proxy.pac sends the globe's names here (HTTP
  // CONNECT, or SOCKS5), and the proxy sends each to nginx and refuses everything else
  // (https/proxy/server.mjs). Forward the port to the browser's machine.
  services.proxy = {
    build: './stack/https/proxy',
    image: base.tags['snowglobe-proxy'],
    restart: 'unless-stopped',
    depends_on: { nginx: healthy },
    environment: { PROXY_DOMAIN: D, PROXY_UPSTREAM: 'nginx:443' },
    ports: ['${SG_BIND:-127.0.0.1}:${SG_PROXY_PORT:-1080}:1080'],
    networks: [NETWORK],
    healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:1080/_health'], interval: '5s', timeout: '3s', retries: 10 },
  };

  if (on.pdsls) {
    // PDSls, the record browser apps link to, at pdsls.<domain>: built from a pinned commit with
    // pdsls/network.patch and given this globe's addresses by pdsls/server.mjs, which also answers
    // its handle and did:web lookups through nginx, for names under the domain only.
    services.pdsls = {
      build: './stack/pdsls',
      image: base.tags['snowglobe-pdsls'],
      restart: 'unless-stopped',
      depends_on: { nginx: healthy },
      environment: {
        PDSLS_PUBLIC_URL: `https://pdsls.${D}`,
        PDSLS_DOMAIN: D,
        PDSLS_PLC_URL: `https://plc.${D}`,
        PDSLS_JETSTREAM_URL: on.jetstream ? `wss://jetstream.${D}/subscribe` : '',
        PDSLS_FIREHOSE_URL: on.relay ? `wss://relay.${D}` : `wss://${host(globe.pds[0])}`,
        PDSLS_LEXICON_AUTHORITY: '${SG_LEXICON_AUTHORITY_DID:-}',
        PDSLS_UPSTREAM: 'nginx:443',
        NODE_EXTRA_CA_CERTS: '/https/ca.crt',
      },
      volumes: [CA],
      networks: [NETWORK],
      healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/_health'], interval: '5s', timeout: '3s', retries: 10 },
    };
  }

  const volumes = { 'plc-db': null };
  for (const p of globe.pds) volumes[`${svc(p)}-data`] = null;
  for (const g of globe.grouphosts) volumes[`${ghSvc(g)}-data`] = null;
  if (on.relay) volumes['relay-data'] = null;
  if (on.jetstream) volumes['jetstream-data'] = null;
  if (on.tap) volumes['tap-data'] = null;
  if (on.slingshot) volumes['slingshot-data'] = null;

  // Services copied from the plain stack's compose files name that stack's network.
  for (const s of Object.values(services)) {
    if (Array.isArray(s.networks)) s.networks = s.networks.map((n) => (n === 'atproto-devnet' ? NETWORK : n));
  }

  const header = (c) =>
    `${c} Written by snowglobe render from ${source}; render again instead of editing.\n`;

  const compose =
    header('#') +
    `# The https globe "${globe.globe}" at ${D}: ${globe.pds.map((p) => p.name).join(', ')}` +
    (globe.grouphosts.length ? `; group hosts ${globe.grouphosts.map((g) => g.name).join(', ')}` : '') +
    '.\n' +
    '# Run it with snowglobe up, which renders this file first.\n\n' +
    // YAML 1.1 quoting, so a value such as restart's "no" stays a string to compose.
    stringify({ services, volumes, networks: { [NETWORK]: null } }, { lineWidth: 0, nullStr: '', aliasDuplicateObjects: false, version: '1.1' });

  // nginx: one server per PDS and per group host for its name and its handles, then the globe's
  // services. Of two matching wildcards nginx takes the longer, so *.<pds>.<domain> wins over *.<domain>. A
  // variable upstream is looked up on each request, so a recreated container is found.
  const server = (names, upstream) =>
    `server {\n    listen 443 ssl;\n    server_name ${names};\n    location / {\n        set $upstream ${upstream};\n        proxy_pass $upstream;\n    }\n}\n`;
  const servers = [
    ...globe.pds.map((p) => `# ${p.name}: the PDS and every handle under ${handleDomain(p).slice(1)}.\n` + server(`${host(p)} ${handleWildcard(p)}`, `http://${svc(p)}:${PDS_PORT}`)),
    ...globe.grouphosts.map((g) => `# ${g.name}: the group host and every group's handle under ${host(g)}.\n` + server(`${host(g)} *.${host(g)}`, ghUrl(g))),
    // The relay and the feed at https names, as a hosted globe has them, so an app's browser
    // code, which cannot use plain http or the host's ports, reaches them too.
    on.relay && server(`relay.${D}`, 'http://relay:2470'),
    on.jetstream && server(`jetstream.${D}`, 'http://jetstream:6008'),
    on.slingshot && server(`slingshot.${D}`, 'http://slingshot-dns:8080'),
    on.pdsls && server(`pdsls.${D}`, 'http://pdsls:8080'),
  ].filter(Boolean);
  const globeConf = header('#') + '\n' + servers.join('\n');

  // The page's relays to each PDS and group host (page/snowglobe.conf includes this). /health/pds
  // and /people/ are the seed PDS's, as the page's snowglobe.json names them.
  const u = (p) => `$pds_${p.name.replace(/-/g, '_')}`;
  const ug = (g) => `$gh_${g.name.replace(/-/g, '_')}`;
  const pageInc =
    header('#') +
    '\n' +
    globe.pds.map((p) => `set ${u(p)} http://${svc(p)}:${PDS_PORT};\n`).join('') +
    globe.grouphosts.map((g) => `set ${ug(g)} ${ghUrl(g)};\n`).join('') +
    '\n' +
    [
      `location = /health/pds { proxy_pass ${u(seed)}/xrpc/_health; }`,
      `location = /people/listRepos { proxy_pass ${u(seed)}/xrpc/com.atproto.sync.listRepos$is_args$args; }`,
      `location = /people/describeRepo { proxy_pass ${u(seed)}/xrpc/com.atproto.repo.describeRepo$is_args$args; }`,
      ...globe.pds.flatMap((p) => [
        `location = /health/${p.name} { proxy_pass ${u(p)}/xrpc/_health; }`,
        `location = /people/${p.name}/listRepos { proxy_pass ${u(p)}/xrpc/com.atproto.sync.listRepos$is_args$args; }`,
        `location = /people/${p.name}/describeRepo { proxy_pass ${u(p)}/xrpc/com.atproto.repo.describeRepo$is_args$args; }`,
      ]),
      ...globe.grouphosts.flatMap((g) => [
        `location = /health/${g.name} { proxy_pass ${ug(g)}/xrpc/_health; }`,
        `location = /groups/${g.name}/listRepos { proxy_pass ${ug(g)}/xrpc/com.atproto.sync.listRepos$is_args$args; }`,
        `location = /groups/${g.name}/describeRepo { proxy_pass ${ug(g)}/xrpc/com.atproto.repo.describeRepo$is_args$args; }`,
      ]),
    ].join('\n') +
    '\n';

  // The network page's facts (page/index.html reads them as snowglobe.json): every PDS, with its
  // health relay and account list above, each group host with its groups, and each service the
  // globe runs. bin/snowglobe.mjs app adds the routed apps and writes snowglobe.json.
  const shortImage = (image) => {
    const named = Object.entries(IMAGE_NAMES).find(([, ref]) => ref === image)?.[0];
    return named ?? image.split('/').pop().replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@sha256:$1…');
  };
  // What the globe is made of, as the page's first line names it: only what runs.
  const parts = [globe.pds.length === 1 ? 'PDS' : 'PDSs', 'PLC directory', on.relay && 'relay', on.jetstream && 'Jetstream'].filter(Boolean);
  const page = {
    globe: globe.globe,
    domain: D,
    about:
      `An atproto network on this machine: its own ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}. Its accounts live in its own directory, not the public one, so Bluesky cannot find anything here. An app is handed this network's addresses (snowglobe env), not Bluesky's.`,
    accountsNote:
      `Every account on the network, on each of its ${globe.pds.length} PDS${globe.pds.length === 1 ? '' : 's'}` +
      (globe.grouphosts.length ? `, and every group on its group host${globe.grouphosts.length === 1 ? '' : 's'}.` : '.'),
    // Without Jetstream the page has no feed to follow, and says so instead of reconnecting.
    feed: on.jetstream ? '/subscribe' : false,
    services: [
      ...globe.pds.map((p) => [
        'PDS',
        p.name,
        p.name,
        `Handles under ${handleDomain(p).slice(1)}${p.invites === 'required' ? ', by invite' : ''} (${shortImage(p.image)})`,
      ]),
      ...globe.grouphosts.map((g) => [
        'Group host',
        g.name,
        g.name,
        `Holds groups, which are accounts of their own, with handles under ${host(g)} (${g.image ? shortImage(g.image) : 'built locally'})`,
      ]),
      ['PLC directory', 'plc', 'plc', 'Resolves each did:plc to its keys and PDS; also plc.directory under snowglobe run'],
      on.relay && ['Relay', 'relay', 'relay', "Crawls each PDS and merges their changes into one firehose"],
      on.jetstream && ['Jetstream', 'jetstream', 'jetstream', "The relay's firehose as JSON, for apps (and this page)"],
      on.slingshot && ['Slingshot', 'slingshot', 'slingshot', 'Resolves handles, DIDs and records from this network only'],
      on.tap && ['Tap', '', 'sync', 'Syncs and backfills repos'],
      ['Mail', '', 'mail', 'Catches every message the PDSs send'],
      on.pdsls && ['PDSls', 'pdsls', 'pdsls', "Browses this network's repos and records"],
    ].filter(Boolean),
    accounts: [
      ...globe.pds.map((p) => [`/people/${p.name}`, `person, ${p.name}`]),
      ...globe.grouphosts.map((g) => [`/groups/${g.name}`, `group, ${g.name}`]),
    ],
    // Links on the page before the routed apps.
    apps: on.pdsls ? [{ name: 'pdsls', url: `https://pdsls.${D}` }] : [],
  };

  // The leaf names everything above answers to; a TLS wildcard covers one label, so each handle
  // domain has its own. lib/certs.mjs adds the apps' endings.
  const leafNames = [
    D,
    ...globe.pds.flatMap((p) => [host(p), handleWildcard(p)]),
    ...globe.grouphosts.flatMap((g) => [host(g), `*.${host(g)}`]),
    `plc.${D}`,
    on.relay && `relay.${D}`,
    on.jetstream && `jetstream.${D}`,
    on.slingshot && `slingshot.${D}`,
    on.pdsls && `pdsls.${D}`,
    'plc.directory',
    `*.app.${D}`,
  ].filter(Boolean);

  // The services snowglobe up waits on: the one-shots to finish, the rest to be healthy.
  const oneShots = ['init', on.relay && 'relay-init'].filter(Boolean);
  const globeEnv = [
    header('#').trimEnd(),
    '# The globe\'s facts for the snowglobe commands. Nothing secret.',
    `SG_GLOBE=${globe.globe}`,
    `SG_DOMAIN=${D}`,
    `SG_PDS=${globe.pds.map((p) => p.name).join(' ')}`,
    `SG_SEED_PDS=${seed.name}`,
    `SG_GROUPHOSTS=${globe.grouphosts.map((g) => g.name).join(' ')}`,
    // The services up builds before it starts them: each group host built from a folder.
    `SG_BUILDS=${globe.grouphosts.filter((g) => !g.image).map(ghSvc).join(' ')}`,
    // The PDS whose handles are <name>.<domain> (empty if none), the PDSes that take an invite
    // code, and every name under the domain a bare handle would take (bin/snowglobe.mjs account).
    `SG_BARE_PDS=${globe.pds.find((p) => p.bare_handles)?.name ?? ''}`,
    `SG_INVITE_PDS=${globe.pds.filter((p) => p.invites === 'required').map((p) => p.name).join(' ')}`,
    `SG_TAKEN=${[...RESERVED, ...globe.pds.map((p) => p.name), ...globe.grouphosts.map((g) => g.name), ...globe.apps.map((a) => a.local?.handles).filter(Boolean)].join(' ')}`,
    `SG_AUTHORITY_PDS=${globe.lexicons.authority}`,
    `SG_ONESHOTS=${oneShots.join(' ')}`,
    `SG_SERVICES=${Object.keys(services).filter((s) => !oneShots.includes(s)).join(' ')}`,
    '',
  ].join('\n');

  return {
    'compose.yml': compose,
    'nginx/globe.conf': globeConf,
    'nginx/page.inc': pageInc,
    'leaf-names': leafNames.join('\n') + '\n',
    'globe.env': globeEnv,
    'page.json': JSON.stringify(page, null, 2) + '\n',
  };
}

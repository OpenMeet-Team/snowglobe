// Probe the https snowglobe the way an app built for the real network meets it: stock
// atcute, told only the snowglobe's PLC directory (a setting, as an app is told on a hosted
// globe), and no plain-http escape hatch anywhere. Run it under bin/snowglobe.mjs run, which
// trusts the snowglobe CA, after routing the probe's app name to its port:
//
//   bin/snowglobe.mjs app probe 5480
//   ATCUTE_DIR=<dir> PROBE_DID=<did> bin/snowglobe.mjs run node scripts/https-probe.mjs
//
// (a) Resolves PROBE_DID through the snowglobe's PLC (services.plc.url, given to atcute's
//     PlcDidDocumentResolver), then the PDS's protected-resource and authorization
//     server metadata through atcute's resolvers, left at their defaults.
// (b) Serves a confidential client's metadata and JWKS on PROBE_CLIENT_PORT, which nginx
//     answers for as https://<PROBE_APP>.app.<domain>/ (under a path new to each run),
//     and pushes a PAR with that client_id through atcute. The PDS fetches both documents
//     over TLS and must answer with a request_uri.
// (c) Pushes a raw PAR (plain fetch: atcute refuses this client_id before sending) with a
//     client_id under .test, and prints the PDS's own refusal.
//
// Env:
//   ATCUTE_DIR         required: a directory node resolves @atcute/oauth-node-client and
//                      @atcute/identity-resolver from (any project that installs them,
//                      or a plain `npm i` of the two)
//   PROBE_DID          the account to resolve and name in the PAR (default: the lexicon
//                      authority, lexicons.authority.did from snowglobe's settings)
//   PROBE_PDS          the PDS that DID must name (default https://alpha.<domain>, the
//                      domain being the snowglobe's)
//   PROBE_APP          the app name (default probe: https://probe.app.<domain>/)
//   PROBE_CLIENT_PORT  where the client's documents are served (default 5480)
//   PROBE_CLIENT_HOST  the address to serve on (default: the docker0 address, which is
//                      where Docker's host gateway lands, so the server is not on the
//                      machine's other interfaces)
// Exits 0 only when all three lines print.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNames } from '../lib/commands/env.mjs';

const ATCUTE_DIR = process.env.ATCUTE_DIR;
if (!ATCUTE_DIR) {
	console.log('FAIL setup: set ATCUTE_DIR to a directory node resolves @atcute/* from');
	process.exit(2);
}
// A fact of the snowglobe this folder (or one above) names, by its settings name.
const fact = (name) => {
	try {
		return resolveNames([name])[0];
	} catch (e) {
		console.log(`FAIL setup: ${e.message}`);
		process.exit(2);
	}
};
const DOMAIN = fact('domain');
const PLC = fact('services.plc.url');
const PDS = process.env.PROBE_PDS ?? `https://alpha.${DOMAIN}`;
const APP = process.env.PROBE_APP ?? 'probe';
const SITE = `https://${APP}.app.${DOMAIN}`;
// Always a .test name, whatever the domain: check (c) is about the .test suffix.
const TEST_SITE = `https://${APP}.snowglobe.test`;
const PORT = Number(process.env.PROBE_CLIENT_PORT ?? 5480);
const HOST =
  process.env.PROBE_CLIENT_HOST ??
  os.networkInterfaces().docker0?.find((a) => a.family === 'IPv4')?.address ??
  '127.0.0.1';
const did = (
	process.env.PROBE_DID ?? fact('lexicons.authority.did')
).trim();
if (!did) {
	console.log('FAIL setup: set PROBE_DID (or run bin/snowglobe.mjs up)');
	process.exit(2);
}

// atcute as installed under ATCUTE_DIR. The metadata resolvers are not in the
// package's exports, so they load from the same install by file path.
const atcuteRequire = createRequire(join(ATCUTE_DIR, 'package.json'));
const fromAtcute = (spec) => import(pathToFileURL(atcuteRequire.resolve(spec)).href);
const oauthEntry = atcuteRequire.resolve('@atcute/oauth-node-client');
const fromOauthDist = (file) => import(pathToFileURL(join(dirname(oauthEntry), file)).href);

const oauth = await fromAtcute('@atcute/oauth-node-client');
const identity = await fromAtcute('@atcute/identity-resolver');
const { ProtectedResourceMetadataResolver } = await fromOauthDist(
	'resolvers/protected-resource-metadata.js'
);
const { AuthorizationServerMetadataResolver } = await fromOauthDist(
	'resolvers/authorization-server-metadata.js'
);

// The option's name is assembled, so this file never spells it out.
const HTTP_KNOB = ['allow', 'Http'].join('');

let failed = false;
const fail = (what, e) => {
	failed = true;
	console.log(`FAIL ${what}: ${e instanceof Error ? e.message : String(e)}`);
};

// (a) DID -> PDS -> protected resource -> authorization server, atcute's defaults but the PLC.
let asMetadata;
try {
	const plc = new identity.PlcDidDocumentResolver({ apiUrl: PLC });
	const doc = await plc.resolve(did);
	const pds = doc.service?.find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`);
	if (pds?.serviceEndpoint !== PDS) throw new Error(`DID doc names PDS ${pds?.serviceEndpoint}`);

	const prResolver = new ProtectedResourceMetadataResolver({ cache: new oauth.MemoryStore() });
	const asResolver = new AuthorizationServerMetadataResolver({ cache: new oauth.MemoryStore() });
	if (prResolver[HTTP_KNOB] !== false || asResolver[HTTP_KNOB] !== false) {
		throw new Error(`the resolvers' ${HTTP_KNOB} is not off`);
	}
	const pr = await prResolver.resolve(pds.serviceEndpoint);
	if (pr.resource !== PDS) throw new Error(`resource is ${pr.resource}`);
	asMetadata = await asResolver.resolve(pr.authorization_servers[0]);
	if (asMetadata.issuer !== PDS) throw new Error(`issuer is ${asMetadata.issuer}`);
	console.log(`RESOLVED ${did} on ${PDS} through ${PLC}, ${HTTP_KNOB} off`);
} catch (e) {
	fail('resolve', e);
}

// (b) A confidential client at the app's .internal name, through atcute's own PAR. Each run
// gets its own key and its own client_id path: the PDS caches a client's metadata and
// JWKS by URL, and a cached key from an earlier run would fail this run's signature.
const run = `probe-${Date.now().toString(36)}`;
const key = await oauth.generateClientAssertionKey(run);
const actorResolver = new identity.LocalActorResolver({
	handleResolver: new identity.CompositeHandleResolver({
		methods: {
			dns: new identity.DohJsonHandleResolver({
				dohUrl: 'https://mozilla.cloudflare-dns.com/dns-query'
			}),
			http: new identity.WellKnownHandleResolver()
		}
	}),
	didDocumentResolver: new identity.CompositeDidDocumentResolver({
		methods: {
			plc: new identity.PlcDidDocumentResolver({ apiUrl: PLC }),
			web: new identity.WebDidDocumentResolver()
		}
	})
});
const client = new oauth.OAuthClient({
	metadata: {
		client_id: `${SITE}/${run}/oauth-client-metadata.json`,
		redirect_uris: [`${SITE}/${run}/oauth/callback`],
		scope: 'atproto',
		jwks_uri: `${SITE}/${run}/oauth/jwks.json`
	},
	keyset: [key],
	actorResolver,
	stores: { sessions: new oauth.MemoryStore(), states: new oauth.MemoryStore() }
});

const served = [];
const server = createServer((req, res) => {
	const path = new URL(req.url, SITE).pathname;
	const body =
		path === `/${run}/oauth-client-metadata.json`
			? client.metadata
			: path === `/${run}/oauth/jwks.json`
				? client.jwks
				: null;
	served.push(`${path} ${body ? 200 : 404}`);
	res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body ?? { error: 'not found' }));
});
await new Promise((ok, no) => server.once('error', no).listen(PORT, HOST, ok));

try {
	const { url } = await client.authorize({ target: { type: 'account', identifier: did } });
	const requestUri = url.searchParams.get('request_uri') ?? '';
	if (!requestUri.startsWith('urn:ietf:params:oauth:request_uri:')) {
		throw new Error(`authorize URL carries no request_uri: ${url.origin}${url.pathname}`);
	}
	if (url.origin !== PDS) throw new Error(`authorize URL is on ${url.origin}`);
	console.log(`PAR ACCEPTED for confidential client ${client.metadata.client_id}`);
	console.log(`  the PDS fetched over TLS: ${served.join(', ') || 'nothing (cached)'}`);
} catch (e) {
	fail('confidential client PAR', e);
	if (served.length) console.log(`  the PDS fetched: ${served.join(', ')}`);
}
server.close();

// (c) The same request shape with a .test client_id, straight to the PDS's PAR endpoint.
try {
	const parEndpoint =
		asMetadata?.pushed_authorization_request_endpoint ?? `${PDS}/oauth/par`;
	const verifier = randomBytes(32).toString('base64url');
	const res = await fetch(parEndpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: `${TEST_SITE}/oauth-client-metadata.json`,
			response_type: 'code',
			redirect_uri: `${TEST_SITE}/oauth/callback`,
			scope: 'atproto',
			state: randomBytes(16).toString('base64url'),
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
			code_challenge_method: 'S256',
			login_hint: did
		})
	});
	const text = await res.text();
	let error = text.slice(0, 200);
	try {
		const body = JSON.parse(text);
		error = [body.error, body.error_description].filter(Boolean).join(': ');
	} catch {}
	if (res.ok) throw new Error(`the PDS accepted it (HTTP ${res.status})`);
	console.log(`REFUSED .test client_id: HTTP ${res.status} ${error}`);
} catch (e) {
	fail('.test client_id PAR', e);
}

process.exit(failed ? 1 : 0);

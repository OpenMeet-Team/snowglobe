// bin/snowglobe.mjs account <name> <PREFIX> [<pds>]
//
// account creates or finds <name> on <pds> (the PDS with bare handles, else the seed PDS):
// <name>.<domain> there, <name>.<pds>.<domain> on the others. Its login goes into ACCOUNTS_FILE
// (accounts.env in the snowglobe's state folder by default, mode 600) as <PREFIX>_HANDLE, _DID, _PASSWORD and _PDS, its
// handle into the names bin/snowglobe.mjs run maps (restart a process under it to pick one up), and
// its DID alone to stdout. A rerun finds it. It reads the rendered globe, and prints no secret
// (lib/xrpc.mjs).

import { randomBytes } from 'node:crypto';
import { ROOT, UsageError, envGet, envPut, globeFacts, loginsFile, paths } from '../env.mjs';
import { session } from '../state.mjs';
import { mintInvite, why, xrpc } from '../xrpc.mjs';

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// The authority's own account, which snowglobe up makes under this prefix. Its name is one the
// globe keeps for itself, so no other account takes it.
const AUTHORITY = { name: 'lex-authority', prefix: 'LEX_AUTHORITY' };

export const command = {
  name: 'account',
  usage: 'account <name> <PREFIX> [<pds>]',
  options: {},
  positionals: [2, 3],
};

export async function run({ positionals: [name, prefix, pds] }) {
  console.log(await account({ name, prefix, pds, state: session().state, log: (m) => console.error(m) }));
}

/**
 * Create, or find, the account <name> on the globe's PDS `pds` (the one with bare handles, else
 * the seed PDS, by default), and keep its login in `file` as <prefix>_HANDLE, _DID, _PASSWORD and
 * _PDS. Its handle is added to the names snowglobe run maps. Resolves to the DID. A rerun signs in
 * with the kept password and finds the account; a PDS that takes invite codes is sent one
 * (SG_INVITE_CODE, else a single-use code minted for this account), the others none.
 */
export async function account({ name, prefix, pds, file, root = ROOT, state, env = process.env, log = () => {} }) {
  if (!LABEL_RE.test(name ?? '')) throw new UsageError(`<name> must be one lowercase DNS label: ${name}`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(prefix ?? '')) throw new UsageError(`<PREFIX> must be an env var prefix (A-Z, 0-9, _): ${prefix}`);
  const g = globeFacts({ root, state, env });
  const where = pds || g.bare || g.seed;
  if (!g.pds.includes(where)) throw new UsageError(`${where} is not a PDS in this globe (${g.pds.join(', ')})`);
  const bare = where === g.bare;
  const handle = bare ? `${name}.${g.domain}` : `${name}.${where}.${g.domain}`;
  // A bare handle is <name>.<domain>, the same space as the globe's own names.
  if (bare && g.taken.includes(name) && !(name === AUTHORITY.name && prefix === AUTHORITY.prefix))
    throw new UsageError(`${handle} is a name the globe uses itself; pick another <name>`);
  if (handle.length > 253) throw new UsageError(`${handle} is longer than 253 characters`);
  const pdsUrl = `https://${where}.${g.domain}`;
  const accounts = loginsFile(file || env.ACCOUNTS_FILE || paths(root, state).accounts);
  const opts = { root, state, env };

  const save = (did, password) =>
    envPut(accounts, new RegExp(`^${prefix}_(HANDLE|DID|PASSWORD|PDS)=`), [
      `${prefix}_HANDLE=${handle}`,
      `${prefix}_DID=${did}`,
      `${prefix}_PASSWORD=${password}`,
      `${prefix}_PDS=${pdsUrl}`,
    ]);

  const kept = envGet(`${prefix}_PASSWORD`, accounts);
  if (kept && envGet(`${prefix}_HANDLE`, accounts) === handle) {
    const res = await xrpc(pdsUrl, 'com.atproto.server.createSession', { body: { identifier: handle, password: kept }, ...opts });
    if (res.ok && typeof res.json.did === 'string') {
      if (envGet(`${prefix}_DID`, accounts) !== res.json.did) save(res.json.did, kept);
      log(`Found ${handle} -> ${res.json.did}`);
      return res.json.did;
    }
    log(`${handle} is in ${accounts} but cannot sign in; creating it`);
  }

  let inviteCode;
  if (g.invites.includes(where)) inviteCode = env.SG_INVITE_CODE || (await mintInvite(pdsUrl, 1, opts));
  const password = randomBytes(16).toString('hex');
  const body = { handle, email: `${name}@${bare ? g.domain : `${where}.${g.domain}`}`, password };
  if (inviteCode) body.inviteCode = inviteCode;
  const res = await xrpc(pdsUrl, 'com.atproto.server.createAccount', { body, ...opts });
  if (!res.ok || typeof res.json.did !== 'string') throw new Error(`createAccount ${handle} on ${pdsUrl} failed: ${why(res)}`);
  save(res.json.did, password);
  log(`Created ${handle} on ${pdsUrl} -> ${res.json.did}`);
  return res.json.did;
}

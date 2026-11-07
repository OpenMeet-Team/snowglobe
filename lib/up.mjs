// What snowglobe up decides without Docker: the app routes the file adds, whether the globe's
// PDSes clash with an app's handle ending, the env names the file's accounts keep their logins
// under, whether the relay restarts. Pure: inputs in, text or lists out (lib/commands/up.mjs runs
// the globe).

const envName = (label) => label.toUpperCase().replace(/-/g, '_');

/**
 * The routes in data/https/apps (`routes`) with each app the file runs locally (`fileApps`, the
 * parsed globe's apps) set to the file's port and handle ending. A route the file does not name is
 * kept, as `snowglobe app` made it. Throws when the file's ending is another route's.
 */
export function mergeRoutes(routes, fileApps) {
  const out = [...routes];
  for (const a of fileApps.filter((x) => x.local)) {
    const route = { name: a.name, port: a.local.port, ending: a.local.handles ?? null };
    const owner = route.ending && out.find((r) => r.ending === route.ending && r.name !== a.name);
    if (owner)
      throw new Error(`the file's app ${a.name} claims the handles under ${route.ending}, which already go to ${owner.name} (data/https/apps); snowglobe app --remove ${owner.name}`);
    const i = out.findIndex((r) => r.name === a.name);
    if (i === -1) out.push(route);
    else out[i] = route;
  }
  return out;
}

/**
 * The file's accounts ({ name, pds }), each with the env prefix its login is kept under in
 * data/accounts.env: <NAME> on `home` (the PDS snowglobe account makes accounts on by default,
 * where the base init's ALICE and BOB are), <NAME>_<PDS> on any other. A shell name cannot start
 * with a digit, so 1st is _1ST. Throws when two accounts would share one.
 */
export function accountPrefixes(accounts, home) {
  const seen = new Map();
  return accounts.map(({ name, pds }) => {
    const v = pds === home ? envName(name) : `${envName(name)}_${envName(pds)}`;
    const prefix = /^[0-9]/.test(v) ? `_${v}` : v;
    if (seen.has(prefix)) throw new Error(`${name}@${pds} and ${seen.get(prefix)} would both keep their logins as ${prefix}_*; rename one`);
    seen.set(prefix, `${name}@${pds}`);
    return { name, pds, prefix };
  });
}

/**
 * The first server of `pdsNames` (the PDSes and group hosts) named like the ending an app in
 * `apps` claimed, as { pds, app }, or null. Such a server would take that app's handles: nginx
 * keeps the first of two servers with one name, and the globe's come before the apps'.
 */
export function endingClash(pdsNames, apps) {
  for (const pds of pdsNames) {
    const app = apps.find((a) => a.ending === pds);
    if (app) return { pds, app: app.name };
  }
  return null;
}

/**
 * The first of `dialed` (service name -> its containers' start times) with a container that started
 * after the relay did (`relay`, its containers' start times), or null. The times are Docker's
 * State.StartedAt. The relay dials each PDS through nginx, and one that was running when either
 * went away can stop picking up what the PDS sends, so up restarts it.
 */
export function startedAfterRelay(relay, dialed) {
  const since = Math.max(...relay.map((t) => Date.parse(t)));
  for (const [service, times] of Object.entries(dialed)) if (times.some((t) => Date.parse(t) > since)) return service;
  return null;
}

/**
 * Tries the snowglobe's name with `reach` (lib/env.mjs nameReaches, for its domain and leaf) up to
 * `tries` times, `pause` between, until it is reached: a route the name router has just reloaded,
 * or a resolver that failed for a moment, may take a second. Returns the last answer.
 */
export async function tryName(reach, { tries = 3, pause = () => new Promise((r) => setTimeout(r, 1000)) } = {}) {
  let res;
  for (let n = 0; n < tries; n++) {
    if (n) await pause();
    res = await reach();
    if (res.reached) break;
  }
  return res;
}

/**
 * What up found at the snowglobe's own name (`res`, from nameReaches), given the address it is up
 * on (`bind`) and whether the name router routes its domain there (`routed`):
 *   reached            the name reaches it
 *   unresolved         the name has no address on this machine
 *   router-unanswered  routed, and nothing takes the connection where the name resolves
 *   router-another     routed, and what answers there is not this snowglobe
 *   another-snowglobe  no router, and another of the user's snowglobes holds the address the name
 *                      resolves to: two snowglobes without the router, where only one is reached
 *                      by name, as documented, so up warns and does not fail
 *   another            no router, and something else holds the address the name resolves to
 *   elsewhere          no router, nothing at the address the name resolves to, and the snowglobe
 *                      is on another one
 *   unanswered         no router, and nothing answers on the snowglobe's own address by name
 */
export function nameFinding({ bind, routed, res }) {
  if (res.reached) return 'reached';
  if (res.why === 'unresolved') return 'unresolved';
  if (routed) return res.why === 'another' ? 'router-another' : 'router-unanswered';
  if (res.why === 'another') return res.snowglobe ? 'another-snowglobe' : 'another';
  return res.address === bind ? 'unanswered' : 'elsewhere';
}

// Whether up fails on a finding, or only says it: another snowglobe holding the name's address
// with no router is the documented way two run side by side.
export const nameFails = (finding) => finding !== 'reached' && finding !== 'another-snowglobe';

/**
 * The bind files to remove so the next up puts the snowglobe where its name reaches it, for a
 * `finding` that has such a fix: its own (`own`, kept from its first up, which a rerun keeps), and
 * with no router, the other snowglobes' that keep the name's address (`kept`), so up stops passing
 * it over once it is free. None for a finding that removing files does not fix.
 */
export function bindFilesToRemove(finding, { own, kept = [] }) {
  if (['elsewhere', 'another', 'another-snowglobe'].includes(finding)) return [own, ...kept];
  if (finding === 'router-unanswered') return [own];
  return [];
}

/**
 * What up says for a `finding` other than reached: `name` the snowglobe, `domain` its domain,
 * `bind` the address it is up on, `res` nameReaches's answer, `kept` the other snowglobes keeping
 * res.address (their folder names), `remove` the bind files to remove (bindFilesToRemove), and
 * `pinned` SG_BIND when it is set, which a bind file does not override. The snowglobe is left
 * running.
 */
export function unreachedMessage(finding, { name, domain, bind, res, kept = [], remove = [], pinned = '' }) {
  const up = `${name} is up on ${bind}, where snowglobe's own commands reach it, but no app on this machine reaches it by name`;
  const addr = res.address;
  const code = res.code ? ` (${res.code})` : '';
  const keepers = kept.length ? ` The snowglobe${kept.length > 1 ? 's' : ''} ${kept.join(', ')} keep${kept.length > 1 ? '' : 's'} ${addr} in a bind file, so up passes it over for a new snowglobe, running or not.` : '';
  const rm = `remove ${remove.join(' and ')}${pinned ? `, unset SG_BIND (it is ${pinned})` : ''}`;
  switch (finding) {
    case 'unresolved':
      return `${domain} does not resolve on this machine${code}. ${up}.${domain.endsWith('.local.snowglobe.at') ? ' Names under local.snowglobe.at come from public DNS, and a resolver that drops answers pointing at 127.0.0.1 (DNS rebinding protection) leaves them unresolved.' : ''} docs/browser.md, "When the browser cannot open it", has the ways round it`;
    case 'router-unanswered':
      return `nothing at ${addr}:443, where ${domain} resolves and the name router should answer, took the connection${code}. ${up}. snowglobe ls says whether the router runs. On Docker Desktop it runs inside Docker's VM, out of this machine's reach: snowglobe down, then set SG_ROUTER=off for every snowglobe command (in the environment or .env), ${rm}, and snowglobe up, which then takes the first free address from 127.0.0.1`;
    case 'router-another':
      return `${domain} resolves to ${addr}, where the name router should pass the connection on to ${name}, but what answers is not ${name}${code}. ${up}. snowglobe ls says whether the router runs and what it routes; docker ps shows what else publishes ${addr}:443`;
    case 'another-snowglobe':
      return `${domain} resolves to ${addr}, where another of your snowglobes answers. ${up}: with no route through the name router, only the snowglobe on ${addr} is reached by name.${keepers} To put ${name} there instead: take that one down, then snowglobe down, ${rm}, and snowglobe up`;
    case 'another':
      return `${domain} resolves to ${addr}, and what answers there is not a snowglobe${code}. ${up}: with no route through the name router, only what holds ${addr}:443 is reached by name. To put ${name} there: free ${addr}:443, then snowglobe down, ${rm}, and snowglobe up`;
    case 'elsewhere':
      return `${domain} resolves to ${addr}, where nothing answers${code}. ${up}: with no route through the name router, only a snowglobe on ${addr} is reached by name.${keepers} To put ${name} there: snowglobe down, ${rm}, then snowglobe up`;
    default:
      return `${domain} resolves to ${addr}, where ${name} is up, but nothing there finished a TLS handshake for the name${code}. ${up}. docker ps shows what publishes ${addr}:443`;
  }
}

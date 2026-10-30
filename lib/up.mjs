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

// The names an app's settings are built from: `${pds.alpha.url}` in snowglobe.yml's apps[].env.
// Pure: a checked globe and a name in, a value out, or the reason the file has no such name. The
// names and the reasons for them: OKF projects/atmo-events/2026-10-21-snowglobe-app-settings-design.md.
//
// The rule: the file's own section, then the name you gave it, then the field. Most values come from
// the file alone. A few exist only once the globe is up (an account's DID and password, the lexicon
// authority's DID, the CA, the mail page): `later` says what they are, and check, which has no state
// to look in, passes a stand-in.

const LATER = 'a value known only after snowglobe up';

// The secrets: left out of snowglobe env unless asked for.
export const isSecret = (name) => /^accounts\.[^.]+\.password$/.test(name);

/**
 * `text` split at its ${name} placeholders: { parts } where a part is { text } or { name }, or
 * { error }. `$$` is a literal `$`; a `$` that starts neither passes through as written.
 */
export function parseValue(text) {
  const parts = [];
  let lit = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '$' && text[i + 1] === '$') {
      lit += '$';
      i += 2;
    } else if (text[i] === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      if (end === -1) return { error: 'a ${ with no closing } (write $${ for a literal ${)' };
      const name = text.slice(i + 2, end).trim();
      if (!name) return { error: 'an empty ${}' };
      if (lit) parts.push({ text: lit });
      lit = '';
      parts.push({ name });
      i = end + 1;
    } else lit += text[i++];
  }
  if (lit) parts.push({ text: lit });
  return { parts };
}

const list = (xs) => (xs.length ? xs.join(', ') : 'none');

/**
 * The value of `name` in `globe` (a checked file): { value }, or { error } saying what is wrong
 * with the name. `later(name)` gives the names known only after up (it returns undefined when the
 * state has no value yet); without it they come back as { later: true }, which is all check needs.
 */
export function lookup(globe, name, later) {
  const D = globe.domain;
  const [head, ...rest] = name.split('.');
  const fail = (error) => ({ error });
  const after = (what = name) => {
    if (!later) return { later: true };
    const value = later(what);
    return value === undefined ? fail(`${name} is ${LATER}; run snowglobe up first`) : { value };
  };

  // A server of a section, by the name the file gave it: <section>.<name>.<field>.
  const server = (kind, items, fields) => {
    const [n, field, ...more] = rest;
    if (n === undefined) return fail(`${head} needs a name: ${head}.<name>.<field> (${list(items.map((i) => i.name))})`);
    const item = items.find((i) => i.name === n);
    if (!item) return fail(`${head}.${n} is not ${kind} in this file: ${list(items.map((i) => i.name))}`);
    if (field === undefined || more.length || !Object.hasOwn(fields, field))
      return fail(`${name} is not a value of ${head}.${n}; it has ${list(Object.keys(fields).map((f) => `${head}.${n}.${f}`))}`);
    return { value: fields[field](item) };
  };
  const host = (i) => `${i.name}.${D}`;
  const web = {
    url: (i) => `https://${host(i)}`,
    host,
    did: (i) => `did:web:${host(i)}`,
  };

  switch (head) {
    case 'domain':
    case 'globe':
      return rest.length ? fail(`${name} is not a name; ${head} has no fields`) : { value: head === 'domain' ? D : globe.globe };
    case 'page':
      return rest.join('.') === 'url' ? { value: `https://${D}/` } : fail(`${name} is not a name; the page has page.url`);
    case 'pds':
      return server('a PDS', globe.pds, web);
    case 'grouphosts':
      return server('a group host', globe.grouphosts, web);
    case 'apps':
      return server('an app', globe.apps, { url: (a) => `https://${a.name}.app.${D}`, host: (a) => `${a.name}.app.${D}` });
    case 'services': {
      const [svc, field, ...more] = rest;
      const svcs = {
        plc: { url: `https://plc.${D}` },
        relay: { url: `https://relay.${D}`, ws: `wss://relay.${D}` },
        jetstream: { url: `https://jetstream.${D}`, ws: `wss://jetstream.${D}/subscribe` },
        slingshot: { url: `https://slingshot.${D}` },
        pdsls: { url: `https://pdsls.${D}` },
        cdn: { url: `https://cdn.${D}` },
        mail: { url: null },
        tap: { url: null },
      };
      if (!svc || !Object.hasOwn(svcs, svc)) return fail(`${svc ? `services.${svc}` : name} is not a service with an address: ${list(Object.keys(svcs))}`);
      if (field === undefined || more.length || !Object.hasOwn(svcs[svc], field))
        return fail(`${name} is not a value of services.${svc}; it has ${list(Object.keys(svcs[svc]).map((f) => `services.${svc}.${f}`))}`);
      if (svc !== 'plc' && svc !== 'mail' && !globe.services[svc]) return fail(`services.${svc} is off in this file, so it has no address`);
      return svc === 'mail' || svc === 'tap' ? after() : { value: svcs[svc][field] };
    }
    case 'accounts': {
      if (rest.length === 1 && rest[0] === 'file') return after();
      const [n, field, ...more] = rest;
      if (n === undefined) return fail(`accounts needs a name: accounts.<name>.<field> (${list(globe.accounts.map((a) => a.name))})`);
      const a = globe.accounts.find((x) => x.name === n);
      if (!a) return fail(`accounts.${n} is not an account in this file: ${list(globe.accounts.map((x) => x.name))}`);
      const fields = ['handle', 'pds', 'did', 'password'];
      if (!fields.includes(field) || more.length) return fail(`${name} is not a value of accounts.${n}; it has ${list(fields.map((f) => `accounts.${n}.${f}`))}`);
      if (field === 'handle') return { value: a.handle };
      if (field === 'pds') return { value: `https://${a.pds}.${D}` };
      return after();
    }
    case 'lexicons': {
      if (rest[0] !== 'authority' || rest.length !== 2 || !['did', 'handle'].includes(rest[1]))
        return fail(`${name} is not a name; the lexicon authority has lexicons.authority.did and lexicons.authority.handle`);
      if (rest[1] === 'did') return after();
      const p = globe.pds.find((x) => x.name === globe.lexicons.authority);
      return { value: p?.bare_handles ? `lex-authority.${D}` : `lex-authority.${p?.name}.${D}` };
    }
    case 'ca':
      return rest.join('.') === 'file' ? after() : fail(`${name} is not a name; the certificate authority has ca.file`);
    default:
      return fail(`${name} is not a name. Sections: domain, globe, page.url, pds.<name>, grouphosts.<name>, apps.<name>, services.<name>, accounts.<name>, accounts.file, lexicons.authority, ca.file`);
  }
}

/** The problems with the names in every apps[].env of `globe`, as [where, message] pairs. */
export function checkSettings(globe) {
  const problems = [];
  if (globe.tap?.webhook) {
    const { parts, error } = parseValue(globe.tap.webhook);
    if (error) problems.push(['services.tap.webhook', error]);
    else
      for (const part of parts) {
        const found = part.name && lookup(globe, part.name);
        if (found?.error) problems.push(['services.tap.webhook', found.error]);
        else if (found?.later) problems.push(['services.tap.webhook', `${part.name} is known only after snowglobe up, so Tap cannot be given it`]);
      }
  }
  globe.apps.forEach((app, i) => {
    for (const [key, text] of Object.entries(app.env)) {
      const at = `apps[${i}].env.${key}`;
      const { parts, error } = parseValue(text);
      if (error) problems.push([at, error]);
      else
        for (const part of parts) {
          const found = part.name && lookup(globe, part.name);
          if (found?.error) problems.push([at, found.error]);
        }
    }
  });
  return problems;
}

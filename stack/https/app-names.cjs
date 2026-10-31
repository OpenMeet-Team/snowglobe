// Preloaded into each PDS (NODE_OPTIONS=--require, in the globe bin/snowglobe.mjs render writes), so a PDS can
// reach an OAuth client under the globe's domain, an app at https://<name>.app.<domain> or
// PDSls at https://pdsls.<domain>: it fetches the client's metadata and keys from there.
// Docker's DNS has no wildcard names, so every such name is
// looked up as nginx instead, which routes it by name (stack/https/nginx.conf.template). Only
// the address lookup changes: the request still carries the app's name, and TLS still
// checks the certificate for it against the snowglobe CA. Every other name resolves as usual.
//
// SG_RESOLVE_DOMAIN sets the domain whose names, itself included, go to nginx. Each PDS and
// each group host sets it to the globe's domain; a group host also resolves its members'
// handles there, which Docker's DNS does not know.
'use strict';
const dns = require('dns');

// DEVNET_ was these settings' prefix until 2026-10-20; a container made before then still has it.
const DOMAIN = (process.env.SG_RESOLVE_DOMAIN || process.env.DEVNET_RESOLVE_DOMAIN || '').toLowerCase();
const PROXY = process.env.SG_APP_PROXY_HOST || process.env.DEVNET_APP_PROXY_HOST || 'nginx';
const isApp = (name) => {
  if (typeof name !== 'string') return false;
  const n = name.toLowerCase().replace(/\.$/, '');
  return DOMAIN !== '' && (n === DOMAIN || n.endsWith(`.${DOMAIN}`));
};

const lookup = dns.lookup;
dns.lookup = function snowglobeLookup(hostname, ...rest) {
  return lookup.call(this, isApp(hostname) ? PROXY : hostname, ...rest);
};

const lookupPromise = dns.promises.lookup;
dns.promises.lookup = function snowglobeLookupPromise(hostname, ...rest) {
  return lookupPromise.call(this, isApp(hostname) ? PROXY : hostname, ...rest);
};

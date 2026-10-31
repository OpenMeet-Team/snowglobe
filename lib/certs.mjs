// The https globe's certificates: one local CA per user, made once (<state root>/ca), and one
// leaf per snowglobe, which nginx serves for every name: each PDS and its handles, the globe's services, plc.directory, every app at
// <name>.app.<domain> (one wildcard), and the handles under each ending an app claimed with
// bin/snowglobe.mjs app. Made here with @peculiar/x509, so no openssl is needed.
//
// Files: ca.crt and ca.key in the CA's folder (`caDir`), leaf.crt and leaf.key in the snowglobe's
// (`dir`). An existing CA is kept, so a browser or OS that trusts ca.crt keeps trusting every
// snowglobe; only the leaf is reissued, and only when it lacks a name or another CA signed it.
// Delete the CA's ca.* to start over, and then trust the new ca.crt again everywhere the old one
// was trusted.
//
// The CA can only vouch for servers under local.snowglobe.at (the zone every snowglobe's own
// domain is under, <globe>.local.snowglobe.at), a domain outside it that it was made for,
// and plc.directory (name constraints, serverAuth only, no IP addresses), so
// trusting it on a host cannot put any other site at risk, even if ca.key leaks. A name outside
// those is refused before the leaf is touched; widening the list, or a snowglobe on a domain
// outside the zone made after the CA, means a new CA, trusted again.
//
// A TLS wildcard covers one label, so *.mine.local.snowglobe.at does not cover a handle on the PDS
// named regular (<name>.regular.mine.local.snowglobe.at); each handle domain has its own.

import 'reflect-metadata';
import { AsnConvert } from '@peculiar/asn1-schema';
import { GeneralName, GeneralSubtree, GeneralSubtrees, NameConstraints, id_ce_nameConstraints } from '@peculiar/asn1-x509';
import * as x509 from '@peculiar/x509';
import { X509Certificate as NodeCertificate, createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_ZONE } from './config.mjs';

x509.cryptoProvider.set(webcrypto);

const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const DAY = 24 * 60 * 60 * 1000;
// 397 days: under the 398-day ceiling browsers apply to server certificates.
const LEAF_DAYS = 397;
const CA_DAYS = 730;
// Names every globe's CA vouches for besides its domain: the stand-in for the real PLC directory.
const FIXED = ['plc.directory'];

// Every name the leaf must carry: the rendered globe's (its page, each PDS and its handles, its
// services, plc.directory and *.app.<domain>), *.<ending>.<domain> for each ending an app
// claimed, and `extra` (HTTPS_EXTRA_NAMES, space-separated).
export function leafNames(p, domain, extra = '') {
  if (!existsSync(p.leafNames)) throw new Error(`No ${p.leafNames}: run snowglobe up, which renders it`);
  const words = (text) => text.split(/\s+/).filter(Boolean);
  const endings = existsSync(p.apps)
    ? readFileSync(p.apps, 'utf8').split('\n').map(words).filter((f) => f.length >= 3).map((f) => `*.${f[2]}.${domain}`)
    : [];
  return [...new Set([...words(readFileSync(p.leafNames, 'utf8')), ...endings, ...words(extra)])];
}

// The names a certificate carries, from its subjectAltName.
function sans(pem) {
  const alt = new NodeCertificate(pem).subjectAltName ?? '';
  return alt.split(', ').filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4));
}

// True when there is no leaf, or it lacks one of `names`, or the CA in `caDir` did not sign it
// (a leaf left from another CA is not trusted by whoever trusts this one).
export function leafLacks(dir, names, caDir = dir) {
  const crt = join(dir, 'leaf.crt');
  if (!existsSync(crt) || !existsSync(join(dir, 'leaf.key'))) return true;
  const leaf = readFileSync(crt, 'utf8');
  const have = new Set(sans(leaf));
  if (names.some((n) => !have.has(n))) return true;
  const caCrt = join(caDir, 'ca.crt');
  return existsSync(caCrt) && !new NodeCertificate(leaf).verify(new NodeCertificate(readFileSync(caCrt, 'utf8')).publicKey);
}

// The DNS names a CA may vouch for (its permitted subtrees), or null if it is unconstrained.
function permitted(ca) {
  const ext = ca.extensions.find((e) => e.type === id_ce_nameConstraints);
  if (!ext) return null;
  const nc = AsnConvert.parse(ext.value, NameConstraints);
  return (nc.permittedSubtrees ?? []).map((s) => s.base.dNSName).filter(Boolean);
}

const within = (name, bases) => bases.some((b) => name === b || name.endsWith(`.${b}`));

// A positive serial number of 16 random bytes.
function serial() {
  const b = randomBytes(16);
  b[0] &= 0x7f;
  b[0] |= 0x01;
  return b.toString('hex');
}

const pem = (label, der) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

async function importSigningKey(keyPem) {
  const key = createPrivateKey(keyPem);
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') throw new Error('ca.key is not a P-256 key');
  return webcrypto.subtle.importKey('pkcs8', key.export({ format: 'der', type: 'pkcs8' }), EC, false, ['sign']);
}

async function makeCa(domain, now) {
  const keys = await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  // Each CA has a name of its own. Two CAs with one name confuse a browser that trusts one of
  // them: Firefox checks the other's leaf against the trusted key and calls it a bad signature,
  // with no way to click through, where an unknown CA could be.
  const name = `snowglobe local CA ${now.toISOString().slice(0, 10)} ${randomBytes(3).toString('hex')}`;
  const subtree = (gn) => new GeneralSubtree({ base: new GeneralName(gn) });
  const constraints = new NameConstraints({
    // One CA serves every snowglobe, so the local zone is always in, whatever domain the
    // snowglobe that makes it is on; a domain inside the zone needs no subtree of its own.
    permittedSubtrees: new GeneralSubtrees(
      [...new Set([LOCAL_ZONE, ...(within(domain, [LOCAL_ZONE]) ? [] : [domain]), ...FIXED])].map((d) => subtree({ dNSName: d })),
    ),
    excludedSubtrees: new GeneralSubtrees([subtree({ iPAddress: '0.0.0.0/0' }), subtree({ iPAddress: '::/0' })]),
  });
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `O=snowglobe, CN=${name}`,
    notBefore: now,
    notAfter: new Date(now.getTime() + CA_DAYS * DAY),
    signingAlgorithm: SIGN,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.Extension(id_ce_nameConstraints, true, AsnConvert.serialize(constraints)),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const key = pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { cert, key };
}

// Make the CA (in `caDir`, `dir` by default) if there is none, and issue the leaf (in `dir`) if it
// lacks a name of `names` (or `force`). Returns { newCa, newLeaf }. Progress goes to `log`; no key
// is ever logged.
export async function ensureCerts({ dir, caDir = dir, domain, names, force = false, now = new Date(), log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(caDir, { recursive: true });
  const f = (n) => join(dir, n);
  const c = (n) => join(caDir, n);
  let newCa = false;
  let ca;
  let caKey;
  if (existsSync(c('ca.crt')) && existsSync(c('ca.key'))) {
    ca = new x509.X509Certificate(readFileSync(c('ca.crt'), 'utf8'));
    caKey = await importSigningKey(readFileSync(c('ca.key'), 'utf8'));
    log(`Keeping the existing CA: ${ca.subject}`);
  } else if (existsSync(c('ca.crt')) || existsSync(c('ca.key'))) {
    throw new Error(
      `Only one of ${c('ca.crt')} and ca.key exists. Restore the other, or delete both to make a new CA (which must then be trusted again).`,
    );
  } else {
    const made = await makeCa(domain, now);
    writeFileSync(c('ca.key'), made.key, { mode: 0o600, flag: 'wx' });
    writeFileSync(c('ca.crt'), made.cert.toString('pem') + '\n', { mode: 0o644 });
    ca = made.cert;
    caKey = await importSigningKey(made.key);
    newCa = true;
    log(`Made a new CA: ${ca.subject}`);
  }

  if (!force && !leafLacks(dir, names, caDir)) {
    log('The leaf already carries every name; kept');
    return { newCa, newLeaf: false };
  }

  // Refused before anything is written, so the leaf nginx serves stays as it is.
  const bases = permitted(ca);
  const outside = bases ? names.filter((n) => !within(n.replace(/^\*\./, ''), bases)) : [];
  if (outside.length)
    throw new Error(
      `The CA cannot vouch for ${outside.join(' ')} (it vouches for ${bases.join(', ')}), so the leaf is unchanged. ` +
        `The domain ${domain} is not one this CA was made for. To make a new CA that is: delete the folder ${caDir} and run up again ` +
        '(browsers and systems that trusted the old CA must then trust the new one).',
    );

  const keys = await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `O=snowglobe, CN=${domain}`,
    // The CA's subject as its own bytes. Rebuilt from text, its strings come out PrintableString
    // where the CA has UTF8String; openssl and Node match names loosely and accept that, but Go
    // (the relay, TAP) matches the bytes, and calls the CA unknown.
    issuer: ca.subjectName,
    notBefore: now,
    notAfter: new Date(now.getTime() + LEAF_DAYS * DAY),
    signingAlgorithm: SIGN,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
      new x509.SubjectAlternativeNameExtension(names.map((value) => ({ type: 'dns', value }))),
    ],
  });
  const leafPem = leaf.toString('pem') + '\n';
  if (!new NodeCertificate(leafPem).verify(new NodeCertificate(ca.toString('pem')).publicKey))
    throw new Error('The new leaf does not check out against the CA; the leaf is unchanged');

  // Written in place, not renamed: nginx's single-file mounts follow the file, not the name.
  writeFileSync(f('leaf.key'), pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), { mode: 0o600 });
  writeFileSync(f('leaf.crt'), leafPem, { mode: 0o644 });
  // nginx reads the leaf key as root inside its container.
  chmodSync(f('leaf.key'), 0o600);
  chmodSync(f('leaf.crt'), 0o644);
  chmodSync(c('ca.key'), 0o600);
  log(`Leaf names: ${names.join(' ')}`);
  log(`Leaf valid until ${leaf.notAfter.toISOString()}`);
  return { newCa, newLeaf: true };
}

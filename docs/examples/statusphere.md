# Statusphere

> **CI runs the whole flow on every change** ([`scripts/statusphere.mjs`](../../scripts/statusphere.mjs)):
> sign in as alice through her PDS's sign-in and consent pages, pick an emoji, see the record on her
> PDS and in the feed, and see a status bob wrote outside the app arrive through Tap. CI uses
> headless Chromium on the machine that runs Docker. A browser on another computer, through a
> forwarded port 443 ([From a browser on your own computer](../browser.md)), is not part of that run.

[Statusphere](https://github.com/bluesky-social/statusphere-example-app) is the atproto example app:
sign in with a handle, pick an emoji, and the app writes an `xyz.statusphere.status` record to your
account. It is a Next.js app, and it runs on [a snowglobe](../snowglobe.md) with two small changes to
the app. The rest is the snowglobe's own tools.

## The snowglobe

Start from [`snowglobe.default.yml`](../../snowglobe.default.yml) and add the app
([`statusphere.yml`](statusphere.yml) is the whole file):

```yaml
services:
  tap:
    webhook: ${apps.statusphere.url}/api/webhook
    signal_collection: xyz.statusphere.status

apps:
  - name: statusphere
    local: { port: 3000 }          # where `pnpm dev` listens; Next picks 3001 if 3000 is busy
    env:
      PUBLIC_URL: ${apps.statusphere.url}
      HANDLE_RESOLVER_URL: ${pds.main.url}
      TAP_URL: ${services.tap.url}
```

`PUBLIC_URL` makes the app use an https client ID, `https://statusphere.app.statusphere.local.snowglobe.at/oauth-client-metadata.json`
(the file's domain is `statusphere.local.snowglobe.at`, from its `globe:` line).
A PDS in Docker will not fetch a loopback client ID (`http://127.0.0.1:3000`), which is the one the app
uses without it. `HANDLE_RESOLVER_URL` is the change below. `services.tap` turns Tap on and tells it to send
the app the events of `xyz.statusphere.status` at the app's `/api/webhook`; the app reads Tap at `TAP_URL`
(`http://<SG_BIND>:2480`, on the snowglobe's own address; `SG_TAP_PORT` changes the port). `snowglobe check` refuses a webhook
that names an app the file does not have.

## Three changes to the app

Run `snowglobe up`, then in a clone of the app (the same changes as a patch:
[`statusphere.patch`](statusphere.patch), for `git apply` at the app's commit `dbb9773`, the one CI
uses):

```diff
--- a/lib/auth/client.ts
+++ b/lib/auth/client.ts
+const HANDLE_RESOLVER_URL = process.env.HANDLE_RESOLVER_URL;
+const PLC_DIRECTORY_URL = process.env.PLC_DIRECTORY_URL;
 ...
   client = new NodeOAuthClient({
     clientMetadata: getClientMetadata(),
+    handleResolver: HANDLE_RESOLVER_URL,
+    plcDirectoryUrl: PLC_DIRECTORY_URL,
--- a/next.config.ts
+++ b/next.config.ts
-  allowedDevOrigins: ["127.0.0.1"],
+  allowedDevOrigins: [
+    "127.0.0.1",
+    ...(process.env.PUBLIC_URL ? [new URL(process.env.PUBLIC_URL).hostname] : []),
+  ],
```

- **The handle resolver.** The OAuth library looks a handle up with a fetch that refuses loopback
  addresses, and every snowglobe name is one (127.0.0.1, where the name router listens). Pointing it
  at the PDS, which answers for its own handles, avoids that.
- **The PLC directory.** The library looks DIDs up at `plc.directory` unless told otherwise, and that is
  the real directory, which has never heard of the snowglobe's accounts. `PLC_DIRECTORY_URL` points it
  at the snowglobe's own (`${services.plc.url}`), as an app on a hosted snowglobe has to do too.
- **The allowed host.** Next's dev server refuses requests for a host it does not know, which leaves
  the page's scripts unloaded and the login button disabled. The app's own name has to be on the list.
  This is a Next dev-server setting, so it applies to any Next app on an app route.

## The key

The app signs its OAuth requests with a key. At that commit, its `pnpm gen-key` script fails with a
package-exports error from its locked dependencies, so make the same kind of key with Node:

```sh
node -e '
const { generateKeyPairSync } = require("crypto");
const j = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
console.log(JSON.stringify({ ...j, kid: String(Date.now()), alg: "ES256", key_ops: ["sign"] }));
' > key.jwk
```

## Run it

```sh
cp env.template .env.local        # in the app; delete the APP_URL line
pnpm install
PRIVATE_KEY="$(cat key.jwk)" snowglobe run pnpm dev
```

If port 3000 is taken on your machine, pick a free one: set it as the app's `local` port in the file and run the app with `PORT=<that port>`.
A snowglobe brought up before `services.tap` was set needs `snowglobe up` again, which recreates Tap.

Open `https://statusphere.app.statusphere.local.snowglobe.at`, sign in as `alice.statusphere.local.snowglobe.at` (her password
is `ALICE_PASSWORD` in `<state>/accounts.env`), authorize, and pick an emoji. The record is on her PDS:

```sh
curl -s --cacert ~/.local/share/snowglobe/ca/ca.crt \
  'https://main.statusphere.local.snowglobe.at/xrpc/com.atproto.repo.listRecords?repo=alice.statusphere.local.snowglobe.at&collection=xyz.statusphere.status'
```

## The feed

"Recent" fills from [Tap](https://github.com/bluesky-social/indigo/tree/main/cmd/tap). Tap finds an
account when it writes a `xyz.statusphere.status` record, fetches the account's repo, and posts each
event to the app's `/api/webhook`. Statuses from both alice and bob show in the app's Recent list, with
their handles. Tap runs in a small DNS container's network, so it reaches the app's https name and can
check a handle ([How it works](../how-it-works.md)).

Tap does not see an account that wrote before Tap started until that account writes again. The PDS
refuses Tap's crawl of the collection (HTTP 401), so Tap learns of an account only from a new write.
It then fetches the whole repo, and the app receives the older statuses too. You see this when you
turn Tap on in a snowglobe whose accounts already have statuses.

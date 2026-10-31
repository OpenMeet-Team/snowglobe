# Example: atmo

[atmo](https://github.com/flo-bit/atmo-events) is an events app. It runs on
[the snowglobe](../snowglobe.md) as it would on the real network. Its server reaches each PDS
and `plc.directory` at their https names, and the app has no snowglobe code or test switch. The snowglobe
knows nothing about atmo, so everything below is made with the snowglobe's tools. The steps use the
`feat/groups-opensocial` branch of
[tompscanlan/atmo-events](https://github.com/tompscanlan/atmo-events/tree/feat/groups-opensocial),
checked out beside the snowglobe as `atmo-events/`, and the
[opensocial.group proposal](https://tangled.org/opensocial.group/proposal) beside both as
`opensocial-proposal/`. Run `npm link` once in the snowglobe checkout, so the `snowglobe` command works from any folder. Then
copy [`atmo.yml`](atmo.yml), the snowglobe this example builds on, to `snowglobe.yml` in the snowglobe
checkout and bring it up (`snowglobe up`). The app is a sibling folder, so no `snowglobe.yml` is above it: in
each shell also set `SG_FILE` to that file's absolute path, and `state=~/.local/share/snowglobe/snowglobe`, its state folder
([Which snowglobe, and where it lives](../snowglobe.md#which-snowglobe-and-where-it-lives)).

**Lexicons.** Every snowglobe PDS resolves NSIDs only from the snowglobe's lexicon authority. atmo's OAuth
scope includes two permission sets, `rsvp.atmo.permissionSet` and `app.bsky.authCreatePosts`. If the
authority does not hold them, the PDS cannot expand the scope and the consent page fails. Copy both
from their real authorities, then publish them, and the proposal's lexicons for groups. From the
snowglobe checkout, outside `snowglobe run`, because the copy reads the real `plc.directory`:

```bash
mkdir -p data/atmo-lexicons
for nsid in rsvp.atmo.permissionSet app.bsky.authCreatePosts; do
  authority=$(echo "$nsid" | awk -F. '{print $2"."$1}')      # rsvp.atmo.x -> atmo.rsvp
  did=$(dig +short TXT "_lexicon.$authority" | tr -d '"' | sed 's/^did=//')
  pds=$(curl -s "https://plc.directory/$did" |
    jq -r '.service[] | select(.id == "#atproto_pds") | .serviceEndpoint')
  curl -s "$pds/xrpc/com.atproto.repo.getRecord?repo=$did&collection=com.atproto.lexicon.schema&rkey=$nsid" |
    jq '.value | del(."$type")' > "data/atmo-lexicons/$nsid.json"
done
snowglobe lexicons data/atmo-lexicons
snowglobe lexicons ../opensocial-proposal/lexicons
```

**An account.** `alice.local.snowglobe.at` and `bob.local.snowglobe.at` are already there (see
[The snowglobe](../snowglobe.md#the-file-and-the-commands)). To use another, make it with
`snowglobe account` before you start atmo, because `snowglobe run` maps only the handles it knows
when the command starts.

**Configure atmo.** In `atmo-events/apps/web`, after `pnpm install`, write a git-ignored `.env`.
It overrides the vars in `wrangler.jsonc` for `vite dev`. Wrangler reads a `.dev.vars` instead
when one exists, so keep only one of the two:

```
OAUTH_PUBLIC_URL=
GROUP_PDS_SERVICE=https://alpha.local.snowglobe.at
GROUP_HANDLE_DOMAIN=local.snowglobe.at
```

- `OAUTH_PUBLIC_URL=` is empty on purpose. `wrangler.jsonc` sets it to `https://atmo.rsvp`. Empty
  makes atmo use its loopback OAuth client, `http://127.0.0.1:5454`, which needs no keys and no
  public origin.
- `GROUP_PDS_SERVICE` and `GROUP_HANDLE_DOMAIN` name where atmo would create group accounts: the
  alpha, the snowglobe PDS that serves spaces. Write the domain with no leading dot. atmo adds the dot
  itself, and `.local.snowglobe.at` gives handles like `name..local.snowglobe.at`, which the PDS refuses.

Then create atmo's tables in its local D1 database. Without them, atmo logs
`no such table: groups` when it serves its OAuth client metadata.

```bash
pnpm exec wrangler d1 migrations apply DB --local
```

**Run atmo** under `snowglobe run`, from `atmo-events/apps/web`:

```bash
snowglobe run pnpm dev     # http://127.0.0.1:5454
```

**Use it from a browser.** Set up a browser on your computer as in
[From a browser on your own computer](../browser.md#from-a-browser-on-your-own-computer). Forward port 5454 to
5454 as well, since the loopback client's redirect URI names that port. Open
`http://127.0.0.1:5454` in that browser and sign in as `alice.local.snowglobe.at`, by handle or by DID,
with her password from `<state>/accounts.env`. atmo sends you to `https://alpha.local.snowglobe.at` to sign in
and approve, then back to atmo, signed in.

| URL | What answers |
| --- | --- |
| `http://127.0.0.1:5454` | atmo |
| `https://alpha.local.snowglobe.at` | the alpha PDS: its sign-in and consent pages, and its xrpc |
| `https://<handle>/.well-known/atproto-did` | the handle's PDS, with the handle's DID |
| `https://plc.directory/<did>` | the snowglobe's PLC, with the DID document |

**Use it from the shell.** The same names work under `snowglobe run`. curl does not read
`NODE_EXTRA_CA_CERTS`, so give it the CA. From the snowglobe checkout:

```bash
curl_sg() { snowglobe run curl -s --cacert ~/.local/share/snowglobe/ca/ca.crt "$@"; }
curl_sg https://alpha.local.snowglobe.at/xrpc/_health                # {"version":"0.5.32"}
curl_sg https://alice.local.snowglobe.at/.well-known/atproto-did     # alice's DID
did=$(sed -n 's/^ALICE_DID=//p' "$state/accounts.env")
curl_sg https://plc.directory/$did                            # her DID document, alsoKnownAs at://alice.local.snowglobe.at
curl_sg "https://alpha.local.snowglobe.at/xrpc/com.atproto.repo.listRecords?repo=$did&collection=community.lexicon.calendar.event"
```

The last line lists the events atmo has written to alice's repo.

**Groups: atmo's confidential client.** With the loopback client, atmo's group page says group
creation is not configured. To create and link a group, atmo needs its confidential OAuth client, at
an https origin where the PDS can fetch its client metadata and keys. The snowglobe gives that origin
with an app route. From the snowglobe checkout:

```bash
snowglobe app atmo 5454                       # https://atmo.app.local.snowglobe.at -> port 5454
snowglobe invite GROUP_PDS_INVITE_CODE ../atmo-events/apps/web/.env
```

Then in `atmo-events/apps/web`, set `OAUTH_PUBLIC_URL=https://atmo.app.local.snowglobe.at` in `.env`
in place of the empty line, and add a client key. atmo's key script prints the key, so write it
straight into the file:

```bash
printf "CLIENT_ASSERTION_KEY='%s'\n" \
  "$(npx tsx src/lib/atproto/scripts/generate-key.ts 2>/dev/null | tail -1)" >> .env
```

Run atmo where nginx can reach it, still under `snowglobe run`:

```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=atmo.app.local.snowglobe.at \
HTTPS_RUN_EXTRA_NAMES=mygroup.local.snowglobe.at \
  snowglobe run pnpm dev --host 172.18.0.1 --port 5454 --strictPort
```

- `--host` replaces the `127.0.0.1` in atmo's `vite.config.ts`. Use the address that
  `host.docker.internal` has inside the containers, usually the `docker0` address. `172.18.0.1` above
  is an example. Check yours with `docker exec <project>-nginx-1 getent hosts host.docker.internal`.
- `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` lets vite answer requests for `atmo.app.local.snowglobe.at`.
- `HTTPS_RUN_EXTRA_NAMES` maps, for atmo's process, the handle of the group you are about to
  create, since `snowglobe run` reads its names only at start.

Open `https://atmo.app.local.snowglobe.at` in the browser set up above, or from the network's page at
`https://local.snowglobe.at/`, which links every routed app. Public DNS answers the name with 127.0.0.1, so a browser on this machine needs only the CA. On
another machine the proxy's PAC covers the name, and only the proxy's port (or 443) needs forwarding. Sign in, then create the group under groups. The form
mints the group's account on the alpha, then has you sign in as the group to link it. The groups
e2e below creates a group the same way on every run, through atmo's own create.

**Sealed, as on a snowglobe.** The `deploy/snowglobe` branch of
[tompscanlan/atmo-events](https://github.com/tompscanlan/atmo-events/tree/deploy/snowglobe) runs with
`PUBLIC_ATPROTO_SEALED=true`: it refuses to start without its network's addresses and turns off every
public service with no stand-in. The snowglobe has an https name for each, so the settings mirror a
snowglobe's. With the steps below, a browser goes from the network's page to atmo and a signed-in
session, and no request leaves the snowglobe.

1. Lexicons, from the snowglobe checkout: the two permission sets above, and the proposal's lexicons
   from its `main` branch. Its `lex-refactor` branch changed `group.opensocial.meta`, and atmo's
   sign-in then fails at the PDS with `Unable to retrieve space declarations`.

   ```bash
   mkdir -p data/proposal-main
   git -C ../opensocial-proposal archive origin/main lexicons | tar -x -C data/proposal-main
   snowglobe lexicons data/proposal-main/lexicons
   ```

   Without `dig`, look up a lexicon authority over DNS-over-HTTPS in the copy loop above:
   `curl -s -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=_lexicon.$authority&type=TXT" | jq -r '.Answer[0].data'`.
2. An account to sign in with, made before atmo starts: `snowglobe account <name> <PREFIX>`.
3. Route atmo, then from `atmo-events/apps/web` make its `.env` with its own script (it writes the
   cookie secret and client key and prints neither), and its tables:

   ```bash
   snowglobe app atmo 5454     # from apps/web; or run it from the snowglobe checkout
   npx tsx src/lib/atproto/scripts/setup-dev.ts
   pnpm exec wrangler d1 migrations apply DB --local
   ```
4. Add to `.env`:

   ```
   OAUTH_PUBLIC_URL=https://atmo.app.local.snowglobe.at
   PUBLIC_ATPROTO_SEALED=true
   PUBLIC_ATPROTO_PLC_URL=https://plc.local.snowglobe.at
   PUBLIC_ATPROTO_SLINGSHOT_URL=https://slingshot.local.snowglobe.at
   PUBLIC_ATPROTO_JETSTREAM_URLS=wss://jetstream.local.snowglobe.at
   PUBLIC_ATPROTO_RELAY_URLS=https://relay.local.snowglobe.at
   PUBLIC_ATPROTO_SIGNUP_PDS=https://alpha.local.snowglobe.at
   PUBLIC_ATPROTO_BLOB_URL_TEMPLATE=https://alpha.local.snowglobe.at/xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}
   PUBLIC_NETWORK_NOTICE=Local snowglobe: not Bluesky, test data only.
   PUBLIC_NETWORK_NOTICE_URL=https://local.snowglobe.at/
   ```

   The image template reaches the alpha's own blobs only; a snowglobe's image service finds any
   account's server.
5. Run it under `snowglobe run`, on every address so nginx can reach it:

   ```bash
   __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=atmo.app.local.snowglobe.at \
     snowglobe run pnpm dev --host 0.0.0.0 --port 5454 --strictPort
   ```

Open `https://local.snowglobe.at/` and follow its atmo link. Signing in sends you to
`https://alpha.local.snowglobe.at` for the password and the consent page, and back to atmo.

**The groups e2e.** It makes its fixtures with the same tools. From the snowglobe checkout, after the
lexicons above:

```bash
export ACCOUNTS_FILE=$PWD/data/atmo-e2e.env       # the test's logins, kept mode 600
snowglobe account e2e-owner E2E_OWNER
snowglobe account e2e-admin E2E_ADMIN
snowglobe account e2e-outsider E2E_OUTSIDER
snowglobe account e2enospaces E2E_NOSPACES regular   # a member on a PDS without spaces
unset ACCOUNTS_FILE
snowglobe invite E2E_INVITE_CODE data/atmo-e2e.env   # each run mints its group with one use
# what the test reads: URLs, DIDs, the handle domain and where the secrets are; no secret
{ grep -E '^E2E_[A-Z]+_DID=' data/atmo-e2e.env
  snowglobe env --dotenv --app atmo | grep -E '^E2E_(PDS|PLC_URL|HANDLE_DOMAIN)='   # needs an `atmo` entry under `apps:` whose `env:` maps these three; add one to your copy of atmo.yml
  echo "E2E_CREDENTIALS=$PWD/data/atmo-e2e.env"; } > data/atmo-e2e.fixtures.env
```

Then from atmo's `apps/web`, under `snowglobe run`. Start it after the accounts exist, so their handles
are mapped:

```bash
snowglobe run sh -c \
  'set -a; . ../../../snowglobe/data/atmo-e2e.fixtures.env; set +a; node scripts/groups-e2e.mjs'
# ...
# SUMMARY: 49 passed, 0 failed
```

The test refuses any host that is not this machine. Under `snowglobe run` the snowglobe's names resolve to
127.0.0.1, so it admits them. Without `snowglobe run` it refuses them before any login. The test is
`apps/web/scripts/groups-e2e.mjs` on the `feat/groups-opensocial` branch of
[tompscanlan/atmo-events](https://github.com/tompscanlan/atmo-events/tree/feat/groups-opensocial/apps/web/scripts).

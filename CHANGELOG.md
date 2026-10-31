# Changelog

Changes to the default stack that existing setups will notice:

## Unreleased

- **Signing in through PDSls works.** PDSls's Add account failed with "Unable to obtain client
  metadata ... Connection refused": inside a PDS only names under `app.<domain>` led to nginx, so
  `pdsls.<domain>` led to `127.0.0.1`, the PDS's own container. Each PDS now sends every name under
  the domain to nginx, as a group host already did. You can now sign in to PDSls, or make a new
  account in the browser: type the PDS's address, such as `https://main.local.snowglobe.at`, in
  place of a handle, and choose Create a new account. `up` picks up the change.
- **The network page shows Mail as up.** MailDev 3.0.0, the image `latest` pointed at from
  2026-09-23, moved its health check to `/api/healthz`, so the page's check got a 404 and showed
  Mail down, though mail was caught as before. The page asks the new path, and MailDev is pinned to
  3.0.0 so a new release can't move it again unnoticed.
- **`up` restarts nginx when the network page or its config changed.** nginx mounts them one file
  at a time and keeps the copy it started with, so after an upgrade a running snowglobe kept the
  old page and the old health checks until nginx restarted. `up` already did this for nginx's
  template; it now covers `stack/page/snowglobe.conf` and `stack/page/index.html` too, so the
  first `up` after this upgrade restarts nginx once.

## v0.4.0 (2026-10-30)

- **A new install makes its CA.** Installed where npm resolves the dependencies afresh, as in CI
  or on a new machine, 0.3.0 stopped at the first `up` with "Cannot get schema for 'ECParameters'
  target". It pinned two certificate libraries that `@peculiar/x509` also uses, and once newer
  ones came out, npm installed a second copy of each for x509. They now take x509's range, so npm
  installs one copy. A machine that already had its CA was not affected. If you worked around it
  with npm `overrides` for `@peculiar/asn1-schema` and `@peculiar/asn1-x509`, remove them.
- **Jetstream is v2, so apps on `@bsky/jetstream` can read it.** The snowglobe ran an older Jetstream
  build (`sha-05c89f0`) that served only `/subscribe`. A v2 client, such as contrail 0.27,
  subscribes at `/xrpc/network.bsky.jetstream.subscribeEvents` and got a 404. Jetstream is now
  v0.4.6, which serves both, so Slingshot, PDSls and the network page keep reading `/subscribe`.
  Its image is built from `stack/jetstream/Dockerfile`: the pinned Jetstream, plus busybox for the
  health check, since the image has no shell. To move to another Jetstream, change the `FROM` line
  there, and `up` builds it. Its data is in `/data/v2` on the same volume, so a snowglobe made
  before starts Jetstream with an empty archive.
- **Breaking: a file with `relay: false` and Jetstream on now fails `check` and `up`.** At start,
  Jetstream v2 asks the relay for the network's hosts, which a PDS refuses (HTTP 401), so the
  relay runs whenever Jetstream does, with one PDS too: `relay: auto`, the default, now turns it
  on for Jetstream. To upgrade, remove `relay: false`, or set `jetstream: false` and
  `slingshot: false` (Slingshot reads Jetstream). With Jetstream off, one PDS still runs no relay,
  and Tap reads that PDS.
- **`up` restarts the relay when a PDS or nginx started after it.** A relay that was running when
  a PDS went away redials it, and after ten quick failures it waits 30 s between dials. Pass 2 of
  every first `up` recreates the PDSes, so a record written right after `up` could reach Jetstream
  or Tap half a minute late, or not for minutes. `up` restarted the relay only when a rerun added
  a PDS. Now it restarts it whenever a PDS, or nginx in front of them, started after the relay
  did: once on a first `up`, which takes a few seconds longer, and on a rerun after a PDS
  restarted. With the relay on for Jetstream, this now happened with one PDS too.
- **Jetstream has only what is written after its first start.** It starts with an empty archive,
  its backfill of the PDSes fails (below), and it follows the relay from that moment. A record
  written before then never comes through Jetstream, not even in a replay from the start. That
  includes every record in a snowglobe made before this version. The records are still on the
  PDS, so an app that needs them reads them there, for example with a backfill.
- **A new snowglobe's first `up` takes a minute or two longer.** `up` now waits until Jetstream
  serves: about 75 seconds with one PDS and 95 with three, in our runs. Jetstream's first start
  tries to backfill each PDS directly, and its HTTP client refuses private addresses, which is
  where every PDS is in Docker; v0.4.6 has no setting to allow them. It retries, gives up, and
  then follows the relay. When the relay has not yet heard from a PDS, Jetstream skips the
  backfill and is ready sooner.

## v0.3.0 (2026-10-24)

- **What snowglobe writes and says names the installed command.** The headers of the files it
  renders, its errors and the 404 for an unregistered app said `bin/snowglobe.mjs`, a path that
  works only in a checkout of snowglobe; they now say `snowglobe up`, `snowglobe render` and
  `snowglobe app`. The default file says `snowglobe up` too, and links its docs on GitHub, since
  the package ships no `docs/`.
- **The network page names only what the globe runs.** Its first line said "relay and Jetstream" on
  every globe, though one PDS runs no relay; it now lists the services that run. With
  `services.jetstream: false` the Activity panel says the network has no Jetstream, instead of
  reconnecting to one forever.
- **A first `up` with one PDS and no relay no longer fails on a slow machine.** The default file is
  one. `up` recreates the PDSes once the lexicon authority exists, and Jetstream, which reads the PDS
  itself when there is no relay, could still be restarting when compose checked it ("jetstream is
  unhealthy"). It is now stopped first and started again once the PDS is healthy. CI runs the
  [Statusphere example](docs/examples/statusphere.md)'s whole flow, which found it.
- **A second snowglobe on the same machine starts with no settings.** Every port a snowglobe publishes
  (nginx, the proxy, the PLC, Jetstream, MailDev) is on its own loopback address now, not always
  `127.0.0.1`, so two snowglobes no longer fight over MailDev's port. The first `up` picks the address
  (`127.0.0.1` if nothing answers there, else the next `127.0.0.N`) and keeps it in the `bind` file in the
  snowglobe's state folder. `SG_BIND` still sets it by hand. A snowglobe that is running from before keeps `127.0.0.1`.
  `snowglobe env` reports MailDev's page at the snowglobe's own address.
- **Tap can send an app its events.** `services.tap` takes a map: `webhook` (a URL; it may hold
  `${apps.<name>.url}`), `signal_collection` and `collection_filters`. An app reads Tap at
  `${services.tap.url}` (`http://<the snowglobe's address>:2480`; `SG_TAP_PORT` changes the port), which is now published on the snowglobe's own address.
  Tap runs in a DNS container's network (`tap-dns`) so it reaches the app's https name and checks
  handles; run `snowglobe up` again to recreate it. The Tap image is pinned by digest, not `latest`. `tap: true` still works and sets none of it.
- **`snowglobe ls` lists your snowglobes, and `up` and `down` can name one.** `ls` shows each
  snowglobe's name, domain, whether it is running, and the file that owns it. `up` and `down` take a
  file (`-f <file>`, or the path as before) or a snowglobe's name from `ls`, from any folder, so one
  checkout can bring up and take down any snowglobe you run. `down <name>` also works when the
  file is gone. `up <name>` stops, before starting anything, if the file's `globe:` line has been
  renamed since, and says what it is called now.
- **`up` pulls Slingshot, PDSls and the relay instead of building them.** A first `up` built them
  from source, about four minutes on one machine (Slingshot 137 s, the relay 78 s, PDSls 27 s).
  They are published on each release tag to `ghcr.io/openmeet-team`, and `up` uses one only when
  its label matches the files in your checkout, so an edited `stack/` folder or another
  `SG_SLINGSHOT_COMMIT` is still built. `SG_PREBUILT=0` turns the pull off; `SG_IMAGE_REGISTRY`
  moves it ([Configuration](docs/configuration.md)).
- **The network page says its activity feed covers the last 24 hours.** It asked Jetstream for a week,
  but Jetstream keeps a day of events (`JETSTREAM_EVENT_TTL`, 24 hours by default), so older writes
  were never listed. The page now asks for a day and says so.
- **The compose files and the folders they build from are under `stack/`.** `docker-compose*.yml`,
  `pdsls/`, `relay/`, `slingshot/`, `https/`, `page/` and the init script moved there; they are
  the pieces `snowglobe up` renders, not files to run. Nothing in your state folder changes.
- **Each snowglobe has its own random secrets.** There are no defaults any more for the PDSes'
  admin password, JWT secret and PLC rotation key, the relay's admin password, or the PLC
  database's password. The first `up` makes them and keeps them in `secrets.env` (mode 600) in the
  snowglobe's state folder, and `account` and `invite` read the admin password from there. A
  setting of the same name (`SG_PDS_ADMIN_PASSWORD`, `SG_PDS_JWT_SECRET`, `SG_PLC_ROTATION_KEY`,
  `SG_RELAY_ADMIN_PASSWORD`, `SG_DB_PASSWORD`) is used instead. A snowglobe that already has
  data keeps the old fixed values of the last four, since its database and its DIDs were made with
  them, and `up` says so; `snowglobe down -v` and `up` start it over with random ones (`down -v`
  drops the fixed values from `secrets.env` once Docker has removed the volumes; if it fails, they
  stay). If Docker cannot say whether the snowglobe has data, `up` stops and asks you to start
  Docker and run it again, rather than choose the secrets blind. A snowglobe
  whose admin password is already in `admin.env` (from the release before this one) keeps it:
  `account` and `invite` read it from there, and `up` leaves it. `.env.example` now shows
  `local.snowglobe.at`, the default domain, not `devnet.test`.
- **The default snowglobe is one PDS now.** `snowglobe.default.yml` runs one current PDS, `main`,
  with the PLC, Jetstream, Slingshot, PDSls and the accounts `alice` and `bob`, and holds commented
  examples for adding more. The old default (the permissioned-spaces alpha, a current release and an
  older one, with a relay and a lexicon authority) is `docs/examples/atmo.yml`. To keep it, copy that file to
  `snowglobe.yml`. A snowglobe that was brought up from the old default keeps its own `snowglobe.yml`
  or `--default` choice: bring it up from `docs/examples/atmo.yml`, not the new default, or it starts over under
  new PDS names (unchecked: how an existing one reacts to the new file).
- **The docs moved.** The README is short now, and the guides are under `docs/`, starting with
  [The snowglobe](docs/snowglobe.md). The quick stack (`npm run up`) is gone; the [v0.2.0 tag](https://github.com/OpenMeet-Team/snowglobe/tree/v0.2.0) has it.
- **A snowglobe keeps its state in your own account, not in the checkout.** It is in
  `~/.local/share/snowglobe/<name>/` (under `XDG_DATA_HOME` if you set it, `%LOCALAPPDATA%\snowglobe`
  on Windows), where `<name>` is the `globe:` line of its `snowglobe.yml`, and the Docker Compose
  project has that name too unless `SG_PROJECT` is set. There is one CA per user, in `ca/` beside the
  snowglobes' folders. A command finds the `snowglobe.yml` in the folder you are in or the nearest
  one above; `up` with none refuses, and `up --default` runs the default file, whose name is
  `snowglobe` (it was `devnet` for a while; see the rename below). Nothing is moved for you. A checkout that still holds a snowglobe in its `data/` makes
  `up` stop, change nothing, and print the commands that move the files; to keep the running
  containers and volumes, run `up` again with `SG_PROJECT` set to the old project's name, as it
  prints. Either way you trust a new CA once, with `snowglobe trust`.
- **Apps are at `<app>.app.<domain>`, not `<app>.devnet.internal`.** Public DNS already answers
  those names, and the CA no longer vouches for `devnet.internal`. To move an app, in this order:
  run `snowglobe up`, which redoes the routes and the certificate and recreates nginx; then change
  the app's `OAUTH_PUBLIC_URL`, its OAuth client ids and its allowed hosts (for vite,
  `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`) to `<app>.app.<domain>`; then restart anything running
  under `snowglobe run`, which reads its names when it starts. `app` is now a reserved name: `up`
  refuses a saved route whose handle ending is `app`. The browser proxy's PAC follows by itself;
  Chrome launch flags drop the `MAP *.devnet.internal` rule.
- **An app's settings come from `snowglobe env`, and `data/devnet.env` is gone.** `up` no longer
  writes it, and removes an old one. Map the addresses an app needs under the app in `snowglobe.yml`
  (`env:`), then `eval "$(snowglobe env)"`, `snowglobe env --dotenv > .env.local`, or
  `snowglobe run`. Anything that sourced `devnet.env` reads these instead
  ([An app's settings](docs/your-app.md#snowglobe-env-know-where-things-are)). Account names in the file
  must now be unique.
- **The default snowglobe is named `snowglobe`, not `devnet`, and its Docker names follow.** The
  state folder is `~/.local/share/snowglobe/snowglobe`, the Docker network is `snowglobe`, the images
  are `snowglobe-dns`, `-proxy`, `-pdsls`, `-relay` and `-slingshot`. Your CA is kept. If you made the default snowglobe under the old name, `up --default` stops
  and changes nothing; it prints the commands. To keep its accounts, move the folder and keep the old
  compose project: `mv ~/.local/share/snowglobe/devnet ~/.local/share/snowglobe/snowglobe`, then
  `SG_PROJECT=devnet snowglobe up --default`. To drop it, `down -v` it and delete the folder.
  Either way the old Docker network `devnet_atproto-devnet` is left behind: remove it with
  `docker network rm devnet_atproto-devnet` once nothing uses it.
- **The network page's facts are at `/snowglobe.json`, not `/globe.json`.** `up` writes
  `https/nginx/snowglobe.json` and the page reads it. Anything that fetched `globe.json` from a
  snowglobe uses the new name after its next `up`.
- **`snowglobe trust` puts your CA in the system and browser trust stores.** `--dry-run` shows what it
  would do, `--remove` undoes it. macOS and native Windows are untried.
- **Tap is off by default.** Nothing in the default snowglobe attaches to it. Turn it on with
  `services: { tap: true }`.
- **A globe made before 2026-10-20 failed on its next `up`.** Snowglobe builds the `slingshot-dns`,
  `proxy` and `pdsls` images itself, and Docker keeps an old copy when their source changes. With
  the old copies, `up` stops with `cannot join network namespace` while `slingshot-dns` restarts.
  Fixed since: each of those images is tagged by a hash of its Dockerfile and the files it copies, so
  a change rebuilds it, and a failed compose step in `up` says how to clear a stale image. To rebuild
  by hand, after an `up` has rendered the snowglobe:
  `docker compose -p <project> --project-directory . -f <state>/globe/compose.yml build slingshot-dns proxy pdsls`.
- **The repo is `OpenMeet-Team/snowglobe`, and every setting is `SG_*`.** It was
  `OpenMeet-Team/atproto-devnet` until 2026-10-20; GitHub sends the old address here. Projects that
  use it still look for it beside them at `../atproto-devnet`, so clone it under that name. The
  settings that were `DEVNET_*` and `SNOWGLOBE_*` are `SG_*` with the same ending (`DEVNET_BIND` is
  `SG_BIND`, `SNOWGLOBE_FILE` is `SG_FILE`). The old names still work for now, from the environment
  or `.env`: `bin/snowglobe.mjs` warns once and reads them as the new ones, and the plain stack's
  compose files and scripts fall back to them. Files written before (`data/devnet.env`,
  `data/accounts.env`, the rendered globe) are read either way.
- **The https devnet's default domain is `local.snowglobe.at`, not `devnet.test`.** A PDS refuses
  an OAuth client under `.test`, so at `devnet.test` nobody could sign in through a group host or
  PDSls. A globe run from the default file, or from a `snowglobe.yml` that names no domain, moves on
  its next `up`, which stops at the certificates: the CA was made for `devnet.test` and can't vouch
  for the new names. To keep the old name and its accounts, add `domain: devnet.test` to its
  `snowglobe.yml`. To move, run `bin/snowglobe.mjs down -v` (it drops every account), delete
  `data/https/ca.*`, run `up`, and trust the new `ca.crt`. The browser proxy's PAC follows the domain
  by itself; Chrome launch flags have to name the new one. The plain http stack keeps `devnet.test`.
- **The https devnet is rendered from a `snowglobe.yml` now, and a running one starts over.**
  `snowglobe up` writes `data/globe/` with `bin/snowglobe.mjs render` (from `SG_FILE`, else
  `snowglobe.default.yml`: the same alpha, regular and prod) and runs that one compose file;
  `docker-compose.https.yml` is gone. Each PDS is its own service on the compose network, named
  `pds-<name>`, so the alpha is `pds-alpha`, not `pds`, and its data volume is `pds-alpha-data`, not
  `pds-data` (`pds-regular-data` and `pds-prod-data` keep their names). On a devnet brought up
  before this, the alpha would start on a new, empty volume while the PLC still holds its accounts'
  DIDs, and the old `pds` container would be left running beside it. So take such a devnet down with
  the previous checkout first, `-v` included, and the next `snowglobe up` starts it fresh. The plain
  http stacks are unchanged.
- **The `scripts/https-*` tools are gone: use `bin/snowglobe.mjs up`, `down` and `run`.** To keep
  the old layout, check out tag `v0.2.0`, the last version that has them. `https-up.sh` is `up`
  (the file can also be its argument, and `up` now seeds the file's `accounts`, `lexicons.publish`
  and `apps`), `https-down.sh` is `down`, which takes
  `-v` and nothing else, and `https-run` is `run`. `run` now maps every name the rendered globe
  answers to, each PDS in the file included, not a fixed three, to `SG_BIND`. `data/devnet.env`
  takes the Jetstream, maildev and proxy ports from `.env` too, as compose does.
- **snowglobe is `bin/snowglobe.mjs` now.** Its code moved from `scripts/` to `lib/`, one file per
  command under `lib/commands/`. `scripts/snowglobe` still runs it, so a script that calls the old
  path keeps working.

## v0.2.0 (2026-10-20)

- **The PDS no longer forwards to Bluesky's AppView.** `app.bsky.*` reads and any method the PDS
  doesn't implement now go to `https://appview.invalid` and fail with `502 UpstreamFailure`.
  Bluesky's AppView never indexed devnet accounts, so for those accounts nothing useful is lost.
- **DID resolution works again on current `pds:0.4` pulls.** Since `@atproto/pds` 0.5.34, the PDS
  refuses to resolve DIDs through an `http://` PLC unless SSRF protection is off, and the floating
  `pds:0.4` tag now pulls 0.5.36. Without the fix, `describeRepo`, OAuth and anything else that
  resolves a new DID fails with `Forbidden protocol "http:"`. The PDS now sets
  `PDS_DISABLE_SSRF_PROTECTION=true`, so it can also fetch private addresses, such as an OAuth client's
  metadata on your machine. The default stack still uses http. The
  [https devnet](docs/snowglobe.md) keeps SSRF protection off too, for another reason: every address
  a PDS fetches from there (nginx, the PLC, your machine) is a private one, and the protected fetch
  refuses private addresses.
- **init reseeds when `data/` is stale.** `data/` outlives `npm run down`. init used to skip seeding
  whenever `data/accounts.json` existed, leaving credentials for accounts that were gone. It now
  checks that the first recorded account exists on the running PDS and reseeds if it doesn't, so
  `data/accounts.env` gets new DIDs and a new invite code.
- **The PDS runs as root.** Release images already did. This lets `SG_PDS_IMAGE` take monorepo
  images, which default to `node`.
- **The https devnet's nginx config is a template now: rerun `bin/snowglobe.mjs up` after pulling.**
  `https/nginx.conf` became `https/nginx.conf.template`, which the nginx image fills in with
  `SG_DOMAIN` when it starts. An nginx container made before the pull still mounts the old file,
  and once the file is gone that container cannot start again (Docker leaves an empty directory in
  its place). `snowglobe up` recreates it on the new mount. Checking out an older version needs the
  same rerun, the other way round. An overlay that mounts its own config over
  `/etc/nginx/conf.d/default.conf` should mount it at `/etc/nginx/templates/default.conf.template`
  instead, and one that replaces nginx's command must keep the image's entrypoint, which writes the
  template out.

## v0.1.0 (2026-02-12)

The first release.

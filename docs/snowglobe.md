# The snowglobe

A snowglobe is the atproto network a `snowglobe.yml` describes ([The file and the commands](#the-file-and-the-commands)).
`snowglobe up` renders the file into one compose file (`snowglobe render`) and
brings it up; with no file named, it uses the `snowglobe.yml` in this folder or above (copy
`snowglobe.default.yml` to start). Every PDS sits at an https name, as on the real network, so an app
built for the real network runs against it with no test-only code.

It runs on Linux, and on Windows under WSL 2; both are tested with `node scripts/smoke.mjs`
([Test suite](testing.md#test-suite)). macOS is not supported yet. If you have a Mac, please try it
and [open an issue](https://github.com/OpenMeet-Team/snowglobe/issues) with what broke, or that it
worked.

With `docs/examples/atmo.yml`, which has three PDSes (the default file has one, `main`), and `<domain>`
its domain, `snowglobe.local.snowglobe.at`:

| Name | Served by |
| --- | --- |
| `alpha.<domain>`, `*.<domain>` | `pds-alpha`, the spaces alpha (`79d6307e`), and its handles; invites required |
| `regular.<domain>`, `*.regular.<domain>` | `pds-regular`, a current release, and its handles |
| `prod.<domain>`, `*.prod.<domain>` | `pds-prod`, an older release (0.4.5009, pinned by digest), and its handles |
| `slingshot.<domain>` | `slingshot`, which answers a handle's DID and PDS ([Slingshot](how-it-works.md#slingshot-handles-and-dids-inside-the-network)) |
| `plc.<domain>`, `relay.<domain>`, `jetstream.<domain>` | the PLC, the relay and Jetstream, as a snowglobe names them, so an app reaches them over https too |
| `pdsls.<domain>` | `pdsls`, the record browser ([PDSls](https://pds.ls)) for this network (below) |
| `<domain>` | nginx itself: the network's page, the one a snowglobe serves at its bare name (below) |
| `<name>.app.<domain>` | an app on this machine, at the port `snowglobe app` recorded for `<name>` |
| `*.<ending>.<domain>` | the app that claimed `<ending>` with `snowglobe app`, for the handles it hands out |

Each PDS in the file is a service of its own, `pds-<name>`, at `<name>.<domain>`; the one with
`bare_handles` takes `*.<domain>`, and every other its own `*.<name>.<domain>`. nginx answers all of
them on port 443 of the snowglobe's own loopback address, with one certificate from a local CA. Each
PDS's public URL, OAuth issuer and DID document endpoint is `https://<its name>`, and the relay crawls
every PDS as a `wss://` host. Inside the compose network nginx also answers to every PDS's name, so the
PDSes, the relay (and Tap, when on) reach each other over TLS; no service shares another's network but
Slingshot. On the machine, public DNS answers every name under the domain with `127.0.0.1`, where the
[name router](#the-name-router) passes it on to this snowglobe, so the names work for any program, a
handle made a second ago included. `plc.directory` is the real directory everywhere; an app is told
the snowglobe's own PLC, `https://plc.<domain>` ([Your app in a snowglobe](your-app.md)).

The domain is `<globe>.local.snowglobe.at` unless the file names one: each snowglobe gets its own, so
the name router can tell them apart by name alone. `local.snowglobe.at` is ours, and its public DNS
points every name under it, at any depth, at `127.0.0.1`, so a name that escapes a snowglobe lands on
your machine, not on someone else's server. A `domain:` line in the file, or `SG_DOMAIN`, picks
another. Pick freely, but not one under `.test`, `.local`, `.localhost`, `.invalid` or `.example`: the
stack comes up there, but a PDS refuses an OAuth client at such a name, so nobody can sign in through
a group host or PDSls. A domain outside `local.snowglobe.at` has to resolve to `127.0.0.1` the same
way for the router to reach it, and two snowglobes cannot be up at one domain: `up` refuses the
second. Set `SG_DOMAIN` in the environment or in `.env` and the same stack comes up under that domain:
`<name>.<domain>` for each PDS, with handles at `<name>.<domain>` for the one with `bare_handles`;
apps follow the domain, at `<name>.app.<domain>`. In `.env`, write the domain itself (quotes, `export`
and a trailing comment are fine); the scripts refuse a `${...}` there, which compose would expand and
they would not. Your one CA can vouch only for names under `local.snowglobe.at`, a domain outside it
that it was made under, and `plc.directory` ([The CA](browser.md#the-ca)). For another domain outside
`local.snowglobe.at`, delete `<state root>/ca/` and run `up` again; that makes a new CA, which you
trust again, and every snowglobe then uses it.

The snowglobe knows no app. It has no app's accounts, invite codes, lexicons or ports. It gives an app
tools to make its own ([Your app in a snowglobe](your-app.md)), and using them is optional.

## The network's page

`https://<domain>/` is the network's own page (`page/index.html`): every service and its
health, every account on each PDS, the apps `snowglobe app` routed, and the network's writes
from Jetstream, the last 24 hours, then live. nginx serves it with this snowglobe's relays (`stack/page/snowglobe.conf`), a fixed GET-only path per read, so the page
asks nothing but `<domain>`. `snowglobe up` and `snowglobe app` write what it lists into
`<state>/https/nginx/snowglobe.json`. Open it from a browser set up as in [From a browser on your own
computer](browser.md#from-a-browser-on-your-own-computer), or read the facts it shows from a script: `curl -s --cacert ~/.local/share/snowglobe/ca/ca.crt https://snowglobe.local.snowglobe.at/snowglobe.json`
prints them as JSON. The file lists the snowglobe's services, its PDSes and group hosts (each with the path the page
reads its accounts from; the handles and DIDs are not in the file) and its apps, so a test or tool can find where things
are without a copy of the snowglobe's file.

## PDSls: browsing the network's records

`https://pdsls.<domain>/` is [PDSls](https://github.com/notjuliet/pdsls), the record browser at
pds.ls, for this network: `https://pdsls.<domain>/at://alice.<domain>` shows her repo, its
collections and records, as `https://pds.ls/at://...` does on the real network. Apps that link to
pds.ls point their links here on a snowglobe. `stack/pdsls/` builds it from a pinned upstream commit
with `stack/pdsls/network.patch`, which lets the page that loads it give it a network's addresses (unset,
it is the public network's, unchanged), and `stack/pdsls/server.mjs` serves it with this network's: the PLC
at `plc.<domain>`, Jetstream and the relay as the stream page's defaults, and the lexicon authority
for every NSID. It looks up handles and `did:web` documents for names under the domain only, and
turns off what has no stand-in here: DNS lookups, Bluesky search and avatars, backlinks, Spacedust,
the public font host, link previews. Signing in uses a client at its own address, so editing records
works against the snowglobe's PDSes.

A record's Schema tab shows its lexicon when the authority holds it and PDSls's parser accepts it.
Some lexicons fail that parser, as they would on pds.ls. Examples are the opensocial proposal's
lexicons (a `space` definition, a `space-ref` format) and atmo's permission set. The record view
still works for them.

## The name router

One name router serves every snowglobe on the machine: a stock nginx (the image each snowglobe's nginx
runs) in an ordinary container named `snowglobe-router`, with port 443 published on `127.0.0.1`. It reads
the name each TLS connection asks for and passes the connection, still encrypted, to the nginx of the
snowglobe whose domain the name is under, which it reaches by container name on that snowglobe's
Docker network; each snowglobe's nginx serves its own certificate. The longest domain wins, so a
snowglobe still on the shared `local.snowglobe.at` keeps working beside ones under it, and a name under
no snowglobe's domain is closed. It is how a hosted globe works too, where the cluster's gateway routes
by name. Because it needs only a published port, it needs no Docker setting.

`snowglobe up` adds the snowglobe's route, joins the router to the snowglobe's network and starts the
router if it is not running; `snowglobe down` takes the route away and the router off that network
before compose removes it, and removes the router with the last route. Snowglobe puts nothing else
on the router's own network, `snowglobe-router`. `snowglobe ls` ends with a line saying whether
it runs and what it routes. It runs on Linux with Docker Engine, WSL 2 included; Docker Desktop is not
tested. On other systems, or with `SG_ROUTER=off`, there is no router: a new snowglobe takes the first
free address from `127.0.0.1` as before 0.5.0, and only the one on `127.0.0.1` is reached by name
(`SG_BIND=127.0.0.1` puts one there). A snowglobe
on `127.0.0.1` (set with `SG_BIND`, or made before 0.5.0 and still running) holds the router's address,
so the router does not start while it runs, and `up` says how to move it.

## The file and the commands

One file says what a snowglobe runs: `snowglobe.yml`. It belongs in an app's repo, next to the lexicons
it publishes, and is committed. Everything the snowglobe makes while it runs (the CA's key, passwords,
invite codes, app routes) goes in the snowglobe's state folder, in your own account and in no repo
([What it writes](#what-it-writes)).

```yaml
globe: bookclub                  # lowercase letters and digits; the snowglobe's own name
# domain: bookclub.local.snowglobe.at   # every name below is under it; left out, it is this, the globe's own

pds:                             # at least one; each is pds-<name> at https://<name>.<domain>
  - name: alpha
    image: spaces-alpha          # a short name (pinned by digest), or any image reference
    bare_handles: true           # handles <name>.<domain>; at most one PDS. Others: <name>.<pds>.<domain>
    invites: required            # open (default) or required
  - name: regular
    image: ghcr.io/bluesky-social/pds:0.4.5037

grouphosts:                      # optional; each is grouphost-<name> at https://<name>.<domain>
  - name: gh                     # its groups' handles are <group>.gh.<domain>
    kind: opensocial             # atproto-group-host, the only kind so far
    build: ../atproto-group-host # a folder with a Dockerfile, from this file's folder; or image:

services:                        # each true or false; these are the defaults
  relay: auto                    # auto: on with Jetstream, which reads it, or more than one PDS
  jetstream: true
  tap: false                     # off by default. true, or a map for an app that takes events from it:
                                 #   tap: { webhook: ${apps.myapp.url}/api/webhook, signal_collection: com.example.thing }
                                 # the app reads Tap at ${services.tap.url}
  slingshot: true                # needs jetstream
  pdsls: true

lexicons:
  authority: alpha               # the PDS lex-authority is made on (the bare-handle PDS by default)
  publish: lexicons              # a folder next to this file; up publishes every lexicon in it

accounts:                        # <name>@<pds>; up makes each one
  - owner@alpha
  - reader@regular

apps:
  - name: bookclub
    local: { port: 5173, handles: bc }   # https://bookclub.app.<domain>; handles: only for an app that hands out
                                         # handles of its own, as a PDS does. Names under bc.<domain> then go to the app
```

`snowglobe check` says what is wrong with a file, one line per problem, and touches
nothing. A name used twice, a PDS named like a service, an app's handle ending that is a PDS's
name, a handle longer than DNS allows: each fails here, before anything starts. `hosted`, an
app's `hosted` and `services.cdn` (an image service) are read and checked for a snowglobe hosted on a
server; a local snowglobe does not use them. A hosted snowglobe, such as lighthouse, also runs one PDS and
one group host today, whatever its file lists.

**Group hosts** are optional. Each one runs beside the PDSes as a service of its own at
`https://<name>.<domain>`, with every group's handle under `<name>.<domain>`; nginx, the
certificate and the network page (its health, and its groups under accounts) get each one, as they
get each PDS. The one kind, `opensocial`, is
atproto-group-host, which is not public yet and publishes no image,
so `up` builds it from a checkout with the repo's own Dockerfile, on every run (Docker's cache keeps
an unchanged one quick). The checkout is the group host's `build` folder in the file, else
`SG_OPENSOCIAL_BUILD` (a path from where you run the command), so a file shared between
machines can leave it out:

```bash
SG_OPENSOCIAL_BUILD=../atproto-group-host snowglobe up ../myapp/snowglobe.yml
```

`image:` in place of `build` runs a built image instead. With neither, and the variable unset,
`render` and `up` stop before anything changes and say so. A group host makes its groups' accounts
itself, takes no invite code, and resolves every name under the domain through nginx, its members'
handles too. A group's handle resolves on the machine as soon as the group is made, like any handle.

`up` seeds what the file asks for, every run, and a rerun changes nothing that is already there:

- **accounts**: each one is made with `snowglobe account` ([Tools for an app](your-app.md#tools-for-an-app)). Its login goes to
  `<state>/accounts.env` as `<NAME>_*` on the PDS with bare handles (else the first), where init's
  `alice` and `bob` are, so `alice@alpha` is init's own alice; on any other PDS as
  `<NAME>_<PDS>_*`, so `reader@regular` is `READER_REGULAR_*`. Passwords are generated and never
  printed.
- **lexicons.publish**: every lexicon in the folder, at any depth, goes into the authority as
  `snowglobe lexicons` does; an unchanged one is left alone, and other JSON is skipped.
- **apps[].local**: the route `snowglobe app <name> <port> [<handles>]` would make, set before the
  certificate and nginx, so both have it. A route made by hand with `snowglobe app` stays.

The commands, each `snowglobe <command>`:

| Command | What it does |
| --- | --- |
| `check [<file>]` | checks a file |
| `render [<file>] [--out <dir>] [--domain <domain>]` | writes the snowglobe it describes into `<state>/globe/`, or `<dir>` (`up` does this itself); `--domain` replaces the file's domain, for a copy beside another snowglobe |
| `certs [--check]` | makes your CA, once, and the leaf nginx serves (`up` does this itself) |
| `trust [--remove] [--dry-run] [--no-sudo]` | puts your CA in the system and browser trust stores, or takes it out ([From a browser on your own computer](browser.md)) |
| `ls` | lists the snowglobes on this machine: name, domain, up or down, and the file that owns each; then whether the name router runs, and what it routes |
| `up [<file> \| <name>] [-f <file>] [--default]` | brings the snowglobe up and seeds it ([Up and down](#up-and-down)) |
| `down [<file> \| <name>] [-f <file>] [-v]` | stops it; `-v` drops its volumes too |
| `env [--app <name>] [--secrets] [--dotenv]` | prints the settings an app is handed ([An app's settings](your-app.md#snowglobe-env-know-where-things-are)) |
| `run [--app <name>] [--] <cmd>` | runs a command with the app's settings, trusting the snowglobe's CA ([Running a command](your-app.md#snowglobe-run-settings-and-the-ca)) |
| `account`, `invite`, `lexicons`, `app` | make an app's own accounts, invite codes, lexicons and routes ([Tools for an app](your-app.md#tools-for-an-app)) |

Exit 2 means the command was called wrong, and 1 that the snowglobe refused.

## Which snowglobe, and where it lives

A command acts on one `snowglobe.yml`: the one you name, else `SG_FILE`, else the nearest
`snowglobe.yml` in the folder you are in or above it. `up` with none of these refuses, because
starting something by accident is worse than asking; `up --default` runs the default file in this
repo, `snowglobe.default.yml` (one PDS, `main`, with `alice` and `bob`). The other commands
fall back to that default.

The file's `globe:` line names the snowglobe. The name gives its state folder, `<state>`, which is
`<state root>/<name>` in your own account, not in the checkout: `~/.local/share/snowglobe` on Linux
and WSL (under `XDG_DATA_HOME` if you set it), `%LOCALAPPDATA%\snowglobe` on Windows. Beside the
snowglobes' folders is `ca/`, your one certificate authority, which they all use. The name also
names the Docker Compose project, unless `SG_PROJECT` is set. A state folder remembers the file that
owns it, and `up` refuses a second file that says the same `globe:`: give one of them another name.
`snowglobe ls` lists them, and `up` and `down` take one by its name from any folder; `down` works
even when the file that owned the snowglobe is gone, `up` needs a file (`up -f <file>`).
The name is the file's `globe:` line, so `up <name>` finds the file that owns it. If you have since
changed that line, `up <name>` stops before it starts anything and says what the file calls itself
now: put the old name back to bring the old snowglobe up, or run `snowglobe up <file>` to start the
renamed one as a new snowglobe.

Docker keeps each snowglobe's data (the PDS, the PLC directory) in volumes named after the project,
and `snowglobe down` leaves them, so the next `up` finds the same accounts. If the volumes outlive
the state folder (you deleted the folder, or changed `XDG_DATA_HOME`), `up` stops with `init failed`
because `alice` already exists; the PDS's log (`docker logs <globe>-pds-main-1`) says `Handle already taken`. Run `snowglobe down -v` to
delete the volumes and start clean, or give the file another `globe:` name.

## Up and down

```bash
snowglobe up --default   # certificates, then the services
snowglobe down           # stop it; -v also drops its volumes (every account and DID)
```

Both run the one compose file `snowglobe up` last rendered, from the repo root:

```bash
snowglobe up ../myapp/snowglobe.yml   # another snowglobe than the default (or -f ../myapp/snowglobe.yml)
snowglobe down -f ../myapp/snowglobe.yml   # -f works the same on down
snowglobe ls                          # every snowglobe on this machine, and which are running
snowglobe up myapp                    # one of them by its name, from any folder
snowglobe down myapp                  # and stop it the same way
docker compose -p <project> --project-directory . -f <state>/globe/compose.yml ps
```

`-f <file>` and a file's path name the same thing: the `snowglobe.yml` to act on, from any folder. Use
`-f` when you want it to read plainly in a script, and when the snowglobe's file has moved: `up` by
name needs the file that owns it, and `up -f <new path>` hands the snowglobe to the file at its new
place. With neither, `up` and `down` read the nearest `snowglobe.yml` in the folder you are in or
above. Give one or the other, not both.

`snowglobe down -v` drops the snowglobe's volumes, and with them the fixed secrets (`secrets.env`)
an older snowglobe kept for its data, so the next `up` starts over with random ones. A plain `down`
keeps both, and so does a `down -v` that fails. If Docker cannot say whether a snowglobe has data,
`up` stops before it saves any secret; start Docker and run it again.

`snowglobe up` is safe to rerun; a rerun leaves the running services as they are, and only the
one-shot `init` and `relay-init` run again. A rerun on a changed file stops what the file no longer
runs. When a PDS, or nginx in front of it, started after the relay did, `up` restarts the relay
before it returns: a relay that was running when a PDS went away can wait a long time before it
redials it, so what the PDS writes meanwhile comes through late, or not for minutes. A first `up`
starts the PDSes twice (below), so it restarts the relay once, and a rerun brings it back to a PDS
that restarted. It refuses a PDS named for a handle ending an app
claimed with `snowglobe app`, before it writes anything. It makes the leaf certificate if there is
none, brings the stack up and routes its domain through the [name router](#the-name-router), makes the lexicon authority (`lex-authority.<domain>` on the file's
`lexicons.authority` PDS, the bare-handle PDS by default),
brings the stack up again with `SG_LEXICON_AUTHORITY_DID` so every PDS starts with it. It writes no
settings file for an app: `snowglobe env` prints them ([An app's settings](your-app.md#snowglobe-env-know-where-things-are)).
The base init seeds `alice` and `bob` and a 100-use `SG_INVITE_CODE`
into `<state>/accounts.env`, on the PDS with bare handles (else the first). Nothing else is seeded.

Published ports, all on the snowglobe's own loopback address: 443 (nginx), the proxy (`SG_PROXY_PORT`, 1080), the PLC (`SG_PLC_PORT`), Jetstream
(`SG_JETSTREAM_PORT`, `SG_JETSTREAM_METRICS_PORT`) and maildev (`SG_MAILDEV_WEB_PORT`,
`SG_MAILDEV_SMTP_PORT`), and Tap when it is on (`SG_TAP_PORT`, 2480). The PDS, relay and Postgres ports are not published: reach a PDS by its
https name. The first `up` of a snowglobe picks its address, the first `127.0.0.N` from `127.0.0.2` that no
other snowglobe has kept and nothing answers on (`127.0.0.1` is the name router's; where the router does not run,
it starts from `127.0.0.1`), and keeps it in the `bind` file in the snowglobe's state folder. That is why a second
snowglobe starts beside the first with no settings. A snowglobe that kept `127.0.0.1` before 0.5.0 moves to a free
address on its next `up`, once it is down. Set `SG_BIND` (in the environment or `.env`; the scripts read it as
compose does) to choose the address yourself; the router follows it. The scripts refuse anything but a
`127.x.y.z` address: the snowglobe's logins are throwaway, so it is never published beyond this machine.

`snowglobe down` runs `docker compose down` (with `-v` when given) and never deletes the state folder. Then the
name router stops routing to the snowglobe, and is removed when no snowglobe is left to route. The PLC's
database is a named volume (`plc-db`), so a `down` without `-v` keeps every DID along with the
PDSes. After `-v`, the next `snowglobe up` starts over: init reseeds `alice` and `bob` and rewrites
`<state>/accounts.env` from scratch, so the logins the tools wrote there are gone along with their
accounts (run `snowglobe account` and `snowglobe invite` again), and the authority is made again with
a new DID.

## What it writes

Everything is kept in `<state>`, the snowglobe's own folder ([above](#which-snowglobe-and-where-it-lives)),
and nothing in the checkout:

- `<state>/accounts.env` (mode 600): logins. `SG_INVITE_CODE`, `ALICE_*` and `BOB_*` from init,
  `LEX_AUTHORITY_*`, and whatever the [tools for an app](your-app.md#tools-for-an-app) add.
- `<state>/globe/`: the rendered snowglobe, nothing secret. `compose.yml`, `nginx/` (each PDS's and
  group host's server and the page's relays to it), `leaf-names` and `globe.env` (the facts the scripts read).
  `snowglobe up` writes it again on every run; `snowglobe render` writes it alone.
- `<state>/https/`: `leaf.crt` and `leaf.key` (what nginx serves), and `apps` and `nginx/` (the app
  routes and the page's `snowglobe.json`).
- `<state root>/ca/`: `ca.crt` and `ca.key`, your CA, one for all your snowglobes ([The CA](browser.md#the-ca)).
- `~/.local/share/snowglobe/.router/`: the [name router](#the-name-router)'s `routes/`, one file per compose
  project it routes, and the `nginx.conf` written from them. It is there whatever `XDG_DATA_HOME` says.

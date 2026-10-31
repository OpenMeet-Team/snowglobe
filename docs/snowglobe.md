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

With `docs/examples/atmo.yml`, which has three PDSes (the default file has one, `main`, at `main.local.snowglobe.at`):

| Name | Served by |
| --- | --- |
| `alpha.local.snowglobe.at`, `*.local.snowglobe.at` | `pds-alpha`, the spaces alpha (`79d6307e`), and its handles; invites required |
| `regular.local.snowglobe.at`, `*.regular.local.snowglobe.at` | `pds-regular`, a current release, and its handles |
| `prod.local.snowglobe.at`, `*.prod.local.snowglobe.at` | `pds-prod`, an older release (0.4.5009, pinned by digest), and its handles |
| `plc.directory` | the snowglobe's own PLC |
| `slingshot.local.snowglobe.at` | `slingshot`, which answers a handle's DID and PDS ([Slingshot](how-it-works.md#slingshot-handles-and-dids-inside-the-network)) |
| `plc.local.snowglobe.at`, `relay.local.snowglobe.at`, `jetstream.local.snowglobe.at` | the PLC, the relay and Jetstream, as a snowglobe names them, so an app's browser code reaches them over https too |
| `pdsls.local.snowglobe.at` | `pdsls`, the record browser ([PDSls](https://pds.ls)) for this network (below) |
| `local.snowglobe.at` | nginx itself: the network's page, the one a snowglobe serves at its bare name (below) |
| `<name>.app.<domain>` | an app on this machine, at the port `snowglobe app` recorded for `<name>` |
| `*.<ending>.local.snowglobe.at` | the app that claimed `<ending>` with `snowglobe app`, for the handles it hands out |

Each PDS in the file is a service of its own, `pds-<name>`, at `<name>.local.snowglobe.at`; the one with
`bare_handles` takes `*.local.snowglobe.at`, and every other its own `*.<name>.local.snowglobe.at`. nginx answers
all of them on `127.0.0.1:443` with one certificate from a local CA. Each PDS's public URL, OAuth
issuer and DID document endpoint is `https://<its name>`, and the relay crawls every PDS as a
`wss://` host. Inside the compose network nginx also answers to every PDS's name, so the PDSes,
the relay (and Tap, when on) reach each other over TLS; no service shares another's network but Slingshot. On the machine, public DNS answers every name under the domain with `127.0.0.1`, so they work for any program. `plc.directory`
resolves to the snowglobe only for commands run under `snowglobe run`; every other program still reaches the real
`plc.directory`.

`local.snowglobe.at` is the default file's domain, and every name in the table above (and in the
rest of these docs) uses it. The name is ours, and its public DNS points every name under it at
`127.0.0.1`, so a lookup that misses the snowglobe's own mapping lands on your machine, not on someone
else's server. Pick another domain freely, but not one under `.test`, `.local`, `.localhost`,
`.invalid` or `.example`: the stack comes up there, but a PDS refuses an OAuth client at such a name,
so nobody can sign in through a group host or PDSls. `SG_DOMAIN` replaces it. Set it in the environment or in `.env` and
the same stack comes up under that domain: `<name>.<domain>` for each PDS, with handles at
`<name>.<domain>` for the one with `bare_handles`. `plc.directory` stays as it is; apps follow the domain, at `<name>.app.<domain>`.
In `.env`, write the domain itself (quotes, `export` and a trailing comment are fine); the scripts
refuse a `${...}` there, which compose would expand and they would not. Your one CA can vouch only for
the default domain, the domain it was made under and `plc.directory` ([The CA](browser.md#the-ca)). For another
domain, delete `<state root>/ca/` and run `up` again; that makes a new CA, which you trust again, and
every snowglobe then uses it.

The snowglobe knows no app. It has no app's accounts, invite codes, lexicons or ports. It gives an app
tools to make its own ([Your app in a snowglobe](your-app.md)), and using them is optional.

## The network's page

`https://local.snowglobe.at/` is the network's own page (`page/index.html`): every service and its
health, every account on each PDS, the apps `snowglobe app` routed, and the network's writes
from Jetstream, the last 24 hours, then live. nginx serves it with this snowglobe's relays (`stack/page/snowglobe.conf`), a fixed GET-only path per read, so the page
asks nothing but `local.snowglobe.at`. `snowglobe up` and `snowglobe app` write what it lists into
`<state>/https/nginx/snowglobe.json`. Open it from a browser set up as in [From a browser on your own
computer](browser.md#from-a-browser-on-your-own-computer), or read the facts it shows from a script: `snowglobe run curl -s --cacert ~/.local/share/snowglobe/ca/ca.crt https://local.snowglobe.at/snowglobe.json`
prints them as JSON. The file lists the snowglobe's services, its PDSes and group hosts (each with the path the page
reads its accounts from; the handles and DIDs are not in the file) and its apps, so a test or tool can find where things
are without a copy of the snowglobe's file.

## PDSls: browsing the network's records

`https://pdsls.local.snowglobe.at/` is [PDSls](https://github.com/notjuliet/pdsls), the record browser at
pds.ls, for this network: `https://pdsls.local.snowglobe.at/at://alice.local.snowglobe.at` shows her repo, its
collections and records, as `https://pds.ls/at://...` does on the real network. Apps that link to
pds.ls point their links here on a snowglobe. `stack/pdsls/` builds it from a pinned upstream commit
with `stack/pdsls/network.patch`, which lets the page that loads it give it a network's addresses (unset,
it is the public network's, unchanged), and `stack/pdsls/server.mjs` serves it with this network's: the PLC
at `plc.local.snowglobe.at`, Jetstream and the relay as the stream page's defaults, and the lexicon authority
for every NSID. It looks up handles and `did:web` documents for names under `local.snowglobe.at` only, and
turns off what has no stand-in here: DNS lookups, Bluesky search and avatars, backlinks, Spacedust,
the public font host, link previews. Signing in uses a client at its own address, so editing records
works against the snowglobe's PDSes.

A record's Schema tab shows its lexicon when the authority holds it and PDSls's parser accepts it.
Some lexicons fail that parser, as they would on pds.ls. Examples are the opensocial proposal's
lexicons (a `space` definition, a `space-ref` format) and atmo's permission set. The record view
still works for them.

## The file and the commands

One file says what a snowglobe runs: `snowglobe.yml`. It belongs in an app's repo, next to the lexicons
it publishes, and is committed. Everything the snowglobe makes while it runs (the CA's key, passwords,
invite codes, app routes) goes in the snowglobe's state folder, in your own account and in no repo
([What it writes](#what-it-writes)).

```yaml
globe: bookclub                  # lowercase letters and digits; the snowglobe's own name
domain: local.snowglobe.at       # every name below is under it (local.snowglobe.at if left out)

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
    local: { port: 5173, handles: bc }   # https://bookclub.app.local.snowglobe.at; handles: only for an app that hands out
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
handles too. Under `snowglobe run`, list a group's handle in `HTTPS_RUN_EXTRA_NAMES`, as for any
handle.

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
| `ls` | lists the snowglobes on this machine: name, domain, up or down, and the file that owns each |
| `up [<file> \| <name>] [-f <file>] [--default]` | brings the snowglobe up and seeds it ([Up and down](#up-and-down)) |
| `down [<file> \| <name>] [-f <file>] [-v]` | stops it; `-v` drops its volumes too |
| `env [--app <name>] [--secrets] [--dotenv]` | prints the settings an app is handed ([An app's settings](your-app.md#snowglobe-env-know-where-things-are)) |
| `run [--app <name>] [--] <cmd>` | runs a command that reaches the snowglobe at the real network's names (Linux) |
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
none, brings the stack up, makes the lexicon authority (`lex-authority.local.snowglobe.at` on the file's
`lexicons.authority` PDS, the bare-handle PDS by default),
brings the stack up again with `SG_LEXICON_AUTHORITY_DID` so every PDS starts with it. It writes no
settings file for an app: `snowglobe env` prints them ([An app's settings](your-app.md#snowglobe-env-know-where-things-are)).
The base init seeds `alice` and `bob` and a 100-use `SG_INVITE_CODE`
into `<state>/accounts.env`, on the PDS with bare handles (else the first). Nothing else is seeded.

Published ports, all on the snowglobe's own loopback address: 443 (nginx), the proxy (`SG_PROXY_PORT`, 1080), the PLC (`SG_PLC_PORT`), Jetstream
(`SG_JETSTREAM_PORT`, `SG_JETSTREAM_METRICS_PORT`) and maildev (`SG_MAILDEV_WEB_PORT`,
`SG_MAILDEV_SMTP_PORT`), and Tap when it is on (`SG_TAP_PORT`, 2480). The PDS, relay and Postgres ports are not published: reach a PDS by its
https name. The first `up` of a snowglobe picks its address, `127.0.0.1` if nothing answers there, else the
next `127.0.0.N` that no other snowglobe has kept and nothing answers on, and keeps it in the `bind` file in the
snowglobe's state folder. That is why a second snowglobe starts beside the first with no settings. Set `SG_BIND`
(in the environment or `.env`; the scripts read it as compose does) to choose the address yourself;
`snowglobe run` maps the names to it. The scripts refuse anything but a `127.x.y.z` address: the snowglobe's
logins are throwaway, so it is never published beyond this machine.

`snowglobe down` runs `docker compose down` (with `-v` when given) and never deletes the state folder. The PLC's
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
- `<state>/https/`: `leaf.crt` and `leaf.key` (what nginx serves),
  `names` (the handles `snowglobe run` maps), `apps` and `nginx/` (the app routes and the page's
  `snowglobe.json`), and `hosts` (the
  hosts file `snowglobe run` last generated).
- `<state root>/ca/`: `ca.crt` and `ca.key`, your CA, one for all your snowglobes ([The CA](browser.md#the-ca)).

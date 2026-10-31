# Your app in a snowglobe

Your app talks to a snowglobe the way it talks to the real atproto network. It signs users in with
OAuth, looks up handles and DIDs, and reads and writes records on a PDS. Nothing in the app changes
and nothing in it is test-only. What changes is the other side: the PDSes, the PLC directory and
Jetstream it finds are the snowglobe's, not Bluesky's. With this tooling, you can control the isolated atproto network to meet your needs.

Every name in the snowglobe already leads to it, for any program on the machine: public DNS sends
them to `127.0.0.1`, where the name router passes each to the snowglobe it belongs to
([The name router](snowglobe.md#the-name-router)). Two things are left for the app, and the snowglobe
has a command for them:

| The app needs to... | Command | What it does |
| --- | --- | --- |
| **be told** where things are | `snowglobe env` | Prints the snowglobe's addresses as settings your app reads. |
| **trust** the snowglobe's certificate, and get those settings | `snowglobe run <command>` | Starts your command with the settings, and with Node trusting the snowglobe's CA. |

**Why an app has to be told.** An app is configured with a few addresses: the PLC directory to
resolve DIDs, the PDS people sign up on, Jetstream for the stream of writes. Its defaults are the real
network's. In a snowglobe they must point at the snowglobe instead, and the addresses are not fixed,
because they follow your `snowglobe.yml` (in a file whose `globe:` is `myapp`, a PDS named `main` is
at `main.myapp.local.snowglobe.at`, one named `other` at `other.myapp.local.snowglobe.at`).
`snowglobe env` fills them in from the file, so you do not copy them by hand. The PLC is one of them:
an app that left it at `plc.directory` would look its accounts up in the real directory, which has
never heard of them.

Here is the same app, on the real network and in a snowglobe:

| | Real network | In a snowglobe |
| --- | --- | --- |
| PLC address (a setting) | `https://plc.directory` | `https://plc.myapp.local.snowglobe.at`, which `env` supplies |
| Sign-up PDS (a setting) | `https://bsky.social` | `https://main.myapp.local.snowglobe.at`, which `env` supplies |
| Does the name lead to a server? | public DNS | public DNS, then the name router |
| Is the certificate trusted? | public certificate authorities | `run` adds the snowglobe's CA |

`env` answers "where is it?", and `run` answers "does the app trust it?", handing over `env`'s answer
too.

## When to use `run`, and when `env`

- **Use `run` when you start the app, or its tests, from a command on this machine.** It trusts the
  snowglobe's certificate and hands the command the settings. You never type `env`.
- **Use `env` alone when `run` cannot start the app.** It prints the settings, and something else has
  to start the app. Examples: an app started by an editor, a debugger or a process manager, not from a
  command you type; a framework that reads a `.env` file (`snowglobe env --dotenv > .env.local`). The
  app then has to trust the CA some other way, such as `NODE_EXTRA_CA_CERTS`, which `env` prints too.
- **A browser needs neither.** It needs to trust the CA once ([From a browser on your own
  computer](browser.md)). The app's page still gets its settings from the dev server that `run` or
  `env` started.

## An example: a status app that signs in with OAuth

A web app, `myapp`, lets people sign in with their atproto account and post a status. You run it
with `npm run dev` on port 5173. It reads two settings that say which servers to use: the PLC
address (`PUBLIC_ATPROTO_PLC_URL`) and the PDS people sign up on (`PUBLIC_ATPROTO_SIGNUP_PDS`). On
the real network they are Bluesky's. In a snowglobe they must be the snowglobe's. The steps below
use the pieces described further down.

1. **Get the `snowglobe` command.** Install it once for your user, or add it to the app's repo.

   ```bash
   npm install -g @openmeet/snowglobe        # the command, on your PATH
   npm install --save-dev @openmeet/snowglobe  # or: with the app; run it as npx snowglobe
   ```

2. **Describe the snowglobe the app needs.** Put a `snowglobe.yml` in the app's repo. It can start as a
   copy of the package's `snowglobe.default.yml` (in the checkout, or under `npm root -g`) with a new `globe:` name (two files cannot share one), the app added, and the settings it reads:

   ```yaml
   apps:
     - name: myapp
       local: { port: 5173 }          # https://myapp.app.<domain> -> your dev server
       env:                           # the settings your app reads, and what to put in them
         PUBLIC_ATPROTO_PLC_URL: ${services.plc.url}
         PUBLIC_ATPROTO_SIGNUP_PDS: ${pds.main.url}
   ```

3. **Bring it up**, from anywhere in the app's repo. It finds the `snowglobe.yml` there:

   ```bash
   snowglobe up
   ```

4. **Start the app under `run`**, so it gets the settings and trusts the snowglobe:

   ```bash
   snowglobe run npm run dev
   ```

5. **Sign in as alice.** Open `https://myapp.app.myapp.local.snowglobe.at` in a browser that trusts
   the snowglobe's CA. Sign in as `alice.myapp.local.snowglobe.at`. Her password is in
   `<state>/accounts.env` (`ALICE_PASSWORD`).

What happens at sign-in: the app's OAuth `client_id` is a URL on `myapp.app.myapp.local.snowglobe.at`. The
PDS, which runs in Docker, fetches the app's client metadata from that URL over https. That works
because step 2 routed the name to your dev server. The PDS then shows its sign-in and consent pages
at `https://main.myapp.local.snowglobe.at`, and sends the browser back to the app. Each piece is in
the sections below. [Example: Statusphere](examples/statusphere.md) is the same flow with a real app,
and CI runs it on every change.

## `snowglobe run`: settings and the CA

```bash
snowglobe run npm run dev                    # your app, from its own folder
snowglobe run npm test                       # or its tests
```

`snowglobe run <command>` runs the command with two changes, for that command and what it starts
and nothing else on your machine:

- **Node trusts the snowglobe's certificate authority**, in addition to its usual ones
  (`NODE_EXTRA_CA_CERTS=<state root>/ca/ca.crt`). Node's certificate checks stay on.
- **The command gets the settings** `snowglobe env` would print, passwords included. `run` prints
  none of them.

If your app runs as a Cloudflare Worker locally (`wrangler dev`), its `fetch` runs in a separate
runtime, workerd. The same CA file is handed to it, so it should trust the snowglobe too.

`run` maps no names. The snowglobe's names resolve for the command as for any program on the
machine, through public DNS and the name router, so a handle or app route made after the command
started works at once. `plc.directory` is the real one: the app reaches the snowglobe's PLC through
its setting (`${services.plc.url}`), as it must on a hosted globe.

## `snowglobe env`: know where things are

`snowglobe env` prints the snowglobe's addresses as settings. Which settings, and what goes in them,
is the `env:` mapping under the app in `snowglobe.yml`. Each value can use `${name}` placeholders
(`$$` is a literal `$`). Quote a value that starts with `${` inside `{ }`; in a block map it needs
none.

```yaml
apps:
  - name: myapp
    local: { port: 5173 }
    env:
      PUBLIC_ATPROTO_PLC_URL: ${services.plc.url}
      PUBLIC_ATPROTO_JETSTREAM_URLS: ${services.jetstream.ws}
      PUBLIC_ATPROTO_SIGNUP_PDS: ${pds.main.url}
      E2E_CREDENTIALS: ${accounts.file}
```

Three ways to use what it prints:

```bash
snowglobe env                          # prints:  export PUBLIC_ATPROTO_PLC_URL='https://plc.myapp.local.snowglobe.at' ...
eval "$(snowglobe env)"                # runs those export lines in your shell, so later commands see them
snowglobe env --dotenv > .env.local    # NAME=value lines, for a framework's own .env file
```
`eval` is only there to run the printed `export` lines in your current shell. `env` itself changes
nothing. The same settings reach a command started with `snowglobe run`, with no `eval`.

It leaves out passwords and prints a comment naming each one. The logins are in
`<state>/accounts.env`; `--secrets` prints the passwords too. With one app in the file, `env` and
`run` use it. With several, name it with `--app <name>`. With none, only `NODE_EXTRA_CA_CERTS` is
set. `--dotenv` quotes for dotenv and Vite, and refuses (naming the setting) a value with a `$` that
starts a name, since Vite would expand it; use the `export` form for that one. A setting `run` hands
over replaces the same name already in the environment, and `run` prints one line naming the ones it
replaced.

The names follow the file: the section, the name you gave it, then the field. Every PDS, group host and app has
`.url` (`https://<host>`) and `.host`; a service has the fields in the table:

| Name | Value |
|---|---|
| `domain`, `globe`, `page.url` | the file's domain and name; `https://<domain>/` |
| `pds.<name>.url` `.host` `.did` | `https://<name>.<domain>`, the host, `did:web:<host>` |
| `grouphosts.<name>.url` `.host` `.did` | the same, for a group host |
| `apps.<name>.url` `.host` | `https://<name>.app.<domain>` |
| `services.plc.url` | `https://plc.<domain>` |
| `services.relay` `.jetstream` `.url` `.ws` | `https://relay.<domain>`, `wss://relay.<domain>`; Jetstream's `.ws` ends in `/subscribe`, the older protocol, and a Jetstream v2 client such as contrail takes `.url` |
| `services.slingshot.url`, `services.pdsls.url` | `https://slingshot.<domain>`, `https://pdsls.<domain>` |
| `accounts.<name>.handle` `.pds` | the handle, and its PDS's url |
| `lexicons.authority.handle` | the authority account's handle |
| `services.mail.url`, `accounts.<name>.did` `.password`, `accounts.file`, `lexicons.authority.did`, `ca.file` | known after `snowglobe up`, read from its state |

`snowglobe check` reads the names with the rest of the file: a misspelled one is an error at
`apps[0].env.<NAME>` that lists what exists ("pds.nope is not a PDS in this file: main"), and so is the address of a service the file turns off. Account names must be unique in the
file.

## Tools for an app

`up` already makes what `snowglobe.yml` lists. These commands make more, while you work. None of them
prints a secret. A login or a code goes only to the file named. The examples use the status app from
above.

### An account

`snowglobe account <name> <PREFIX> [<pds>]` makes an account, for a test that needs a user beyond
alice and bob:

```bash
snowglobe account tester TESTER             # tester.<domain>, on the PDS with bare handles
snowglobe account guest GUEST other         # guest.other.<domain>, on a PDS named other (the file needs a second PDS)
```

Without `<pds>` it uses the PDS with `bare_handles`, else the first. It prints the DID alone, and a
rerun finds the account instead of making another. The login goes to `ACCOUNTS_FILE` (default
`<state>/accounts.env`, mode 600) as `TESTER_HANDLE`, `TESTER_DID`, `TESTER_PASSWORD` and
`TESTER_PDS`. The handle resolves at once, like every name under the domain. A PDS with `invites: required` is sent
`SG_INVITE_CODE` if it is set, else a single-use code minted for the account. On the PDS with bare
handles, a name the snowglobe uses itself (a PDS's, a service's, an app's handle ending) is refused,
because the handle would be that name.

### An invite code

For an app that has a sign-up form of its own on a PDS that requires invites:
`snowglobe invite <VAR> [file] [--pds <pds>]`.

```bash
snowglobe invite MYAPP_INVITE_CODE .env.snowglobe
```

It mints the code through the PDS's admin API (`INVITE_USES`, default 100) and writes
`MYAPP_INVITE_CODE=<code>` to the file (default `<state>/accounts.env`, mode 600), replacing an earlier
line. The PDS is the one with `invites: required`; name it with `--pds` when the snowglobe has more
than one.

### Lexicons

A lexicon is the schema for a record type, such as your app's `com.example.status`. On the real
network a PDS finds the lexicons it needs through DNS and the owner's repo, and that only works for a
domain you own and have published. A snowglobe has neither, and your lexicon may not be published
anywhere yet. So every PDS in a snowglobe finds every lexicon in one place, the snowglobe's lexicon
authority account (`PDS_LEXICON_AUTHORITY_DID`), never through DNS.

That makes this the way to try a lexicon before it is public, and it has to be done for any lexicon
the PDS needs to read. An OAuth permission set in your app's scope is one: if the authority does not
hold it, the PDS cannot expand the scope and the consent page fails
([Example: atmo](examples/atmo.md) publishes two).

You publish them as `com.atproto.lexicon.schema` records, keyed by NSID. `snowglobe lexicons` does
that for a folder:

```bash
snowglobe lexicons lexicons    # prints each NSID: com.example.status, ...
```

It publishes every lexicon JSON under the folder, at any depth, and leaves a record alone when it
already holds the same document. Or publish with the app's own tooling: sign in with the
`LEX_AUTHORITY_*` login in `<state>/accounts.env` and `putRecord` each document into
`com.atproto.lexicon.schema` with the NSID as the record key. Putting the folder under `lexicons.publish`
in `snowglobe.yml` makes `up` publish it on every run.

### An app route

An app route gives your app an https name that the snowglobe's servers can reach. Take the status
app on `localhost:5173`:

- **OAuth needs it.** The app's `client_id` is a URL, and the PDS fetches the app's client metadata
  from it. The PDS runs in Docker, where `localhost:5173` is the container itself, not your dev
  server. A name under `.test` is refused by the PDS (`invalid_client_id: The client_id's TLD must not
  be a local hostname`). The route gives a name that is not local and leads to your port, so the PDS can
  read the metadata.
- **Servers in the snowglobe can call your app.** A route also reaches your app from inside Docker,
  through `host.docker.internal`.
- **The name works on the machine too**, so your app's own server code and tests can call
  `https://myapp.app.<domain>`, under `snowglobe run` for the CA.

Without the route, the PDS cannot read the app's client metadata, so sign-in cannot start.

| Command | What it does |
| --- | --- |
| `snowglobe app <name> <port>` | routes `https://<name>.app.<domain>` to a port on this machine |
| `snowglobe app <name> <port> <ending>` | the same, and every name under `<ending>.<domain>` goes to the app too (below) |
| `snowglobe app --remove <name>` | drops the route, and the app comes off the network page |
| `snowglobe app --render` | only writes nginx's routes and the network page from `<state>/https/apps`, as `up` does before it starts |

```bash
snowglobe app myapp 5173     # https://myapp.app.<domain> -> port 5173 on this machine
```

You can also put it in `snowglobe.yml` with `apps[].local`, as in the example above, and `up` makes the
route. The app must listen where Docker's host gateway lands (`host.docker.internal` inside the
containers, usually the `docker0` address on Linux), or on `0.0.0.0`. The route is kept in `<state>/https/apps`
(a rerun with the same name changes the port), and nginx is reloaded. A name under `app.<domain>`
with no route gets a 404 from nginx and reaches nothing.

### Handles of your own

Some apps hand out handles, as a PDS does. A group host makes `team.gh.<domain>` for a group
called `team`. For those, give the route an ending, the third word:

```bash
snowglobe app grouphost 7070 gh    # also https://<handle>.gh.<domain> -> port 7070
```

In `snowglobe.yml` that is `handles: gh` under `local:`. nginx then sends every name under
`gh.<domain>` to the app, Host and all, so the app answers `/.well-known/atproto-did` for
its handles, and they resolve from anywhere on the snowglobe and on the machine. The leaf certificate
gains `*.gh.<domain>` from the same CA, so nothing has to be trusted again. A PDS's name
(`main`, `other`, and so on) cannot be an ending, and an ending belongs to one app. A rerun without
the ending drops it.

### Check the OAuth path (optional)

`scripts/https-probe.mjs` checks the whole path for any app name. It resolves an account through
the snowglobe's PLC with stock atcute, told only that address, serves a confidential client at
`https://<PROBE_APP>.app.<domain>/`, pushes a PAR with that client_id, and pushes a raw PAR with a
`.test` client_id, which the PDS refuses. `ATCUTE_DIR` is required: a directory node resolves
`@atcute/oauth-node-client` and `@atcute/identity-resolver` from.

```bash
snowglobe app probe 5480
ATCUTE_DIR=<dir> PROBE_DID=<did> PROBE_PDS=https://main.myapp.local.snowglobe.at snowglobe run node scripts/https-probe.mjs
```

```
RESOLVED did:plc:... on https://main.myapp.local.snowglobe.at through https://plc.myapp.local.snowglobe.at, ... off
PAR ACCEPTED for confidential client https://probe.app.myapp.local.snowglobe.at/probe-<run>/oauth-client-metadata.json
REFUSED .test client_id: HTTP 400 invalid_client_id: The client_id's TLD must not be a local hostname
```

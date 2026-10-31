# <img src="assets/snowglobe.svg" width="40" alt=""> Snowglobe

Your own isolated [AT Protocol](https://atproto.com) network, for testing, research, and demos. A snowglobe has its own
PDS, PLC directory, relay and Jetstream, and nothing in it reaches Bluesky's network. It uses
https and the real network's sign-in (OAuth), so an app built for the real network runs against it
with no test-only code.

**Why?** Some things worth trying on atproto can hurt real users if they go wrong: a change to a lexicon,
a new OAuth flow, an app that writes records in a new way. A snowglobe is a network of your own, where a
mistake touches nobody. We use it to build against the spaces alpha PDS, a group host and atmo.rsvp.

**How?** Run one on your machine from this repo, or open the one we host,
[lighthouse.snowglobe.at](https://lighthouse.snowglobe.at). [snowglobe.at](https://snowglobe.at)
says more about the project.

## What runs in a snowglobe

One file, `snowglobe.yml`, says what a snowglobe runs. [`snowglobe.default.yml`](snowglobe.default.yml)
is the one to start from. It gives you:

- one current PDS (personal data server, where an account's records live and where it signs in), at
  `https://main.local.snowglobe.at`, with two test accounts, `alice` and `bob`;
- a PLC directory, the phone book that says which PDS holds each `did:plc` account; it also answers as
  `plc.directory` for your app;
- Jetstream, a simple stream of every write on the network, for apps that follow it;
- Slingshot, which looks up a handle's DID and PDS inside the network;
- PDSls, to browse the network's records;
- the network's own page, with its services, accounts and live activity.

The file also holds commented examples for adding more, up to a full setup:
- more PDSes. With more than one, a relay turns on by itself: it merges every PDS's writes into one
  stream, which Jetstream then follows;
- the permissioned-spaces alpha, a PDS build with shared spaces;
- a lexicon authority, the one account every PDS reads record type definitions (lexicons) from;
- Tap, which follows the stream and fetches whole repos for an app that keeps its own copy of the data;
- a group host, a server that runs groups as accounts of their own, each with a handle under the host's name;
- your own app.

[`docs/examples/atmo.yml`](docs/examples/atmo.yml) is a larger file, with three PDSes, a relay and a
lexicon authority, that [Example: atmo](docs/examples/atmo.md) builds on.

Every name is under one domain, `local.snowglobe.at`, served by nginx with a certificate from a
local CA that the snowglobe makes for itself. There is no AppView and no feed generator.
[The snowglobe](docs/snowglobe.md) shows the whole file and what each part does.

## What you need

Every service in a snowglobe has its own https name under `local.snowglobe.at`, such as
`alice.local.snowglobe.at`. Handles, sign-in (OAuth) and DID documents all carry those names, so
your computer has to send the names to the snowglobe, and trust its certificate. Here is what to do.

**Before you start it:**

1. Install Docker with Compose, and Node 20 or newer. Use Linux, or Windows with WSL 2.
2. To run a command against the snowglobe from your machine (`snowglobe run`: your own app, its
   tests, or the `curl` example below), also install
   [bubblewrap](https://github.com/containers/bubblewrap): `sudo apt install bubblewrap` on Debian or
   Ubuntu. You do not need it to bring a snowglobe up or to look at one in a browser.

**After it is up, to open it in a browser or reach it from an app:**

3. Make the names reach the snowglobe.
   - Docker and your browser on the same computer: you usually do nothing, because public DNS answers
     every name under `local.snowglobe.at` with `127.0.0.1`. If the browser says "server not found",
     your router is dropping that answer. See
     [When the browser cannot open it](docs/browser.md#when-the-browser-cannot-open-it).
   - Docker in a dev container, or on another machine: the snowglobe's proxy runs with every `up`, on
     `127.0.0.1:1080`; point your browser at it ([From a browser on your own computer](docs/browser.md)).
   - A command started with `snowglobe run`: you do nothing, it sets the names up itself.
4. Trust the snowglobe's certificate authority (CA). Run `snowglobe trust` on the machine that runs
   Docker. For another machine, see [From a browser on your own computer](docs/browser.md).

**Why not just use ports?** The PDSes are not published on ports at all: only nginx (443), the proxy,
the PLC, Jetstream and MailDev are. A PDS's address is its name, and that name is what a DID document, a
handle lookup and an OAuth sign-in resolve to, so an app has to be told it is on a test network to
use a port instead. A snowglobe can still be small: a file with one PDS, the PLC and Jetstream
checks and renders ([The file and the commands](docs/snowglobe.md#the-file-and-the-commands)). It
keeps the https names, and they are what make an app run unchanged.

## Quick start

```bash
npm install -g @openmeet/snowglobe       # puts the snowglobe command on your PATH
snowglobe up --default                   # the first run pulls and builds images, which takes a while
```

To change what it runs, copy the default file into your folder, give it a name of its own on the
`globe:` line (`snowglobe` is the default file's, and a snowglobe belongs to the file that first
brought it up), edit it, and run `snowglobe up`:
`cp "$(npm root -g)/@openmeet/snowglobe/snowglobe.default.yml" snowglobe.yml`.
To keep the command with one project instead, run `npm install --save-dev @openmeet/snowglobe`, then
`npx snowglobe up --default` for the default, or `npx snowglobe up` once the folder has a
`snowglobe.yml` (copy it from `node_modules/@openmeet/snowglobe/snowglobe.default.yml`). Either
command also fits in a `package.json` script.

Now try it. `snowglobe run` runs a command that can reach the snowglobe by name, and `--cacert`
gives curl the snowglobe's certificate authority (CA), so it trusts the snowglobe's https:

```bash
# Sign up a new account, then look up alice's account through Slingshot
snowglobe account carol CAROL                # CAROL: the prefix of her login variables, such as CAROL_PASSWORD
snowglobe run curl -s --cacert ~/.local/share/snowglobe/ca/ca.crt \
  'https://slingshot.local.snowglobe.at/xrpc/com.bad-example.identity.resolveMiniDoc?identifier=alice.local.snowglobe.at'
```

To look around in a browser, you need two things: the browser has to trust the snowglobe's
certificate, and it has to be able to find the snowglobe. If Docker runs on the same computer as your
browser, run `snowglobe trust` and open `https://local.snowglobe.at/`, the network's page,
which lists every service, account and write. If Docker runs in a dev container or on another
machine, your browser also needs the snowglobe's small proxy, which sends the snowglobe's names to
it; [From a browser on your own computer](docs/browser.md) walks through both.

The default snowglobe comes with one app to look at, [PDSls](docs/snowglobe.md#pdsls-browsing-the-networks-records),
the record browser. `https://pdsls.local.snowglobe.at/at://alice.local.snowglobe.at` shows alice's repo,
once your browser can reach the snowglobe as above.

Stop the snowglobe with `snowglobe down`. Add `-v` to delete its data too, every account
included. Everything a snowglobe makes is kept in your own account, in
`~/.local/share/snowglobe` (or under `XDG_DATA_HOME`), and nothing in the checkout
([Which snowglobe, and where it lives](docs/snowglobe.md#which-snowglobe-and-where-it-lives)).

To run your own app inside of a snowglobe, see [Your app in a snowglobe](docs/your-app.md).

## Platforms

Snowglobe runs on Linux, and on Windows under WSL 2. Both are tested. macOS is not supported yet.
If you try it on a Mac, please
[open an issue](https://github.com/OpenMeet-Team/snowglobe/issues) with what broke, or that it
worked.

## Documentation

- [The snowglobe](docs/snowglobe.md): what a `snowglobe.yml` holds, the commands, the snowglobe's names, up and
  down, and what it writes.
- [Your app in a snowglobe](docs/your-app.md): `snowglobe run`, and the tools that make an app's
  accounts, invite codes, lexicons and routes.
- [From a browser on your own computer](docs/browser.md): the proxy, launch flags, and trusting the
  CA.
- [How it works](docs/how-it-works.md): what runs and how it is wired, Slingshot, and the relay build.
- [Configuration](docs/configuration.md): the settings.
- [Testing Snowglobe](docs/testing.md): the test suite and the smoke run.
- [Example: Statusphere](docs/examples/statusphere.md): the atproto example app on a snowglobe, with
  two small changes. CI runs it end to end.
- [Example: atmo](docs/examples/atmo.md): an events app on a local snowglobe.
- The older plain-http stack (`npm run up`) is not in this version. Its code and README are in the
  [v0.2.0 tag](https://github.com/OpenMeet-Team/snowglobe/tree/v0.2.0) (v0.1.0 has the first version of it).
- [Changelog](CHANGELOG.md): what changed in each version, and how to upgrade.

## License

MIT

# From a browser on your own computer

A browser needs two things to open a snowglobe: the snowglobe's names have to reach it, and the
browser has to trust the snowglobe's CA.

The names take care of themselves. Each snowglobe has a domain of its own, `<globe>.local.snowglobe.at`
(`snowglobe.local.snowglobe.at` for the default file; `snowglobe ls` lists each one's). Public DNS
answers every name under `local.snowglobe.at`, at any depth, with `127.0.0.1`. There `snowglobe up`
starts the name router, one for the whole machine, which reads the name each connection asks for and
passes the connection, still encrypted, to the snowglobe whose domain the name is under. So a browser
reaches every snowglobe on the machine at once, by name, and a handle made a second ago works, with no
proxy, hosts file or launch flag. The router runs on Linux with Docker Engine, WSL 2 included; Docker
Desktop is not tested.

## Docker on the same computer as the browser

1. **Trust the CA.** Run `snowglobe trust`. It puts your CA (`<state root>/ca/ca.crt`, one
   per user) in the system store and in the databases Chrome, Edge and Firefox read on Linux, in the
   login keychain on macOS (untested) or in the user store on Windows. It prints every
   command, marks the ones that need sudo, and does nothing the second time. On WSL it also prints
   the PowerShell step for the Windows store, which a Windows browser needs. `trust --dry-run` shows
   what it would do, and `trust --remove` undoes it.
2. **Open `https://<domain>/`**, the network's page: `https://snowglobe.local.snowglobe.at/` for the
   default file. Its apps link to themselves, for instance `https://atmo.app.snowglobe.local.snowglobe.at`
   once atmo is routed ([Example: atmo](examples/atmo.md)).

That is all. Two cases break it:

- A resolver that drops answers pointing at your own machine, as some routers do (see
  [When the browser cannot open it](#when-the-browser-cannot-open-it)).
- Something else on `127.0.0.1:443`. The name router cannot start there, and `up` says so. One
  case is a snowglobe still running on `127.0.0.1` itself: one made before 0.5.0, or one started with
  `SG_BIND=127.0.0.1`. Only that snowglobe is reached by name while it runs; `snowglobe down` it, and
  `up` it again without `SG_BIND`, to move it to an address of its own.

`plc.directory` is the real directory, for a browser as for every other program. An app on the
snowglobe is told the snowglobe's own PLC, `https://plc.<domain>` ([Your app in a snowglobe](your-app.md)).

## When the browser cannot open it

With the snowglobe up and healthy, check that the router and the snowglobe answer, then that the
name resolves (the default file's domain here; use yours):

```sh
curl -sk --resolve snowglobe.local.snowglobe.at:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://snowglobe.local.snowglobe.at/   # 200
getent hosts snowglobe.local.snowglobe.at                                                                                            # 127.0.0.1
dig +short @1.1.1.1 snowglobe.local.snowglobe.at                                                                                     # 127.0.0.1
```

If the first prints 200 and the second prints nothing, the snowglobe is fine and name resolution is
the problem. If the first fails, the last line of `snowglobe ls` says whether the name router is
running and which domains it sends where.

- **The router refuses the name (Firefox: "server not found", `getent` prints nothing).** The
  names are public DNS records that point at `127.0.0.1`. A router that does DNS-rebind protection
  drops such answers and replies SERVFAIL, for every name under `snowglobe.at` alike, while
  `1.1.1.1` and `8.8.8.8` answer correctly (`dig @<router> snowglobe.local.snowglobe.at` shows
  `status: SERVFAIL`). Any one of these fixes it:
  - put public resolvers ahead of the router's for your connection (on a NetworkManager system, set
    the connection's DNS servers to `1.1.1.1 8.8.8.8`), which fixes every program;
  - allow `snowglobe.at` in the router's rebind-protection list (dnsmasq: `rebind-domain-ok=/snowglobe.at/`);
  - turn on DNS over HTTPS in the browser (Firefox: Settings, Privacy & Security, DNS over HTTPS),
    which fixes that browser only.
- **Every name is refused or reset.** The name router is not running, or does not route your
  snowglobe's domain. `snowglobe ls` says which; `docker logs snowglobe-router` says why it stopped,
  and the next `snowglobe up` starts it again.
- **Chrome says `ERR_CONNECTION_REFUSED` for a bare `snowglobe.local.snowglobe.at`.** Typed without a
  scheme, Chrome tries https and, when that fails, falls back to `http://`, which is port 80. A
  snowglobe publishes only 443, so the fallback is refused and hides the https failure behind it. Type
  `https://snowglobe.local.snowglobe.at/` in full. If it then fails, the error shown is the real one.
  If Chrome still shows an old failure after the name resolves, clear its cached lookups with
  `chrome://net-internals/#dns` ("Clear host cache") and `chrome://net-internals/#sockets` ("Flush
  socket pools").
- **A certificate warning, or a failure no click gets past.** The browser does not trust the CA. Run
  `snowglobe trust` and see [The CA](#the-ca). Firefox keeps its own store unless `trust`
  has put the CA in it.

## Docker somewhere else: a dev container or another machine

The name router runs where Docker runs. Forward port 443 from that machine to port 443 on your own
computer's loopback address, and the same public DNS answer, `127.0.0.1`, then leads every snowglobe
name to the router there: one forward covers every snowglobe on that machine.

1. **Trust the snowglobe's CA** (more in [The CA](#the-ca)). Copy `ca.crt` from the machine that runs
   the snowglobe (`~/.local/share/snowglobe/ca/ca.crt`) and trust it by hand:
   - Windows, for Chrome, Edge and Firefox: `certutil -user -addstore Root ca.crt` (no admin; Windows
     asks you to confirm). Firefox reads the Windows store.
   - macOS, for Chrome, Edge and Safari:
     `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.crt`.
     Firefox: Settings, Privacy & Security, View Certificates, Authorities, Import.
   - Linux: Chrome and Edge read `~/.pki/nssdb`:
     `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n snowglobe -i ca.crt` (from `libnss3-tools`).
     Firefox: import it as on macOS.

   Without this step each of the snowglobe's names gets a certificate warning you click through
   once, and an app's own calls from the page to a PDS fail where no one can click.
2. **Forward port 443.** In VS Code's Ports view, forward port 443 to local port **443** exactly. The
   PDS's URLs carry no port, and VS Code quietly picks another local port when 443 is taken, so check
   the forwarded address. With ssh: `ssh -L 127.0.0.1:443:127.0.0.1:443 <the machine that runs Docker>`
   (on a Linux computer, a local port below 1024 needs root). The router asks no one to sign in, so
   whoever can reach the forwarded port reaches every snowglobe on that machine: every PDS, the PLC,
   the network pages, and every app of yours routed with `snowglobe app`, each behind only its own
   sign-in. Keep the forward on your computer's loopback address and don't open it to a network.
3. **Open `https://<domain>/`**, the network's page, as above.

## The CA

`snowglobe certs` makes the CA once, in Node (no openssl needed). `snowglobe up` runs it
when there is no leaf, or when the leaf lacks a name. Rerunning it keeps the CA and reissues the
leaf only when it lacks a name, so a browser or OS that trusts `ca.crt` keeps trusting every snowglobe you run.
`snowglobe certs --check`
only says whether the leaf lacks a name (exit 1) or not (exit 0). The leaf names what the render lists in
`<state>/globe/leaf-names`: the domain itself, each PDS and its handles (`*.<domain>` for the one
with bare handles, `*.<name>.<domain>` for each other), each group host and its groups' handles,
`plc.`, `relay.`, `jetstream.`, `slingshot.` and `pdsls.<domain>`, `plc.directory` and `*.app.<domain>`
(the apps); and `*.<ending>.<domain>` for each handle ending an app claimed. A TLS wildcard covers one
label, so each handle domain needs its own. `snowglobe app` reissues the leaf
when it claims an ending, and `snowglobe up` when the leaf lacks any of these names. Add deeper names
with `HTTPS_EXTRA_NAMES="x.mine.snowglobe.local.snowglobe.at"` on every run, then restart nginx. A name
one label under the domain is already covered when a PDS has `bare_handles`. To start over, delete
`<state root>/ca/` (your one CA, so every snowglobe is affected) and trust the new `ca.crt` wherever the old
one was trusted.

The CA can only vouch for servers under `local.snowglobe.at` (every snowglobe's own domain is under
it), a domain outside it that it was made for (`SG_DOMAIN`, or a file's `domain:` line), and
`plc.directory` (name constraints, server auth only, no IP addresses), so trusting it puts no other site
at risk, even if `<state root>/ca/ca.key` leaks. Keep that file on the dev machine, and remove the CA
from a browser or OS when you're done with it: `snowglobe trust --remove`. On Windows by hand:
`certutil -user -delstore Root "<its name>"`, the name being the CN that `snowglobe certs`
prints ("Keeping the existing CA: ...").

There is one CA per user, shared by all your snowglobes, so you trust it once. Each CA has a name of
its own, `snowglobe local CA <date> <hex>`. Two CAs with one name break each other: a browser that
trusts one checks the other's certificates against the wrong key and rejects them as a bad
signature, which it will not let you click through. Delete the CA's `ca.*` and run `up` again only
when you mean to start over, and remove the old one from the stores (`trust --remove` first).

## Tested setups

- **A dev container on Linux.** Two snowglobes, each on its own domain and address, answer at once by
  name through the name router, from headless Chromium, Node and a container, a handle made after a
  command started included. The Statusphere run signs alice in through her PDS's sign-in and consent
  pages in headless Chromium.
- **Linux, with Docker, Firefox and Chrome on the same computer.** Public DNS answers `127.0.0.1` for
  the snowglobe's names, so the browsers need only the CA. Tested with one snowglobe on `127.0.0.1`,
  before the name router.
- **Windows.** Firefox finds a CA added with `certutil`.

Not tested: a desktop browser through the name router (Linux, a Windows browser with Docker in WSL 2,
or one through a forwarded port 443), the router with Docker Desktop, Edge, and macOS.

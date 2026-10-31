# From a browser on your own computer

A browser needs two things to open a snowglobe: the snowglobe's names have to reach nginx, and the
browser has to trust the snowglobe's CA. What you do about the first depends on where Docker runs.

## Docker on the same computer as the browser

1. **Trust the CA.** Run `snowglobe trust`. It puts your CA (`<state root>/ca/ca.crt`, one
   per user) in the system store and in the databases Chrome, Edge and Firefox read on Linux, in the
   login keychain on macOS (untested) or in the user store on Windows. It prints every
   command, marks the ones that need sudo, and does nothing the second time. On WSL it also prints
   the PowerShell step for the Windows store, which a Windows browser needs. `trust --dry-run` shows
   what it would do, and `trust --remove` undoes it.
2. **Open `https://local.snowglobe.at/`**, the network's page. Its apps link to themselves, for
   instance `https://atmo.app.local.snowglobe.at` once atmo is routed
   ([Example: atmo](examples/atmo.md)).

That is all. Public DNS answers every name under `local.snowglobe.at` with `127.0.0.1`, and nginx publishes port 443 on
`127.0.0.1`, so there is no proxy to set up and nothing to map. Two cases break that:

- `SG_BIND` set to another loopback address (see [Configuration](configuration.md)): the name still
  resolves to `127.0.0.1`, where nothing listens. Use a hosts-file entry for each name, or the proxy
  below.
- A resolver that drops answers pointing at your own machine, as some routers do (see
  [When the browser cannot open it](#when-the-browser-cannot-open-it)). If a name does not resolve,
  use the proxy below.

`plc.directory` is not under that domain, so a browser still reaches the real directory. Apps on the
snowglobe use `https://plc.local.snowglobe.at`.

## When the browser cannot open it

With the snowglobe up and healthy, check first that it answers, then that the name resolves:

```sh
curl -sk --resolve local.snowglobe.at:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://local.snowglobe.at/   # 200
getent hosts local.snowglobe.at                                                                                  # 127.0.0.1
dig +short @1.1.1.1 local.snowglobe.at                                                                           # 127.0.0.1
```

If the first prints 200 and the second prints nothing, the snowglobe is fine and name resolution is
the problem.

- **The router refuses the name (Firefox: "server not found", `getent` prints nothing).** The
  names are public DNS records that point at `127.0.0.1`. A router that does DNS-rebind protection
  drops such answers and replies SERVFAIL, for every name under `snowglobe.at` alike, while
  `1.1.1.1` and `8.8.8.8` answer correctly (`dig @<router> local.snowglobe.at` shows
  `status: SERVFAIL`). Any one of these fixes it:
  - put public resolvers ahead of the router's for your connection (on a NetworkManager system, set
    the connection's DNS servers to `1.1.1.1 8.8.8.8`), which fixes every program;
  - allow `snowglobe.at` in the router's rebind-protection list (dnsmasq: `rebind-domain-ok=/snowglobe.at/`);
  - turn on DNS over HTTPS in the browser (Firefox: Settings, Privacy & Security, DNS over HTTPS),
    which fixes that browser only;
  - or use the proxy below, which resolves the names itself.

  A hosts-file entry works but names every host by hand: `/etc/hosts` has no wildcards, so each
  PDS, handle and app name needs a line.
- **Chrome says `ERR_CONNECTION_REFUSED` for a bare `local.snowglobe.at`.** Typed without a scheme,
  Chrome tries https and, when that fails, falls back to `http://`, which is port 80. A snowglobe
  publishes only 443, so the fallback is refused and hides the https failure behind it. Type
  `https://local.snowglobe.at/` in full. If it then fails, the error shown is the real one. If
  Chrome still shows an old failure after the name resolves, clear its cached lookups with
  `chrome://net-internals/#dns` ("Clear host cache") and `chrome://net-internals/#sockets` ("Flush
  socket pools").
- **A certificate warning, or a failure no click gets past.** The browser does not trust the CA. Run
  `snowglobe trust` and see [The CA](#the-ca). Firefox keeps its own store unless `trust`
  has put the CA in it.

## Docker somewhere else: a dev container or another machine

nginx runs where Docker runs, so a browser on a different computer needs a way to send the
snowglobe's names to it, as well as trust in the CA. The proxy below does the first with a setting
you make once, in the browser you already use. Launch flags (further down) are the older way.

### Through the snowglobe's proxy (Chrome, Edge, Firefox)

The `proxy` service (`stack/https/proxy/server.mjs`) is a proxy and the PAC (proxy auto-config) file, a small script that tells the browser which names to send to a proxy, on one
port, `1080` (`SG_PROXY_PORT`) on the snowglobe's own address: `127.0.0.1` for the first snowglobe on a machine, `127.0.0.2` or the next for one started beside it (step 2 finds it). The PAC names it as an HTTP proxy, which every PAC
reader understands, Windows' own included; it also answers SOCKS5, for a client set to it directly. The PAC sends `local.snowglobe.at` and `*.local.snowglobe.at` (apps included) to the proxy and
everything else direct, so the rest of your browsing is untouched. The browser hands the proxy the name, and the proxy connects every name in the snowglobe to nginx,
so a handle made a second ago works with nothing to update. It refuses any other name, any IP
address and any port but 443.

**Once per computer:**

1. **Trust the snowglobe's CA** (more in [The CA](#the-ca)). On the machine whose browser you use, if
   Docker runs there too, `snowglobe trust` does it (above).

   Otherwise copy `ca.crt` from the machine that runs the snowglobe and trust it by hand:
   - Windows, for Chrome, Edge and Firefox: `certutil -user -addstore Root ca.crt` (no admin; Windows
     asks you to confirm). Firefox reads the Windows store.
   - macOS, for Chrome, Edge and Safari:
     `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.crt`.
     Firefox: Settings, Privacy & Security, View Certificates, Authorities, Import.
   - Linux: Chrome and Edge read `~/.pki/nssdb`:
     `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n snowglobe -i ca.crt` (from `libnss3-tools`).
     Firefox: import it as on macOS.

   Without this step the proxy still works, but each of the snowglobe's names gets a certificate warning you click
   through once, and an app's own calls from the page to a PDS fail where no one can click.
2. **Find the snowglobe's address.** With two snowglobes on one machine, the proxy at `127.0.0.1` is the
   first one's. On the machine that runs Docker, `cat ~/.local/share/snowglobe/<name>/bind` prints the
   second one's (`127.0.0.2`, say; `<name>` as `snowglobe ls` lists it), and that address is used for
   `127.0.0.1` in the steps below. A snowglobe with no `bind` file is on `127.0.0.1`, or on `SG_BIND`
   where that is set.
3. **Forward the proxy's port.** (Docker on the same computer as the browser: skip this, the proxy is
   already on your snowglobe's address, port 1080.) For the first snowglobe, forward port 1080 in
   VS Code's Ports view (`SG_PROXY_PORT`, if you set one). That view forwards to `localhost` on the
   remote side, which is the first snowglobe's address, so for any other snowglobe use ssh and name
   its address: `ssh -L 1080:127.0.0.2:1080 <the machine that runs Docker>` (the address from step 2;
   pick another local port first if 1080 is taken). Any local port will do: the PAC names the address it was
   fetched from. The proxy asks no one to sign in, so whoever can reach the forwarded port reaches
   the whole snowglobe: every PDS, the PLC, the network page, and every app of yours routed with
   `snowglobe app`, each behind only its own sign-in. Keep the forwarded port on your computer's
   loopback address and don't open it to a network.
4. **Point the browser at the PAC**, `http://127.0.0.1:1080/proxy.pac` for the first snowglobe, or `http://127.0.0.2:1080/proxy.pac` (your snowglobe's address) when Docker is on the same computer; through a forward, the local address and port you forwarded to:
   - Windows, for Chrome, Edge and Firefox: Settings, Network & internet, Proxy, "Use setup script",
     with the URL as the script address.
   - macOS: System Settings, Network, your connection, Details, Proxies, "Automatic proxy
     configuration", with the URL.
   - Linux (GNOME): Settings, Network, Network Proxy, Automatic, with the URL.
   - Firefox: Settings, Network Settings, "Use system proxy settings" (the default, but check it:
     any other choice ignores the Windows setting). Or, for Firefox alone, "Automatic proxy
     configuration URL" with the same URL. Both browsers pick up a change to the Windows setting on
     the next page load; no restart.

**Then** open `https://local.snowglobe.at/`, the network's page. Its apps link to themselves, for instance
`https://atmo.app.local.snowglobe.at` once atmo is routed ([Example: atmo](examples/atmo.md)).

**When you are done**, turn the setting off. Do not leave it on while the snowglobe is down. With the
proxy unreachable, the browser cannot fetch the PAC. Firefox set to "Automatic proxy configuration
URL" then fails or slows down on ordinary sites too, not only on the snowglobe's names. To undo it,
choose Settings, Network Settings, "No proxy". A separate Firefox profile for the snowglobe keeps
everyday browsing from depending on it.

`proxy.pac` leaves `plc.directory` alone, so the setting never moves the real directory for your
everyday browsing; apps on the snowglobe use `https://plc.local.snowglobe.at`. For an app that insists on
`plc.directory` in the browser, a profile used only for the snowglobe can take
`http://127.0.0.1:1080/proxy-with-plc.pac` (your snowglobe's address, as in step 4), where it is this snowglobe's PLC.

### With launch flags (Chrome, Edge)

1. **Forward port 443**, in VS Code's Ports view: container 443 to host **443** exactly. The PDS's
   URLs carry no port, and VS Code quietly picks another local port when 443 is taken, so check the
   forwarded address. Forward your app's own port too if the browser opens it directly.
2. **Map the names to `127.0.0.1` for the browser.** Start a separate Chrome or Edge instance with
   its own profile directory, so the flag takes effect even when the browser is already open:

   ```
   rem cmd.exe; in PowerShell, write $env:TEMP for %TEMP%
   chrome.exe --user-data-dir=%TEMP%\snowglobe-https --host-resolver-rules="MAP local.snowglobe.at 127.0.0.1, MAP *.local.snowglobe.at 127.0.0.1, MAP plc.directory 127.0.0.1"
   ```

   The wildcard rule covers the PDS names and the handles; the bare `local.snowglobe.at`, the network's
   page, needs its own. Hosts-file entries work too, one name at a time; they need admin, and they
   point `plc.directory` at the snowglobe for every program on the computer until you remove the line.
3. **Trust the CA**, as in step 1 of the proxy's steps.

## The CA

`snowglobe certs` makes the CA once, in Node (no openssl needed). `snowglobe up` runs it
when there is no leaf, or when the leaf lacks a name. Rerunning it keeps the CA and reissues the
leaf only when it lacks a name, so a browser or OS that trusts `ca.crt` keeps trusting every snowglobe you run.
`snowglobe certs --check`
only says whether the leaf lacks a name (exit 1) or not (exit 0). The leaf names what the render lists in
`<state>/globe/leaf-names`: `local.snowglobe.at` itself, each PDS and its handles (`*.local.snowglobe.at` for the one
with bare handles, `*.<name>.local.snowglobe.at` for each other), each group host and its groups' handles,
`plc.`, `relay.`, `jetstream.`,
`slingshot.` and `pdsls.local.snowglobe.at`, `plc.directory` and `*.app.local.snowglobe.at` (the apps); and
`*.<ending>.local.snowglobe.at` for each handle ending an app claimed. A TLS wildcard covers one label, so
each handle domain needs its own. `snowglobe app` reissues the leaf
when it claims an ending, and `snowglobe up` when the leaf lacks any of these names. Add deeper names
with `HTTPS_EXTRA_NAMES="x.mine.local.snowglobe.at"` on every run, then restart nginx. A name one label
under `local.snowglobe.at` is already covered when a PDS has `bare_handles`. To start over, delete
`<state root>/ca/` (your one CA, so every snowglobe is affected) and trust the new `ca.crt` wherever the old
one was trusted.

The CA can only vouch for servers under `local.snowglobe.at` (the `SG_DOMAIN` it was made for),
and `plc.directory` (name constraints, server auth only, no IP addresses), so trusting it puts no other site at risk, even if
`<state root>/ca/ca.key` leaks. Keep that file on the dev machine, and remove the CA from a browser or OS
when you're done with it: `snowglobe trust --remove`. On Windows by hand:
`certutil -user -delstore Root "<its name>"`, the name being the CN that `snowglobe certs`
prints ("Keeping the existing CA: ...").

There is one CA per user, shared by all your snowglobes, so you trust it once. Each CA has a name of
its own, `snowglobe local CA <date> <hex>`. Two CAs with one name break each other: a browser that
trusts one checks the other's certificates against the wrong key and rejects them as a bad
signature, which it will not let you click through. Delete the CA's `ca.*` and run `up` again only
when you mean to start over, and remove the old one from the stores (`trust --remove` first).

## Tested setups

- **Linux, with Docker, Firefox and Chrome on the same computer.** Public DNS answers `127.0.0.1` for
  the snowglobe's names, so the browsers need only the CA.
- **Windows, through the proxy.** Chrome with the Windows "Use setup script" setting, and Firefox with
  either its own "Automatic proxy configuration URL" or "Use system proxy settings", reach the
  network's page and a handle's own name. Firefox finds a CA added with `certutil`.
- **A dev container, with full Chromium and Firefox set only to the PAC URL.** Both go from the
  network's page to atmo and sign in through the alpha PDS's sign-in and consent pages, and no
  request leaves the snowglobe.

Not tested: Edge, macOS, and the proxy from a Linux desktop. Playwright's default headless shell
ignores `--proxy-pac-url`, so use full Chromium, Chrome or Edge with a PAC.

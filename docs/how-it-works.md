# How it works

## What runs, and how it's wired

- **Each PDS has an https name.** A PDS's `PDS_HOSTNAME` is `<name>.<domain>`, such as
  `main.local.snowglobe.at`. A PDS with `bare_handles` takes handles under the domain itself; every
  other PDS takes its own (`.regular.local.snowglobe.at`). Each runs with `PDS_DEV_MODE=false`, as
  on the real network.
- **nginx routes by name.** It answers on port 443 with a certificate from the snowglobe's CA, and
  passes the name through, so a PDS can answer `/.well-known/atproto-did` for a handle. A name
  nginx does not list gets no certificate.
- **The PDSes reach each other over TLS.** Inside Docker, nginx also answers to every PDS's name,
  and each PDS trusts the CA. Inside each PDS, every name under the domain resolves to nginx
  instead of `127.0.0.1` (inside a container that would be the container itself), so a PDS can
  fetch the sign-in metadata of your app at `<name>.app.<domain>` or of PDSls.
- **The relay dials wss**, which is why it is built locally (see [The relay, built
  locally](#the-relay-built-locally)). Its `listHosts` shows a host only once it has sent an event.
- **Tap runs in the DNS container's network** (`tap-dns`), whose DNS answers every name under the
  domain with nginx. That is how Tap reaches an app's https name to send it events, and checks a
  handle (`alice.<domain>`) at its own name. Tap's port is published on the snowglobe's address, `SG_BIND`, at `<SG_TAP_PORT>` (2480)
  from that container. Tap finds an account when it writes in the signal collection; its crawl of
  that collection's repos is refused by the PDS (HTTP 401), so a repo written before Tap started is
  found when it next writes, and then its whole repo is fetched (measured 2026-10-23 with the Tap image
  this snowglobe pins: digest `sha256:5e20bfe4…`, indigo revision `4f47add4`, built 2026-03-11).
- **Jetstream** is at `ws://127.0.0.1:<SG_JETSTREAM_PORT>`, reading the relay over the Docker network, so the relay
  runs even with one PDS: at start Jetstream asks the relay for the network's hosts, which a PDS refuses. It is
  Jetstream v2. It serves `/xrpc/network.bsky.jetstream.subscribeEvents`, which `@bsky/jetstream` clients such as
  contrail read, and the older `/subscribe`, which Slingshot, PDSls and the network page read. Its image is built from
  `stack/jetstream/Dockerfile`, the pinned Jetstream plus busybox for the health check; to move to another
  Jetstream, change the `FROM` line there, and `snowglobe up` builds it. A new snowglobe's first `up` waits a minute or two
  for it: Jetstream's first start tries to backfill each PDS directly, its HTTP client refuses the private addresses
  the PDSes have in Docker, and it then follows the relay. So Jetstream has only what is written after its first
  start: an earlier record never comes through Jetstream, though it is still on the PDS.

## Slingshot: handles and DIDs inside the network

`slingshot` is [Slingshot](https://tangled.org/jola.dev/microcosm-rs/tree/main/slingshot) from
microcosm-rs, built from a pinned commit (`stack/slingshot/Dockerfile`; upstream publishes no image), set
to the snowglobe's PLC and Jetstream. The public Slingshot cannot see an account on a snowglobe;
this one answers for it:

```sh
snowglobe run curl -sS --cacert ~/.local/share/snowglobe/ca/ca.crt \
  'https://slingshot.local.snowglobe.at/xrpc/com.bad-example.identity.resolveMiniDoc?identifier=alice.local.snowglobe.at'
# {"did":"did:plc:...","handle":"alice.local.snowglobe.at","pds":"https://main.local.snowglobe.at","signing_key":"zQ3..."}
```

It checks a handle both ways, which means it fetches `https://<handle>/.well-known/atproto-did`
from inside the compose network, and a handle's name exists nowhere but in nginx. So it runs in
the network namespace of `slingshot-dns`, a dnsmasq
that answers nginx's address for any name under `SG_DOMAIN` and nothing else, and its only
root is the snowglobe's CA. nginx reaches it as `slingshot-dns:8080`. `slingshot` is a name, not a
handle: on the PDS with bare handles `snowglobe account` refuses it. To recreate `slingshot-dns`, recreate `slingshot` with it.
To build another Slingshot, set `SG_SLINGSHOT_COMMIT` to a full microcosm-rs commit; it picks
the source and names the image.

## The relay, built locally

**The relay is built locally, not pulled.** Upstream's relay (`ghcr.io/bluesky-social/indigo:relay-<commit>`)
checks every host through an SSRF-safe transport that refuses loopback and private addresses, with
no setting to turn it off. Its admin `requestCrawl` accepts `localhost:<port>`, and the host check
then fails with `unsafe network address`, so the published image can never crawl a PDS on a snowglobe.
`stack/relay/Dockerfile` builds the same upstream commit with `stack/relay/allow-private-hosts.patch`, which
adds one opt-in setting, `RELAY_ALLOW_PRIVATE_HOSTS`, and copies the binary into the published
image. The setting covers both places the relay refuses those addresses: the host check, and the
firehose dialer for `wss://` hosts, which [a snowglobe](snowglobe.md) needs because its
PDS names resolve to nginx's private address. Pick another commit with `SG_RELAY_INDIGO_COMMIT`; it needs a published `relay-<commit>`
image, and the patch has to apply.

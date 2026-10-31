# Configuration

Set these in the environment. `SG_DOMAIN`, `SG_BIND`, `SG_ROUTER` and the ports can also go in a `.env` file in
the snowglobe checkout. Every setting has a default.

## Snowglobe settings

| Variable | Default | Description |
| --- | --- | --- |
| `SG_PROJECT` | the file's `globe:` name | The snowglobe's Docker Compose project name ([Up and down](snowglobe.md#up-and-down)) |
| `SG_FILE` | none | The `snowglobe.yml` a command reads when no file is named. Without it, the nearest `snowglobe.yml` in the folder you run from or above ([Which snowglobe](snowglobe.md#which-snowglobe-and-where-it-lives)) |
| `XDG_DATA_HOME` | unset | Where snowglobes keep their state, in `snowglobe/` under it. Without it, `~/.local/share/snowglobe` (`%LOCALAPPDATA%\snowglobe` on Windows) |
| `SG_DOMAIN` | `<globe>.local.snowglobe.at` | The domain every name in the snowglobe sits under, in place of the file's `domain` ([The snowglobe](snowglobe.md)) |
| `SG_BIND` | chosen by `up` | The loopback address nginx (443) and every port below are published on. `up` picks one for each snowglobe the first time (the first `127.0.0.N` from `127.0.0.2` that nothing answers on; from `127.0.0.1` where the name router does not run) and keeps it in the `bind` file in the snowglobe's state folder; set `SG_BIND` to choose it yourself. A snowglobe on `127.0.0.1` holds the name router's address, so the router does not start while it runs |
| `SG_ROUTER` | on, on Linux | `off` turns the name router off: `up` neither starts it nor routes to the snowglobe, and only a snowglobe on `127.0.0.1` is reached by name, as before 0.5.0. It does not run on other systems yet ([From a browser on your own computer](browser.md)) |
| `SG_PLC_PORT` | `2582` | The PLC, on the snowglobe's address |
| `SG_JETSTREAM_PORT` / `SG_JETSTREAM_METRICS_PORT` | `6008` / `6009` | Jetstream and its metrics, on the snowglobe's address |
| `SG_MAILDEV_WEB_PORT` / `SG_MAILDEV_SMTP_PORT` | `1081` / `1026` | MailDev, on the snowglobe's address |
| `SG_PROXY_PORT` | `1080` | The browser proxy from before 0.5.0, on the snowglobe's address. A forwarded port 443 replaces it ([From a browser on your own computer](browser.md)) |
| `SG_OPENSOCIAL_BUILD` | none | A checkout of atproto-group-host, for a group host the file lists with no `build` or `image` |
| `SG_PDS_ADMIN_PASSWORD`, `SG_PDS_JWT_SECRET`, `SG_PLC_ROTATION_KEY`, `SG_RELAY_ADMIN_PASSWORD`, `SG_DB_PASSWORD` | random, made by `up` | The secrets the services start with: the PDSes' admin password, JWT secret and PLC rotation key, the relay's admin password, and the PLC database's password. Unset, `up` makes each one and keeps it in `secrets.env` (mode 600) in the snowglobe's state folder, where `account` and `invite` read the admin password; set, the value is used instead and not written. A snowglobe whose data was made before they were random keeps the old fixed JWT secret, rotation key, relay and database passwords (a database keeps the password it first started with, and a DID names the key that made it), and `up` says so once; `snowglobe down -v` and `up` start it over with random ones (`down -v` drops the fixed values from `secrets.env` only after Docker has removed the volumes). If Docker cannot say whether there is data, `up` stops and asks you to run it again once Docker answers |
| `SG_RELAY_INDIGO_COMMIT` | `b2619d8...` | The indigo commit the relay image is built from ([The relay, built locally](how-it-works.md#the-relay-built-locally)) |
| `SG_SLINGSHOT_COMMIT` | `3137b07...` | The microcosm-rs commit Slingshot is built from ([Slingshot](how-it-works.md#slingshot-handles-and-dids-inside-the-network)) |
| `SG_PREBUILT` | unset | `0` makes `up` build Slingshot, PDSls and the relay itself, never pulling a published image |
| `SG_IMAGE_REGISTRY` | `ghcr.io/openmeet-team` | Where `up` looks for those published images; empty skips the pull. An image is used only when its label matches the files in your checkout, so an edited `stack/` folder is built |
| `SG_RESET_OK` | unset | `1` lets `up` and `down` act on the shared project `devnet-spaces` |

To run a second snowglobe beside another, give it a file with its own `globe:` name and run `snowglobe up`. It takes its own
address and its own domain, so the ports above do not clash, nothing needs setting, and the name router reaches both by
name. (On macOS only `127.0.0.1` exists until you add more, for example `sudo ifconfig lo0 alias 127.0.0.2`, and with no
router there only the snowglobe on `127.0.0.1` is reached by name.)

## Variables the tools read

| Variable | Default | Description |
| --- | --- | --- |
| `ACCOUNTS_FILE` | `<state>/accounts.env` | Where `account` writes the logins it makes, and where `lexicons` finds the authority's login |
| `INVITE_USES` | `100` | How many uses `invite` gives a code |
| `HTTPS_EXTRA_NAMES` | none | Names, space-separated, added to the certificate nginx serves, for a name more than one label under the domain ([The CA](browser.md#the-ca)) |

The snowglobe also writes facts for its own commands into `<state>/globe/globe.env` (`SG_PDS`,
`SG_SERVICES` and others) and sets a few names inside its containers. They are not settings.
`SG_PUBLIC=1` points `lexicons` at a hosted snowglobe, for the people who run one.

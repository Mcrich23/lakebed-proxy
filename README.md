# lakebed-proxy

Use Lakebed as the egress point for your Mac's HTTP and HTTPS traffic.

`lakebed-proxy` starts a local proxy on your machine, deploys a tiny Lakebed relay for you, and sends your proxied web requests through that Lakebed deployment. It can also configure your Wi-Fi proxy settings while it runs and put them back when you stop it.

## Quick Start

Run from GitHub with npm:

```sh
npx lakebed-proxy run
```

Or with pnpm:

```sh
pnpm dlx lakebed-proxy run
```

Replace `<owner>` with the GitHub owner for this repository.

On the first run, Lakebed will open a claim page in your browser. Claim the deployment, return to the terminal, and the proxy will finish starting.

## HTTPS Setup

HTTPS proxying requires a local certificate authority. `lakebed-proxy` creates one at:

```text
~/.lakebed-proxy/ca/lakebed-proxy-ca.crt
```

Trust it once:

```sh
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "$HOME/.lakebed-proxy/ca/lakebed-proxy-ca.crt"
```

Without this step, browsers and curl will reject HTTPS traffic through the proxy. For quick curl-only testing, you can use `curl -k`.

## Use It

Start the proxy:

```sh
lakebed-proxy run
```

By default it listens on:

```text
127.0.0.1:8080
```

The CLI prints the exact macOS commands to enable and disable the HTTP and HTTPS proxies for your active network service.

To let the CLI manage Wi-Fi proxy settings for you:

```sh
lakebed-proxy run --auto
```

`--auto` requires the HTTPS CA to already be trusted. It saves your current Wi-Fi proxy settings, points Wi-Fi at `lakebed-proxy`, and restores the original settings when you stop the process.

## Options

```sh
lakebed-proxy run [--host 127.0.0.1] [--port 8080] [--api https://api.lakebed.app] [--auto]
```

- `--host <host>`: local host to bind, default `127.0.0.1`
- `--port <port>`: local port to bind, default `8080`
- `--api <url>`: Lakebed API URL, default `https://api.lakebed.app`
- `--auto`: set Wi-Fi web proxies while running and restore them on shutdown

## How It Works

- Every run deploys or refreshes a generated Lakebed capsule in `~/.lakebed-proxy/capsule`.
- The current Lakebed deployment URL is saved in `~/.lakebed-proxy/state.json`.
- HTTP requests are forwarded through Lakebed.
- HTTPS requests are decrypted locally with your trusted `lakebed-proxy` CA, then forwarded through Lakebed.
- If Lakebed returns a different deployment URL, the CLI tells you.

## Notes

- Apps with certificate pinning may reject the local HTTPS interception.
- Request and response bodies are non-streaming and subject to Lakebed's payload limits.
- `--auto` currently manages the `Wi-Fi` network service only.
- If `--auto` cannot restore your settings, disable them manually:

```sh
networksetup -setwebproxystate "Wi-Fi" off
networksetup -setsecurewebproxystate "Wi-Fi" off
```

## Local Development

```sh
npm link
lakebed-proxy run
```

or:

```sh
pnpm link --global
lakebed-proxy run
```

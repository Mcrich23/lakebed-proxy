# lakebed-proxy

Run a local macOS-compatible HTTP proxy backed by a claimed Lakebed deployment.

The CLI has one command:

```sh
pnpm dlx github:<owner>/lakebed-proxy run
```

Replace `<owner>` with the GitHub owner or install from a local checkout:

```sh
pnpm link --global
lakebed-proxy run
```

## What `run` does

Every run:

1. Creates or refreshes a generated Lakebed capsule in `~/.lakebed-proxy/capsule`.
2. Runs `pnpm dlx lakebed deploy` for that capsule.
3. Opens the Lakebed claim flow on first use if outbound fetch is not enabled yet.
4. Redeploys after claim so the server-side proxy route can fetch outbound HTTP.
5. Records the latest deploy ID and URL in `~/.lakebed-proxy/state.json`.
6. Starts a local proxy on `127.0.0.1:8080`.
7. Generates a local MITM CA under `~/.lakebed-proxy/ca` so HTTPS can be proxied through Lakebed after you trust the CA.

If Lakebed returns a different deploy URL, the CLI prints:

```text
Lakebed proxy URL changed: <old> -> <new>
```

## macOS proxy setup

Once the proxy is serving, the CLI prints commands like:

```sh
networksetup -setwebproxy "Wi-Fi" 127.0.0.1 8080
networksetup -setsecurewebproxy "Wi-Fi" 127.0.0.1 8080
```

It also prints matching undo commands:

```sh
networksetup -setwebproxystate "Wi-Fi" off
networksetup -setsecurewebproxystate "Wi-Fi" off
```

The CLI only prints these commands. It does not modify system proxy settings itself.

For HTTPS, the CLI also prints a command to trust its generated local CA:

```sh
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$HOME/.lakebed-proxy/ca/lakebed-proxy-ca.crt"
```

Until that CA is trusted, browsers and curl will reject HTTPS sites proxied through `lakebed-proxy`. For one-off curl testing, `-k` can skip certificate verification.

## Behavior

- Plain HTTP proxy requests go through Lakebed.
- HTTPS `CONNECT` requests are terminated locally with generated per-host certificates signed by the local CA, then relayed through Lakebed.
- HTTPS is decrypted on your Mac before being sent through Lakebed, so certificate-pinned clients may fail.
- HTTP responses are non-streaming and subject to Lakebed request and payload limits.

## Flags

The public command is `run`, with explicit flags for configuration:

```sh
lakebed-proxy run --host 127.0.0.1 --port 8081
```

- `--host <host>`: bind host, default `127.0.0.1`
- `--port <port>`: bind port, default `8080`
- `--api <url>`: Lakebed API URL, default `https://api.lakebed.app`

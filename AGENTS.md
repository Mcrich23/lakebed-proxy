# Project Instructions

This repository ships the `lakebed-proxy` Node CLI.

## Commands

Use pnpm for package commands:

```sh
pnpm run check
```

The CLI itself invokes Lakebed with:

```sh
pnpm dlx lakebed ...
```

## Runtime Shape

- `bin/lakebed-proxy.js` is the public CLI entrypoint.
- The only public command is `lakebed-proxy run`.
- `run` generates a Lakebed capsule under `~/.lakebed-proxy/capsule`.
- Do not add a root Lakebed capsule unless the CLI workflow changes.

## Constraints

- Keep the public CLI small: the only public command is `run`; use flags for configuration.
- Do not mutate macOS proxy settings automatically; print `networksetup` commands instead.
- Plain HTTP goes through Lakebed.
- HTTPS uses a local `CONNECT` tunnel and must not be decrypted.

# Project Instructions

This repository ships the `lakebed-proxy` Node CLI.

## Commands

Use pnpm for repo package commands when available:

```sh
pnpm run check
```

The CLI invokes Lakebed with pnpm when available and falls back to npx:

```sh
pnpm dlx lakebed ...
npx -y lakebed ...
```

## Runtime Shape

- `bin/lakebed-proxy.js` is the public CLI entrypoint.
- The only public command is `lakebed-proxy run`.
- `run` generates a Lakebed capsule under `~/.lakebed-proxy/capsule`.
- Do not add a root Lakebed capsule unless the CLI workflow changes.

## Constraints

- Keep the public CLI small: the only public command is `run`; use flags for configuration.
- Only mutate macOS proxy settings when `run --auto` is used, and restore the original Wi-Fi settings on shutdown.
- Plain HTTP goes through Lakebed.
- HTTPS is MITM'd locally with a generated CA and then relayed through Lakebed.

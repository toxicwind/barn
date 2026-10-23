# gatehouse — the estate MCP federation gateway (vendored mcpproxy-go)

This subtree is the **build home** of the estate gatehouse. The `serve` binary
that federates MCP tools across the box (:25127) is produced here from the
**vendored mcpproxy-go source**, replacing the old pinned propylon prebuilt
binary (`ranch/propylon/gatehouse-v0.51.0`).

```
ranch/barn/gatehouse/
├── build.sh      # reproducible build: go build ./cmd/mcpproxy -> bin/gatehouse
├── vendor/       # vendored mcpproxy-go source (module github.com/smart-mcp-proxy/mcpproxy-go)
└── bin/gatehouse # build artifact (gitignored)
```

## Why vendored

- **Forward-only, no magic binary.** The gateway is compiled from source we
  control under `vendor/`, so `git log` on the gateway is real. No opaque
  `propylon/gatehouse-v0.51.0` fork.
- **MCP-federation upstream.** `vendor/` is a snapshot of
  `ranch/mcpproxy-go` (the real gateway), folded into the estate serve wiring.
- **Reproducible.** `./build.sh` rebuilds `bin/gatehouse` deterministically.

## Refresh the vendor

To pull newer mcpproxy-go federation changes:

```sh
SRC=/home/toxic/estate/ranch/mcpproxy-go
rsync -a \
  --exclude='.git' --exclude='specs' --exclude='docs' --exclude='website' \
  --exclude='frontend' --exclude='e2e' --exclude='bench' --exclude='tests' \
  --exclude='results' --exclude='.github' --exclude='.specify' "$SRC"/ vendor/
# ensure //go:embed all:frontend/dist target exists
mkdir -p vendor/web/frontend/dist && touch vendor/web/frontend/dist/.gitkeep
./build.sh
```

## Serve wiring

`range/bin/gatehouse-serve.ts` spawns `bin/gatehouse serve --listen=127.0.0.1:25127`
with `MCPPROXY_API_KEY` sourced from secretsmith. `mcp_config.json` lives in
`ranch/gatehouse/` and is seeded from `.dist`.

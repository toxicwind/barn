---
name: <product-name>
description: <one-line description of when to use the product>
---

# <product-name> — <pen> pen product

> **Pen**: <pen> (<theme>) · **Repo**: toxicwind/<product-name> · **Port**: <port | none>

## Purpose

<What this product does, in two sentences.>

## Entrypoints

| Binary | Path | Symlink target |
|--------|------|----------------|
| <bin-name> | `bin/<bin-name>` | `~/.local/bin/<bin-name>` |

## Configuration

<Config file paths, env vars, secretsmith labels.>

## Manifest

`MANIFEST.json` (schema v2) declares binaries, pitchfork daemon, health, ports,
secrets, build commands, repo info, blackbird config, freeinference coordinator
config, and bin-verify expectations. Validate with:

```bash
bun -e 'JSON.parse(await Bun.file("MANIFEST.json").text())'
```

## Pitchfork

```toml
[daemons.<daemon-name>]
run = "exec <command>"
auto = ["start"]
retry = true
ready_http = "http://127.0.0.1:<port>/health"
port = <port>
dir = "<product dir>"
mise = false
```

## Testing

```bash
bun test        # bun tests
bun run scan    # product-specific smoke
```

## Rules (refining pens/AGENTS.md)

- Standalone git repo — never a submodule.
- Secrets via secretsmith keyring only.
- GitHub search via blackbird only.
- Freeinference traffic via freeinference-coordinator (:25250).

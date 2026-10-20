# chute

> 🗺️ Part of [**the ranch**](https://github.com/toxicwind/ranch) — the whole inference estate, one map.

TCP ↔ stdio ACP passage for the herd.

Named for the ranch chute: the constrained single-file passage through
which animals are moved for observation and processing. Every external
ACP connection enters the herd through this one narrow gate, is
normalized, and is handed to a per-connection child.

## Why it exists

`omp acp` speaks stdio only. Pitchfork supervises daemons by TCP
readiness probe. This passage makes the tau engine observable as a
daemon on a real port, without modifying omp.

It also enforces one ACP schema invariant that upstream does not
enforce: `params.mcpServers` on `session/new` and `session/load` must
be a normalized array. The vansrouter extension depends on that shape.

## Layout

```
chute/
├── README.md           this file
├── package.json        name, type=module, test script
├── chute.mjs           entry: parse argv, dispatch to check or serve
├── src/
│   ├── index.mjs       barrel export (consume chute as a library)
│   ├── args.mjs        argv parsing, env fallback, validation
│   ├── normalize.mjs   mcpServers shape rules
│   ├── transform.mjs   line-oriented JSON rewriter as a Transform
│   ├── check.mjs       readiness probe (bind ephemeral, exit)
│   ├── server.mjs      TCP listener, one child per connection
│   └── log.mjs         stderr-only structured logging
└── test/
    ├── args.test.mjs       argv parsing edge cases
    ├── normalize.test.mjs  shape rules, url/headers preservation
    ├── transform.test.mjs  whole, split, multi-byte, flush
    └── smoke.test.mjs      --check, live connection, missing cmd
```

## Invocation

```
chute [--port <port>] -- <cmd> [args...]
chute --check
```

Port resolves in this order: `--port` flag, `CHUTE_PORT` env,
`ACP_BRIDGE_PORT` env (back-compat), default `25111`.

## Protocol behavior

For each accepted TCP connection:

1. Spawn one child: `<cmd> <args...>` with stdin/stdout piped,
   stderr inherited.
2. Pipe socket bytes through a line-oriented normalizer.
3. Pipe child stdout back to the socket.
4. On socket close or error, terminate the child with `SIGTERM`.

Normalizer rules for `session/new` and `session/load`:

| Input `params.mcpServers` | Output |
|---|---|
| `undefined` / `null` | `[]` |
| array | each entry coerced |
| object | `Object.entries` → array, key becomes `name` |
| entry with `url` | `{type: "http"\|given, name, url, headers?}` |
| entry without `url` | `{type: "stdio", name, command, args[], env[]}` |

Non-JSON lines and non-target frames pass through unchanged.
Partial lines are buffered and reassembled; the stream flushes any
trailing partial on close.

## Testing

```
bun test
```

Covers argv parsing (including invalid port rejection and env
fallback), shape normalization (url/headers preservation, object
form, non-object coercion), the transform stream (whole line, split
line, multi-byte split, trailing flush), and an end-to-end smoke test
that spawns the entry, connects a real socket, and verifies a
`session/new` frame is normalized before reaching the child.

## Related

- Gateway: `projects/range/ranch/barn/wrangler/` — MCP federation on :25127
- Engine: `tau/` — the omp fork
- Supervisor: `pitchfork.toml` `[daemons.tau]`
- PATH shim: `bin/chute` → this file

## Design notes

- **No external deps.** Node core only. The whole tree runs on any
  Node ≥ 18 and on Bun without a lockfile.
- **stdout is reserved.** `log()` writes to stderr only, because
  stdout carries ACP frames on the wire.
- **Explicit `.mjs` everywhere.** Module type is never inferred from
  a distant `package.json`. The `.mjs` extension is self-describing
  and survives being copied out of the tree.
- **`--check` binds ephemeral, not the real port.** A readiness probe
  that binds the real port would fail if the daemon is already up.
  Ephemeral binding only proves the process can create a listener.
- **One child per connection.** Not a pool. The supervisor restarts
  on child exit; the connection's lifecycle is the child's lifecycle.

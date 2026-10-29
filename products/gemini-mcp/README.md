# gemini-mcp

> 🗺️ Part of [**the ranch**](https://github.com/toxicwind/ranch) — the whole inference estate, one map.

First-class Gemini API MCP server for awrawr-pc. Multi-key pool with
round-robin + automatic failover across 5 Gemini API keys.

## Tools

- `list_models` — available Gemini models across the healthy key pool
- `generate_content(prompt, model, system, temperature, max_output_tokens)` — text generation
- `count_tokens(prompt, model)` — token counting
- `keys_status` — per-key health (labels + fingerprints only, never values)

## Transport

- Streamable HTTP via FastMCP, `127.0.0.1:25202`, path `/mcp`
- Auth: `X-MCP-Token` header must equal `~/.gemini_mcp_token` (0600)
- `GET /health` — no-auth, content-free pitchfork readiness probe
- Tailscale funnel: `https://github-mcp-host.tailc9ac71.ts.net/gemini-mcp` -> `127.0.0.1:25202/mcp`

## Key management

Key VALUES live only in `~/.secrets` (0600) as `GEMINI_API_KEY_1..5`
(+ `_NAME`, `_PROJECT`, `_EAP` metadata). The server, logs, audit trail,
and this repo never contain key values — logs reference keys by label
(`GEMINI_API_KEY_2`) or fingerprint (`AQ.A...1uzA`) only.

Rotation: round-robin over healthy keys; a key is cooled down 90 s on
429/5xx, 600 s on 401/403, 30 s on transport errors.

## Run

Managed by pitchfork (`gemini-mcp` daemon in `/home/toxic/estate/pitchfork.toml`).
Manual: `/home/toxic/.awrawr-mcp-venv/bin/python server.py`

## SDK

`/home/toxic/.gemini-sdk-venv` holds the maximal Google API SDK surface
(`google-generativeai`, `google-ai-generativelanguage`,
`google-api-python-client`), refreshed nightly by the
`gemini-sdk-refresh.timer` systemd user timer (`ops/`).

## Docs

- `docs/KEY_AUDIT.md` — per-key validity + EAP audit (2026-09-14)
- `docs/API_INVENTORY.md` — consolidated model/API inventory

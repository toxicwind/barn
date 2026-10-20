# lookout

> 🗺️ Part of [**the ranch**](https://github.com/toxicwind/ranch) — the whole inference estate, one map.

The ranch's watchtower. An isolated virtual display where the agent browser
lives, plus an interactive web viewer so the Architect can climb up and see what
it's doing — without the browser ever touching his visible Hyprland session.

## What it is

Three pitchfork daemons working together:

| Daemon | Port | What it does |
|--------|------|--------------|
| `agent-display` | `5900` (RFB) | Xvnc `:99` — the isolated virtual display. 1600x900, VNC auth. The agent Chromium renders here, never in Hyprland. |
| `agent-viewer` | `6080` (HTTP/WS) | noVNC/websockify — the web viewer. **Interactive** (the Architect 2026-09-21): click, type, take over the agent's display. Loopback-only. |
| `browser-keeper` | `9223` (CDP) | The headed Chromium itself. Lives on `DISPLAY=:99`. See `../browserless/keeper/`. |

## Access

- **Tailnet:** `https://github-mcp-host.tailc9ac71.ts.net:8443/agent-browser` → websockify `:6080` → Xvnc `:5900`
- **Local:** `http://127.0.0.1:6080/vnc.html` (on the box)
- **VNC password:** `/home/toxic/.browserless/vncpasswd` (0600, not in git)
- **noVNC assets:** `/home/toxic/.browserless/novnc` (upstream noVNC dist, not in git)

The old token gate (`:6081`) was retired 2026-09-21 per the Architect — tailnet-only,
no token. See `../browserless/viewer/README.md` for the retired gate docs.

## Why it exists

Keeper.js used to launch Chromium with `WAYLAND_DISPLAY=wayland-1` — the
agent browser rendered as real windows inside the Architect's Hyprland session.
Focus steals, mouse takeovers. The fix (Forge 2026-09-21): run it headed
(headed-ness is load-bearing for bot-mitigation fingerprint) on an isolated
Xvnc display, with noVNC as the interactive window into it.

Isolation protects the Architect's session. The viewer gives him full input into
the agent's display. Both at once.

## Files

- `pitchfork.fragment.toml` — daemon records for `agent-display` and
  `agent-viewer`. Already merged into `/home/toxic/estate/pitchfork.toml`;
  this is the committed record. Owned restart from `/home/toxic/estate`:
  `./bin/pitchfork-restart <agent-display|agent-viewer> --reregister`
- `README.md` — this file

The keeper itself lives at `../browserless/keeper/` (its own lane).

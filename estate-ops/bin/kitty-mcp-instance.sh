#!/bin/sh
# kitty-mcp-instance — the Gatehouse kitty MCP server's contract instance.
# Pry 2026-10-19; headless-friendly 2026-10-19.
# The kitty MCP server (ranch/vendored/kitty-mcp-server) drives kitty via
# `kitten @ --to $KITTY_MCP_SOCKET`; that address must be STABLE, and kitty's
# own config cannot provide one here:
#   - unix listen_on paths get -<pid> appended by kitty;
#   - kitty.conf listen_on is ignored by kitty 0.48.2 in this setup
#     (verified: conf-only launches bind ephemeral ports), while the
#     --listen-on CLI flag is honored.
# So the contract instance is pitchfork-supervised and launched with the
# flag: tcp:127.0.0.1:25211 (matches KITTY_MCP_SOCKET in the Gatehouse
# live config and mcp_config.json.dist).
# Window policy: --single-instance reuses an existing kitty window instead of
# popping a new one per supervisor cycle; --detach keeps it out of the
# foreground terminal.
export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=wayland-1
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
# Wait for the graphical session's wayland socket (boot ordering).
while [ ! -S /run/user/1000/wayland-1 ]; do sleep 5; done
exec /usr/bin/kitty --single-instance --detach --listen-on tcp:127.0.0.1:25211 --title kitty-mcp

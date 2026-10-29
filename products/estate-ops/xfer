#!/usr/bin/env python3
"""xfer.py — binary-safe, resumable file transfer over the awrawr bridge.

Saves files to awrawr-pc without shells, quoting, base64 dances, or the
90s exec ceiling. Binary frames (opcode 0x2) carry raw bytes; the server
verifies size+sha256 and installs atomically. Interrupted uploads resume.

Usage:
    xfer.py put <local> <remote> [--chunk-kb N]
    xfer.py get <remote> <local> [--chunk-kb N]

Transport (--via auto|bridge|direct, default auto):
  bridge — from the cell: wss:// through the egress proxy, auth via the
           Secure Vault surrogate (custom.awrawr-mcp). Parallel lane:
           its own connection, separate from the exec multiplex.
  direct — from awrawr-pc itself (interactive shell included):
           ws://127.0.0.1:8379/exec-ws, auth via ~/.awrawr_mcp_token.
           No proxy, no TLS, no vault needed.
  auto   — direct if 127.0.0.1:8379 is reachable, else bridge.

Remote paths must be inside /home/toxic or /tmp (server policy).
"""
import argparse
import asyncio
import base64
import hashlib
import json
import os
import secrets
import socket
import ssl
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wsframe import (WS_GUID, read_frame, send_frame, read_message,
                     _DrainTimeout)  # noqa: E402

WS_HOST = "github-mcp-host.tailc9ac71.ts.net"
WS_PATH = "/exec-ws"
LOCAL_PORT = 8379
TOKEN_FILE = os.path.expanduser("~/.awrawr_mcp_token")
IDLE_S = 150
PUT_DRAIN_TIMEOUT_S = 60.0  # cinder-idletime: < server XFER_IDLE_S=120


def _surrogate():
    sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
    sys.path.insert(0, os.path.join(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))), "..",
        "skill-creator", "bin"))
    from dynamic_credentials import dynamic_credential_entry
    entry = dynamic_credential_entry("custom.awrawr-mcp")
    placement = entry.get("placement") or {}
    header = placement.get("custom_header", "X-MCP-Token")
    return header, str(entry["surrogate"]).strip()


def _proxy_target():
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        v = os.environ.get(k, "")
        if v:
            u = urllib.parse.urlparse(v)
            return u.hostname, u.port or 8080
    raise RuntimeError("no proxy configured")


async def _ws_handshake(reader, writer, host, path, auth_header,
                        auth_value):
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    writer.write((
        "GET %s HTTP/1.1\r\nHost: %s\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n"
        "%s: %s\r\n\r\n" % (path, host, key, auth_header, auth_value)
    ).encode())
    await writer.drain()
    hs = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 20)
    if b"101" not in hs.split(b"\r\n", 1)[0]:
        raise RuntimeError("ws handshake failed: " +
                           hs.split(b"\r\n", 1)[0][:80].decode("latin-1"))


async def connect_bridge():
    """Cell -> wss:// through the egress proxy, surrogate auth."""
    header, surrogate = await asyncio.to_thread(_surrogate)
    phost, pport = _proxy_target()
    raw = socket.create_connection((phost, pport), timeout=15)
    try:
        raw.sendall(("CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n"
                     % (WS_HOST, WS_HOST)).encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            blk = raw.recv(4096)
            if not blk:
                break
            resp += blk
        if b" 200" not in resp.split(b"\r\n", 1)[0]:
            raise RuntimeError("proxy CONNECT failed")
        ctx = ssl.create_default_context()
        reader, writer = await asyncio.open_connection(
            sock=raw, ssl=ctx, server_hostname=WS_HOST)
    except Exception:
        raw.close()
        raise
    await _ws_handshake(reader, writer, WS_HOST, WS_PATH, header, surrogate)
    return reader, writer


async def connect_direct():
    """awrawr-pc -> ws://127.0.0.1:8379, token-file auth. No proxy/TLS."""
    try:
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
    except OSError:
        raise RuntimeError("no token file: " + TOKEN_FILE)
    if not token:
        raise RuntimeError("empty token file")
    reader, writer = await asyncio.open_connection("127.0.0.1", LOCAL_PORT)
    await _ws_handshake(reader, writer, "127.0.0.1:%d" % LOCAL_PORT,
                        WS_PATH, "X-MCP-Token", token)
    return reader, writer


async def connect(via):
    if via == "direct":
        return await connect_direct()
    if via == "bridge":
        return await connect_bridge()
    # auto: direct when the local port answers
    try:
        s = socket.create_connection(("127.0.0.1", LOCAL_PORT), timeout=3)
        s.close()
        return await connect_direct()
    except OSError:
        return await connect_bridge()


async def _send_json(writer, doc):
    await send_frame(writer, 0x1, json.dumps(doc).encode(), mask=True)


async def _pong(writer, payload):
    await send_frame(writer, 0xA, payload, mask=True)


async def _recv_json(reader, writer):
    while True:
        kind, payload = await asyncio.wait_for(read_message(reader), IDLE_S)
        if kind == "ping":
            await _pong(writer, payload)
            continue
        if kind is not True:
            raise RuntimeError("expected text frame, got binary")
        return json.loads(payload.decode("utf-8", "replace"))


def _sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            blk = f.read(1048576)
            if not blk:
                break
            h.update(blk)
    return h.hexdigest()


async def do_put(reader, writer, local, remote, chunk, mode):
    size = os.path.getsize(local)
    digest = _sha256_of(local)
    # "transfer busy" means another put to the same path is live: bounded
    # retries poll that real condition instead of failing the save.
    deadline = time.monotonic() + 300
    while True:
        try:
            await _put_once(reader, writer, local, remote, size, digest,
                            chunk, mode)
            return
        except RuntimeError as e:
            if "transfer busy" not in str(e) or time.monotonic() >= deadline:
                raise
            await asyncio.sleep(2)


async def _put_once(reader, writer, local, remote, size, digest,
                    chunk, mode):
    op_id = secrets.token_hex(8)
    try:
        await _send_json(writer, {"id": op_id, "op": "put", "path": remote,
                                  "size": size, "sha256": digest,
                                  "mode": mode})
        doc = await _recv_json(reader, writer)
        if doc.get("type") == "put-error":
            raise RuntimeError("server: " + doc.get("message", "?"))
        if doc.get("type") != "put-ready":
            raise RuntimeError("unexpected reply: %r" % (doc,))
        offset = int(doc.get("offset", 0))
        sent = 0
        t0 = time.monotonic()
        with open(local, "rb") as f:
            f.seek(offset)
            while True:
                blk = f.read(chunk)
                if not blk:
                    break
                await send_frame(writer, 0x2, blk, mask=True,
                                     drain_timeout=PUT_DRAIN_TIMEOUT_S)
                sent += len(blk)
        await _send_json(writer, {"id": op_id, "op": "put-end"})
        doc = await _recv_json(reader, writer)
        dt = time.monotonic() - t0
        if doc.get("type") != "put-done":
            raise RuntimeError("server: " + doc.get("message", repr(doc)))
        bps = (size - offset) / dt if dt > 0 else 0
        print("put %s -> %s  %d bytes  sha256 ok  %.1fs  %.0f B/s%s"
              % (local, doc.get("path"), size, dt, bps,
                 "  (resumed from %d)" % offset if offset else ""))
    finally:
        pass


async def do_get(reader, writer, remote, local, chunk):
    op_id = secrets.token_hex(8)
    try:
        await _send_json(writer, {"id": op_id, "op": "get", "path": remote})
        doc = await _recv_json(reader, writer)
        if doc.get("type") == "get-error":
            raise RuntimeError("server: " + doc.get("message", "?"))
        if doc.get("type") != "get-meta":
            raise RuntimeError("unexpected reply: %r" % (doc,))
        size = int(doc["size"])
        want = doc["sha256"]
        tmp = local + ".part-xfer"
        received = 0
        t0 = time.monotonic()
        with open(tmp, "wb") as f:
            while received < size:
                kind, payload = await asyncio.wait_for(
                    read_message(reader), IDLE_S)
                if kind == "ping":
                    await _pong(writer, payload)
                    continue
                if kind is True:
                    end = json.loads(payload.decode("utf-8", "replace"))
                    if end.get("type") == "get-error":
                        raise RuntimeError("server: " +
                                           end.get("message", "?"))
                    raise RuntimeError("unexpected text frame: %r" % (end,))
                f.write(payload)
                received += len(payload)
        # drain the get-done
        doc = await _recv_json(reader, writer)
        if doc.get("type") != "get-done":
            raise RuntimeError("missing get-done: %r" % (doc,))
        got = _sha256_of(tmp)
        if got != want:
            os.unlink(tmp)
            raise RuntimeError("sha256 mismatch on download")
        os.replace(tmp, local)
        dt = time.monotonic() - t0
        print("get %s -> %s  %d bytes  sha256 ok  %.1fs  %.0f B/s"
              % (remote, local, size, dt,
                 size / dt if dt > 0 else 0))
    finally:
        pass


async def amain(args):
    reader, writer = await connect(args.via)
    try:
        if args.cmd == "put":
            await do_put(reader, writer, args.local, args.remote,
                         args.chunk_kb * 1024, args.mode)
        else:
            await do_get(reader, writer, args.remote, args.local,
                         args.chunk_kb * 1024)
    finally:
        try:
            writer.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--via", choices=["auto", "bridge", "direct"],
                    default="auto")
    ap.add_argument("--chunk-kb", type=int, default=64,
                    help="upload frame size in KiB (race winner: 64)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("put")
    p.add_argument("local")
    p.add_argument("remote")
    p.add_argument("--mode", default="0644")
    g = sub.add_parser("get")
    g.add_argument("remote")
    g.add_argument("local")
    args = ap.parse_args()
    try:
        asyncio.run(amain(args))
    except Exception as e:
        print("xfer: %s" % e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

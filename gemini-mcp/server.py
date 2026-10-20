#!/usr/bin/env python3
"""gemini-mcp: first-class Gemini API MCP server.

Multi-key pool with round-robin + failover. Key values live only in
$HOME/.secrets (0600) and are NEVER logged, returned, or committed --
logs reference keys by label (GEMINI_API_KEY_2) or fingerprint only.

Tools: list_models, generate_content, count_tokens, keys_status.
Transport: FastMCP Streamable HTTP on 127.0.0.1:$GEMINI_MCP_PORT (25202),
path /mcp, header auth X-MCP-Token == ~/.gemini_mcp_token.
GET /health (no auth, content-free) for pitchfork readiness.
"""
import anyio
import json
import os
import re
import time
import urllib.request
import urllib.error

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse, JSONResponse
from starlette.routing import Route

PORT = int(os.environ.get("GEMINI_MCP_PORT", "25202"))
TOKEN_FILE = os.path.expanduser("~/.gemini_mcp_token")
SECRETS_FILE = os.path.expanduser("~/.secrets")
AUDIT = os.path.expanduser("~/.gemini_mcp_audit.jsonl")
COOLDOWN_S = 90
API_BASE = "https://generativelanguage.googleapis.com/v1beta/"


def _log(event, info):
    try:
        with open(AUDIT, "a") as f:
            f.write(json.dumps({"ts": time.time(), "event": event, **info}) + "\n")
    except OSError:
        pass


def _fp(v):
    return v[:4] + "..." + v[-4:] if len(v) >= 8 else "****"


def _load_keys():
    """Parse GEMINI_API_KEY_N (+ _NAME/_PROJECT/_EAP) from ~/.secrets.

    Values stay in memory only; this function never prints them.
    """
    meta = {}
    try:
        with open(SECRETS_FILE) as f:
            for line in f:
                m = re.match(
                    r"""\s*export\s+(GEMINI_API_KEY_\d+(?:_NAME|_PROJECT|_EAP)?)\s*=\s*['"]?([^'"]*?)['"]?\s*$""",
                    line,
                )
                if m:
                    meta[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    keys = []
    i = 1
    while "GEMINI_API_KEY_%d" % i in meta:
        label = "GEMINI_API_KEY_%d" % i
        keys.append(
            {
                "label": label,
                "value": meta[label],
                "name": meta.get(label + "_NAME", ""),
                "project": meta.get(label + "_PROJECT", ""),
                "eap": meta.get(label + "_EAP", "0") == "1",
            }
        )
        i += 1
    return keys


class KeyPool:
    def __init__(self, keys):
        if not keys:
            raise RuntimeError("no GEMINI_API_KEY_N entries in ~/.secrets")
        self._keys = keys
        self._idx = 0
        self._cool = {}

    def healthy(self, label):
        return time.monotonic() >= self._cool.get(label, 0)

    def status(self):
        return [
            {
                "label": k["label"],
                "name": k["name"],
                "project": k["project"],
                "eap": k["eap"],
                "fingerprint": _fp(k["value"]),
                "healthy": self.healthy(k["label"]),
            }
            for k in self._keys
        ]

    def pick(self):
        n = len(self._keys)
        for _ in range(n):
            k = self._keys[self._idx % n]
            self._idx += 1
            if self.healthy(k["label"]):
                return k
        return min(self._keys, key=lambda k: self._cool.get(k["label"], 0))

    def cool(self, label, secs=COOLDOWN_S):
        self._cool[label] = time.monotonic() + secs
        _log("key-cooldown", {"label": label, "secs": secs})


class GeminiError(RuntimeError):
    def __init__(self, http_status, message):
        super().__init__(message)
        self.http_status = http_status


def _gl(path, payload=None, timeout=90):
    """REST call with round-robin + failover. Returns (body, key_label)."""
    last = GeminiError(0, "no healthy keys")
    tried = set()
    keys = POOL._keys
    while len(tried) < len(keys):
        k = POOL.pick()
        if k["label"] in tried:
            break
        tried.add(k["label"])
        url = API_BASE + path + ("&" if "?" in path else "?") + "key=" + k["value"]
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "gemini-mcp/1.0"},
        )
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.load(r)
            _log(
                "api-ok",
                {"label": k["label"], "op": path.split(":")[-1].split("?")[0],
                 "ms": int((time.monotonic() - t0) * 1000)},
            )
            return body, k["label"]
        except urllib.error.HTTPError as e:
            try:
                detail = json.load(e).get("error", {}).get("message", "")[:200]
            except Exception:
                detail = ""
            _log("api-error", {"label": k["label"], "http": e.code, "detail": detail})
            last = GeminiError(e.code, detail or "HTTP %d" % e.code)
            if e.code in (429, 500, 502, 503):
                POOL.cool(k["label"])
                continue
            if e.code in (401, 403):
                POOL.cool(k["label"], 600)
                continue
            raise last
        except Exception as e:
            _log("api-transport-error", {"label": k["label"], "err": str(e)[:120]})
            last = GeminiError(0, str(e)[:200])
            POOL.cool(k["label"], 30)
            continue
    raise last


def _mpath(model):
    m = (model or "").strip()
    return m if m.startswith("models/") else "models/" + m


def _contents(prompt, system=""):
    parts = [{"text": prompt}]
    body = {"contents": [{"role": "user", "parts": parts}]}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    return body


mcp = FastMCP("gemini-mcp")


@mcp.tool()
def list_models() -> dict:
    """List available Gemini models across the healthy key pool."""
    body, label = _gl("models?pageSize=100")
    return {
        "key_label": label,
        "models": [
            {
                "name": m.get("name"),
                "display_name": m.get("displayName"),
                "methods": m.get("supportedGenerationMethods", []),
            }
            for m in body.get("models", [])
        ],
    }


@mcp.tool()
def generate_content(
    prompt: str,
    model: str = "models/gemini-3.5-flash-lite",
    system: str = "",
    temperature: float = 0.7,
    max_output_tokens: int = 2048,
) -> dict:
    """Generate text with a Gemini model (automatic multi-key failover)."""
    payload = _contents(prompt, system)
    cfg = {}
    if temperature is not None:
        cfg["temperature"] = temperature
    if max_output_tokens:
        cfg["maxOutputTokens"] = max_output_tokens
    if cfg:
        payload["generationConfig"] = cfg
    body, label = _gl(_mpath(model) + ":generateContent", payload, timeout=120)
    texts = []
    for cand in body.get("candidates", []):
        for p in cand.get("content", {}).get("parts", []):
            if "text" in p:
                texts.append(p["text"])
    return {
        "key_label": label,
        "model": model,
        "text": "".join(texts),
        "usage": body.get("usageMetadata", {}),
    }


@mcp.tool()
def count_tokens(prompt: str, model: str = "models/gemini-3.5-flash-lite") -> dict:
    """Count tokens for a prompt against a Gemini model."""
    body, label = _gl(_mpath(model) + ":countTokens", _contents(prompt))
    return {"key_label": label, "model": model, "total_tokens": body.get("totalTokens")}


@mcp.tool()
def keys_status() -> dict:
    """Per-key health: labels, names, projects, EAP flags, fingerprints.

    Key VALUES are never exposed.
    """
    return {"keys": POOL.status()}


class HeaderTokenAuth(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        if request.headers.get("x-mcp-token") != _TOKEN:
            return PlainTextResponse("unauthorized", status_code=401)
        return await call_next(request)


async def _health(request):
    st = POOL.status()
    return JSONResponse(
        {
            "ok": True,
            "service": "gemini-mcp",
            "keys": len(st),
            "healthy_keys": sum(1 for s in st if s["healthy"]),
        }
    )


async def _serve():
    app = mcp.streamable_http_app()
    app.routes.append(Route("/health", _health))
    app.add_middleware(HeaderTokenAuth)
    _log("startup", {"port": PORT, "keys": [k["label"] for k in POOL._keys]})
    await uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning")
    ).serve()


_TOKEN = open(TOKEN_FILE).read().strip()
POOL = KeyPool(_load_keys())

if __name__ == "__main__":
    anyio.run(_serve)

#!/usr/bin/env python3
"""herd-model-guard — card-derived per-model request enforcement for herd.

Listens on 127.0.0.1:25101 (override with MODEL_GUARD_HOST / MODEL_GUARD_PORT env), reverse-proxies to herd on 127.0.0.1:25100
(override with MODEL_GUARD_UPSTREAM).
For POST <any>/v1/chat/completions with a constrained model ID, rewrites
the request body per config/model_constraints.yaml BEFORE it reaches herd:

  force              params are set unconditionally (e.g. K3 top_p=0.95)
  clamp              out-of-range/missing values -> card default
                     (e.g. K3 reasoning_effort only low|high|max)
  thinking_always_on any thinking-disable flag is flipped back on
  strip_never        declared in config; enforced BY CONSTRUCTION — this
                     proxy never deletes fields from a request body, so
                     reasoning_content / tool_calls in multi-turn and
                     tool-call sequences always survive a rewrite.

Everything else passes through, including SSE streams (streamed chunk by
chunk with flush — never buffered). Hot-reloads model_constraints.yaml when
its mtime changes (stat per request — no polling loop, no timers).

Audit: every rewrite appends one JSON line to
  /home/toxic/estate/var/data/model-guard-audit.jsonl
(override with MODEL_GUARD_AUDIT). Rotated at MODEL_GUARD_AUDIT_MAX_BYTES
(default 10MB) -> <path>.1.

Run under pitchfork as sovereign/model-guard (see pitchfork daemon entry).
Stdlib only. Fail-open: if the constraints file is unreadable, traffic
passes through untouched and the error is logged.
"""
import json
import os
import re
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = (
    __import__("os").environ.get("MODEL_GUARD_HOST", "127.0.0.1"),
    int(__import__("os").environ.get("MODEL_GUARD_PORT", "25101")),
)
UPSTREAM = os.environ.get("MODEL_GUARD_UPSTREAM", "http://127.0.0.1:25100")
CONSTRAINTS_PATH = os.environ.get(
    "MODEL_CONSTRAINTS",
    "/home/toxic/estate/config/model_constraints.yaml",
)
AUDIT_PATH = os.environ.get(
    "MODEL_GUARD_AUDIT",
    "/home/toxic/estate/var/data/model-guard-audit.jsonl",
)
AUDIT_MAX_BYTES = int(os.environ.get("MODEL_GUARD_AUDIT_MAX_BYTES", 10_000_000))

# ---------------------------------------------------------------- constraints

_constraints = {"mtime": 0.0, "entries": [], "config_bad": False}


def _strip_comment(raw):
    """Strip a trailing # comment, respecting single/double quotes so a #
    inside a quoted scalar (e.g. a match_regex) is not treated as a comment."""
    out = []
    quote = None
    i = 0
    while i < len(raw):
        c = raw[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < len(raw):
                out.append(raw[i + 1])
                i += 1
            elif c == quote:
                quote = None
        elif c in "\"'":
            quote = c
            out.append(c)
        elif c == "#":
            break
        else:
            out.append(c)
        i += 1
    return "".join(out).rstrip()


def _parse_simple_yaml(text):
    """Minimal YAML subset parser: only the shapes used in model_constraints.yaml.
    Returns dict. (stdlib-only; PyYAML may not be installed on the target.)"""
    # We only need: version, models: [ {id, match:[...], match_regex:[...],
    # force:{...}, clamp:{...}, forbid:{...}, strip_never:[...],
    # thinking_always_on, notes} ], parked_contracts: [...].
    # Parse with indentation-aware recursive descent.
    lines = []
    for raw in text.splitlines():
        line = _strip_comment(raw)
        if line.strip():
            lines.append(line)

    def indent_of(s):
        return len(s) - len(s.lstrip(" "))

    def scalar(v):
        v = v.strip()
        if v in ("true", "True"):
            return True
        if v in ("false", "False"):
            return False
        if v in ("null", "~", ""):
            return None
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            return v[1:-1]
        if len(v) >= 2 and v[0] == "[" and v[-1] == "]":
            # flow-style list: [a, b, "c"] (no nested structures)
            inner = v[1:-1].strip()
            if not inner:
                return []
            items, cur, quote = [], "", None
            for c in inner + ",":
                if quote:
                    cur += c
                    if c == quote:
                        quote = None
                elif c in "\"'":
                    quote, cur = c, cur + c
                elif c == ",":
                    items.append(scalar(cur))
                    cur = ""
                else:
                    cur += c
            return items
        if len(v) >= 2 and v[0] == "{" and v[-1] == "}":
            # flow-style map: {} or {k: v, ...} (flat, no nesting)
            inner = v[1:-1].strip()
            if not inner:
                return {}
            d, cur, quote = {}, "", None
            pairs = []
            for c in inner + ",":
                if quote:
                    cur += c
                    if c == quote:
                        quote = None
                elif c in "\"'":
                    quote, cur = c, cur + c
                elif c == ",":
                    pairs.append(cur)
                    cur = ""
                else:
                    cur += c
            for p in pairs:
                if ":" in p:
                    k, vv = p.split(":", 1)
                    d[scalar(k)] = scalar(vv)
            return d
        try:
            return int(v)
        except ValueError:
            pass
        try:
            return float(v)
        except ValueError:
            pass
        return v

    pos = [0]

    def parse_block(min_indent):
        # returns dict or list
        items = None  # dict or list decided by first line
        while pos[0] < len(lines):
            line = lines[pos[0]]
            ind = indent_of(line)
            if ind < min_indent:
                break
            stripped = line.strip()
            if stripped.startswith("- "):
                if items is None:
                    items = []
                if not isinstance(items, list):
                    raise ValueError("mixed list/map")
                pos[0] += 1
                rest = stripped[2:].strip()
                if not rest:
                    items.append(parse_block(ind + 1))
                elif ":" in rest and not rest.startswith(("[", "{")):
                    # "- key: value" -> dict entry start
                    k, v = rest.split(":", 1)
                    d = {}
                    if v.strip():
                        d[k.strip()] = scalar(v)
                    else:
                        d[k.strip()] = parse_block(ind + 1)
                    # consume following sibling keys at deeper indent
                    while pos[0] < len(lines):
                        nline = lines[pos[0]]
                        nind = indent_of(nline)
                        if nind <= ind or nline.strip().startswith("- "):
                            break
                        if ":" not in nline:
                            pos[0] += 1  # block-scalar (|) continuation line
                            continue
                        nk, nv = nline.strip().split(":", 1)
                        pos[0] += 1
                        if nv.strip():
                            d[nk.strip()] = scalar(nv)
                        else:
                            d[nk.strip()] = parse_block(nind + 1)
                    items.append(d)
                else:
                    items.append(scalar(rest))
            elif ":" in stripped:
                if items is None:
                    items = {}
                if not isinstance(items, dict):
                    raise ValueError("mixed map/list")
                k, v = stripped.split(":", 1)
                pos[0] += 1
                if v.strip():
                    items[k.strip()] = scalar(v)
                else:
                    # nested block or empty
                    if pos[0] < len(lines) and indent_of(lines[pos[0]]) > ind:
                        items[k.strip()] = parse_block(indent_of(lines[pos[0]]))
                    else:
                        items[k.strip()] = None
            else:
                pos[0] += 1  # continuation of a | block scalar etc; skip
        return items if items is not None else {}

    return parse_block(0)


def _validate_entry(m):
    """Validate one models: entry; return the normalized entry or None
    (with a stderr warning) if it is unusable. Never raises."""
    if not isinstance(m, dict):
        print("[model-guard] skipping non-dict models entry", file=sys.stderr, flush=True)
        return None
    match = m.get("match") or []
    if isinstance(match, str):
        match = [match]  # tolerate scalar
    try:
        match_set = {s.lower() for s in match if isinstance(s, str)}
    except Exception:
        match_set = set()
    regexes = []
    for p in (m.get("match_regex") or []):
        if not isinstance(p, str):
            print(f"[model-guard] skipping non-string match_regex in entry "
                  f"{m.get('id')!r}", file=sys.stderr, flush=True)
            continue
        try:
            regexes.append(re.compile(p, re.I))
        except re.error as e:
            print(f"[model-guard] bad match_regex {p!r} in entry {m.get('id')!r}: "
                  f"{e} — pattern skipped", file=sys.stderr, flush=True)
    if not match_set and not regexes:
        print(f"[model-guard] entry {m.get('id')!r} has no usable match — "
              f"skipped", file=sys.stderr, flush=True)
        return None
    clamp = m.get("clamp") or {}
    if isinstance(clamp, dict):
        for ck in list(clamp.keys()):
            spec = clamp[ck]
            if not isinstance(spec, dict):
                print(f"[model-guard] entry {m.get('id')!r}: clamp spec for "
                      f"{ck!r} is not a dict — dropped", file=sys.stderr, flush=True)
                del clamp[ck]
                continue
            allowed = spec.get("allowed")
            if isinstance(allowed, str):
                spec["allowed"] = [allowed]  # tolerate scalar
    def _as_dict(v):
        return v if isinstance(v, dict) else {}
    sn = m.get("strip_never") or []
    if isinstance(sn, str):
        sn = [sn]  # tolerate scalar
    return {
        "id": m.get("id"),
        "match": match_set,
        "match_regex": regexes,
        "force": _as_dict(m.get("force")),
        "clamp": _as_dict(m.get("clamp")),
        "forbid": _as_dict(m.get("forbid")),
        "strip_never": set(sn),
        "thinking_always_on": bool(m.get("thinking_always_on")),
    }


def load_constraints():
    st = _constraints
    try:
        mtime = os.path.getmtime(CONSTRAINTS_PATH)
    except OSError:
        return st["entries"]
    if mtime != st["mtime"]:
        try:
            with open(CONSTRAINTS_PATH) as f:
                doc = _parse_simple_yaml(f.read())
            entries = []
            for m in doc.get("models") or []:
                e = _validate_entry(m)
                if e is not None:
                    entries.append(e)
            st["entries"] = entries
            st["mtime"] = mtime
            if st["config_bad"]:
                st["config_bad"] = False
                print("[model-guard] constraints recovered from fallback",
                      file=sys.stderr, flush=True)
        except Exception as e:
            st["entries"] = []
            st["config_bad"] = True
            print("[model-guard] FALLBACK: constraints malformed; serving SAFE DEFAULTS",
                  file=sys.stderr, flush=True)
    return st["entries"]


def find_entry(model_id):
    if not model_id:
        return None
    mid = str(model_id).lower()
    for e in load_constraints():
        if mid in e["match"]:
            return e
        if any(rx.search(mid) for rx in e["match_regex"]):
            return e
    return None


# ------------------------------------------------------------------ rewriting

def _get_path(body, dotted):
    cur = body
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None, False
        cur = cur[part]
    return cur, True


def _set_path(body, dotted, value):
    """Set a (possibly dotted) path, creating intermediate dicts. Total:
    never raises — a non-dict in the way is replaced, and if the root is
    somehow not a dict the write is skipped (fail-open upstream)."""
    if not isinstance(body, dict):
        return
    cur = body
    parts = dotted.split(".")
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value


def enforce(body):
    """Apply card constraints to a decoded chat-completions request body.
    Returns (new_body, violations[list of str]). Never raises on bad input.
    Fields are only ever ADDED or OVERWRITTEN, never deleted — strip_never
    holds by construction (multi-turn reasoning_content / tool_calls state
    always survives a rewrite)."""
    violations = []
    try:
        entry = find_entry(body.get("model") if isinstance(body, dict) else None)
    except Exception:
        return body, violations
    if entry is None:
        return body, violations

    # force: unconditional card mandates
    for k, v in entry["force"].items():
        cur, found = _get_path(body, k)
        if not found or cur != v:
            violations.append(f"force {k}={v} (was {cur!r})")
            _set_path(body, k, v)

    # clamp: allowed-set params
    for k, spec in entry["clamp"].items():
        allowed = spec.get("allowed") or []
        default = spec.get("default")
        cur, found = _get_path(body, k)
        if not found or cur not in allowed:
            violations.append(f"clamp {k}={default!r} (was {cur!r})")
            _set_path(body, k, default)

    # thinking always on: flip any disable flag back on
    if entry["thinking_always_on"]:
        for flag in ("enable_thinking", "reasoning.enabled"):
            cur, found = _get_path(body, flag)
            if found and cur is False:
                violations.append(f"thinking_always_on: {flag} False->True")
                _set_path(body, flag, True)
        cur, found = _get_path(body, "reasoning_effort")
        if found and cur in (None, "none", "disabled", "off"):
            violations.append(f"thinking_always_on: reasoning_effort {cur!r}->'low'")
            _set_path(body, "reasoning_effort", "low")

    # forbid: reject outright
    for k, bad in entry["forbid"].items():
        if not isinstance(bad, (list, tuple, set)):
            continue
        cur, found = _get_path(body, k)
        if found and cur in bad:
            raise ValueError(f"forbidden param {k}={cur!r} for model {body.get('model')}")

    return body, violations


def audit(model, violations):
    try:
        d = os.path.dirname(AUDIT_PATH)
        if d:
            os.makedirs(d, exist_ok=True)
        try:
            if os.path.getsize(AUDIT_PATH) >= AUDIT_MAX_BYTES:
                os.replace(AUDIT_PATH, AUDIT_PATH + ".1")
        except FileNotFoundError:
            pass
        with open(AUDIT_PATH, "a") as f:
            f.write(json.dumps({"ts": time.time(), "model": model, "violations": violations}) + "\n")
    except OSError as e:
        print(f"[model-guard] audit write failed: {e}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------- proxy

HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}
# On the request side Content-Length must be stripped: urllib recomputes it
# from the (possibly rewritten) body, and a stale forwarded value would
# corrupt the upstream request. On the response side the body is always
# byte-identical to upstream's, so its Content-Length is forwarded verbatim.
REQ_STRIP_HEADERS = HOP_HEADERS | {"content-length", "host"}


def _read_request_body(handler):
    """Read the request body, de-chunking manually when the client sent
    Transfer-Encoding: chunked (BaseHTTPRequestHandler does not)."""
    if "chunked" in handler.headers.get("Transfer-Encoding", "").lower():
        body = bytearray()
        while True:
            line = handler.rfile.readline().strip()
            if not line:
                break
            n = int(line.split(b";")[0], 16)
            if n == 0:
                # end of chunks: consume optional trailers up to and
                # including the terminating blank line
                while True:
                    tline = handler.rfile.readline()
                    if not tline.strip():
                        break
                break
            body += handler.rfile.read(n)
            handler.rfile.readline()  # CRLF after chunk
        return bytes(body)
    length = int(handler.headers.get("Content-Length") or 0)
    return handler.rfile.read(length) if length else b""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ModelGuard/1.0"

    def _proxy(self):
        try:
            raw = _read_request_body(self)
            ctype = self.headers.get("Content-Type", "")

            if (
                self.command == "POST"
                and self.path.rstrip("/").endswith("/chat/completions")
                and "json" in ctype
                and raw
            ):
                try:
                    body = json.loads(raw)
                    new_body, violations = enforce(body)
                    if violations:
                        audit(body.get("model") if isinstance(body, dict) else None,
                              violations)
                        raw = json.dumps(new_body, separators=(",", ":")).encode()
                except ValueError as e:
                    # forbid-rejection, or malformed JSON (JSONDecodeError is a
                    # ValueError) -> 400 either way
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    msg = json.dumps({"error": str(e)}).encode()
                    self.send_header("Content-Length", str(len(msg)))
                    self.end_headers()
                    self.wfile.write(msg)
                    return
                except Exception as e:
                    print(f"[model-guard] enforce error (fail-open): {e}", file=sys.stderr, flush=True)

            req = urllib.request.Request(
                UPSTREAM + self.path, data=raw if self.command in ("POST", "PUT", "PATCH") else None,
                method=self.command,
            )
            for k, v in self.headers.items():
                if k.lower() not in REQ_STRIP_HEADERS:
                    req.add_header(k, v)
            try:
                resp = urllib.request.urlopen(req, timeout=600)
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-Model-Guard-Fallback", "upstream-unreachable")
                msg = json.dumps({
                    "error": "model-guard fallback: upstream unreachable",
                    "fallback": "upstream-unreachable",
                }).encode()
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return

            rctype = resp.headers.get("Content-Type", "")
            no_length = resp.headers.get("Content-Length") is None
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k.lower() not in HOP_HEADERS:
                    self.send_header(k, v)
            if no_length:
                # De-chunked body with no declared length: the client cannot
                # delimit it on a keep-alive connection, so close after the body.
                self.send_header("Connection", "close")
            self.end_headers()

            # Streaming (SSE / chunked-no-length) must NOT use read(N): it fills
            # N bytes across chunks and would buffer the whole stream. read(1)
            # returns as soon as 1 byte is available. wfile must be flushed or
            # the client sees nothing until the buffer fills / close.
            streaming = ("text/event-stream" in rctype) or (
                no_length and "chunked" in resp.headers.get("Transfer-Encoding", "").lower()
            )
            try:
                if streaming:
                    while True:
                        b = resp.read(1)
                        if not b:
                            break
                        self.wfile.write(b)
                        self.wfile.flush()
                else:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                try:
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            if no_length:
                self.close_connection = True

        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected, dont crash the thread
    do_GET = _proxy
    do_POST = _proxy
    do_PUT = _proxy
    do_DELETE = _proxy
    do_PATCH = _proxy

    def log_message(self, *a):
        pass  # audit log carries the signal; keep stdout clean


def selftest():
    """Unit-test the rewrite engine against the K3 card contract."""
    global CONSTRAINTS_PATH
    if len(sys.argv) > 2:
        CONSTRAINTS_PATH = sys.argv[2]
    _constraints["mtime"] = 0.0
    cases = [
        ({"model": "moonshotai/kimi-k3", "messages": []},
         {"top_p": 0.95, "reasoning_effort": "low"}),
        ({"model": "kimi-k3", "messages": [], "top_p": 0.2, "reasoning_effort": "medium"},
         {"top_p": 0.95, "reasoning_effort": "low"}),
        ({"model": "moonshotai/Kimi-K3", "messages": [], "reasoning_effort": "max",
          "enable_thinking": False, "messages2": 1},
         {"top_p": 0.95, "reasoning_effort": "max", "enable_thinking": True}),
        # thinking disable via reasoning.enabled is flipped, never passed through
        ({"model": "kimi-k3", "messages": [], "reasoning": {"enabled": False}},
         {"reasoning": {"enabled": True, "effort": "low"}}),
        # unconstrained model passes through untouched
        ({"model": "openai", "messages": [], "top_p": 0.2}, {"top_p": 0.2}),
        # strip_never: reasoning_content/tool_calls survive
        ({"model": "kimi-k3", "messages": [{"role": "assistant", "reasoning_content": "r",
           "tool_calls": [{"id": "1"}]}]}, {"top_p": 0.95}),
        # non-dict in a dotted path's way: total _set_path, no raise,
        # contract still applied
        ({"model": "kimi-k3", "messages": [], "reasoning": ["x"]},
         {"reasoning": {"effort": "low"}, "top_p": 0.95}),
    ]
    fails = 0
    for i, (inp, expect) in enumerate(cases):
        before_keys = set(json.loads(json.dumps(inp)).keys())
        out, viols = enforce(json.loads(json.dumps(inp)))
        for k, v in expect.items():
            got, _ = _get_path(out, k)
            if got != v:
                print(f"FAIL case {i}: {k} -> {got!r}, expected {v!r} (violations={viols})")
                fails += 1
        # strip_never regression: a rewrite must never drop top-level keys
        if i == 5:
            msgs = out.get("messages", [])
            if not (msgs and msgs[0].get("reasoning_content") == "r" and msgs[0].get("tool_calls")):
                print(f"FAIL case 5: strip_never violated: {msgs!r}")
                fails += 1
        # strip_never regression: a rewrite must never DROP keys (it legitimately
        # ADDS contract keys like top_p / reasoning_effort)
        if not before_keys <= set(out.keys()):
            print(f"FAIL case {i}: keys dropped by rewrite: {before_keys - set(out.keys())}")
            fails += 1
    print("model-guard selftest: " + ("ALL PASS" if not fails else f"{fails} FAILURES"))
    return fails


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(1 if selftest() else 0)
    load_constraints()
    if _constraints.get("config_bad"):
        print("[model-guard] STARTUP IN FALLBACK: serving safe defaults", flush=True)
    else:
        print("[model-guard] constraints OK", flush=True)
    try:
        srv = ThreadingHTTPServer(LISTEN, Handler)
    except OSError as e:
        import errno as _errno
        if e.errno == _errno.EADDRINUSE:
            msg = ("[model-guard] FATAL: %s:%d already in use - another model-guard "
                   "holds it. Set MODEL_GUARD_PORT to run a second instance."
                   % (LISTEN[0], LISTEN[1]))
            print(msg, flush=True)
            sys.exit(98)
        raise
    print(f"[model-guard] listening on {LISTEN[0]}:{LISTEN[1]} -> {UPSTREAM} "
          f"(constraints: {CONSTRAINTS_PATH})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

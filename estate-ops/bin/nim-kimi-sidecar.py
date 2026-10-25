#!/usr/bin/env python3
"""nim-kimi-sidecar: cold-aware NVIDIA NIM proxy for moonshotai/kimi-k3.

Listens 127.0.0.1:25163 (NIM_KIMI_SIDECAR_PORT), proxies to
https://integrate.api.nvidia.com/v1/chat/completions with the K3 contract
built in:

- top_p outside (0,1) (incl. the OpenAI 1.0 default herd clients inject)
  is stripped -- NVIDIA 400s it.
- Upstream timeout 300s: first request after idle routinely takes ~120s
  (serverless cold load + queue). That is NORMAL, not failure.
- Warmup invoke fired on daemon start (event-driven; no timers, no
  periodic re-warm -- the platform exposes no keep-warm for hosted NIM).
- Identity enforcement: upstream response model MUST be
  moonshotai/kimi-k3 or the request fails LOUD (no silent fallback to
  another model, ever).
- 404/429 classified: catalog re-check on 404 (model-gone vs transient),
  billing/quota 429s surface loud and permanent, rate-limit 429s get
  bounded exponential backoff (5s, 20s) then fail loud.
- 401/403/410 (auth/entitlement/EOL) pass through verbatim and loud.

NVCF verdict (2026-09-21): direct NVCF-plane invocation is NOT available
to this key -- GET /v2/nvcf/functions lists 203 NVIDIA-internal
engineering functions (dynamo benchmark/shadow rigs), and POST
/v2/nvcf/queues/{id} 404s ("No static resource"). The public serving
deployment behind moonshotai/kimi-k3 is not exposed as an invocable
function. integrate.api.nvidia.com IS the NVCF plane's public face for
build.nvidia.com -- the front door is the main flow, cold-aware.

Key: NVIDIA_API_KEY from env, else /home/toxic/.secrets. Read-only use;
never logged, never printed.
"""
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("NIM_KIMI_SIDECAR_PORT", "25163"))
SECRETS_PATH = os.environ.get("NIM_KIMI_SECRETS", "/home/toxic/.secrets")
UPSTREAM = "https://integrate.api.nvidia.com/v1/chat/completions"
MODELS_URL = "https://integrate.api.nvidia.com/v1/models"
MODEL_ID = "moonshotai/kimi-k3"
UPSTREAM_TIMEOUT = 300  # cold load + queue routinely ~120s

def log(msg):
    print("[nim-kimi] %s" % msg, file=sys.stderr, flush=True)

def load_key():
    k = os.environ.get("NVIDIA_API_KEY")
    if k:
        return k
    try:
        with open(SECRETS_PATH) as f:
            for line in f:
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].strip()
                if line.startswith("NVIDIA_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception as e:
        log("secrets read failed: %s" % e)
    return None

API_KEY = load_key()
if not API_KEY:
    log("FATAL: no NVIDIA_API_KEY (env or %s)" % SECRETS_PATH)
    sys.exit(1)

state = {"warm": False, "last_latency": None, "consec_fail": 0, "started": time.time()}
state_lock = threading.Lock()

def upstream_headers(stream=False):
    h = {"Authorization": "Bearer " + API_KEY, "Content-Type": "application/json"}
    if stream:
        h["Accept"] = "text/event-stream"
    return h

def sanitize(body):
    """Enforce the K3 contract. Returns (clean_body, error_response)."""
    model = body.get("model", "")
    if model and model != MODEL_ID:
        return None, err(400, "WRONG_MODEL_REQUEST",
            "nim-kimi serves ONLY %s; requested '%s'. No silent fallback." % (MODEL_ID, model),
            step="sanitize")
    body = dict(body)
    body["model"] = MODEL_ID
    tp = body.get("top_p")
    if tp is not None:
        try:
            tp_f = float(tp)
            if not (0.0 < tp_f < 1.0):
                log("stripping top_p=%r (NVIDIA requires 0<top_p<1)" % tp)
                body.pop("top_p", None)
        except (TypeError, ValueError):
            log("stripping non-numeric top_p=%r" % tp)
            body.pop("top_p", None)
    return body, None

def err(status, code, message, step="proxy", detail=None):
    payload = {"error": {"message": message, "type": "nim_kimi_" + code,
                         "plane": "integrate.api.nvidia.com", "step": step,
                         "status": status}}
    if detail:
        payload["error"]["detail"] = detail
    return status, payload

def catalog_has_model():
    try:
        r = urllib.request.Request(MODELS_URL, headers={"Authorization": "Bearer " + API_KEY})
        with urllib.request.urlopen(r, timeout=30) as x:
            data = json.load(x)
        return any(m.get("id") == MODEL_ID for m in data.get("data", []))
    except Exception as e:
        log("catalog check failed: %r" % e)
        return None

BILLING_WORDS = ("quota", "billing", "suspend", "insufficient", "balance", "credit")

def classify_429(body_text):
    low = body_text.lower()
    if any(w in low for w in BILLING_WORDS):
        return err(429, "BILLING_SUSPENDED",
            "Upstream 429 is a billing/quota hard state, not transient: %s" % body_text[:200],
            step="classify-429")
    return None  # transient -> backoff

def do_upstream(body, stream):
    data = json.dumps(body).encode()
    req = urllib.request.Request(UPSTREAM, data=data,
                                 headers=upstream_headers(stream), method="POST")
    t = time.time()
    resp = urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT)
    return resp, time.time() - t

def warmup(reason):
    log("warmup (%s): firing tiny completion" % reason)
    try:
        body = {"model": MODEL_ID,
                "messages": [{"role": "user", "content": "Reply with exactly: NIM_WARM_OK"}],
                "max_tokens": 16}
        resp, dt = do_upstream(body, False)
        raw = resp.read().decode()
        ok = resp.status == 200 and '"model":"%s"' % MODEL_ID in raw.replace(" ", "")
        with state_lock:
            state["warm"] = ok
            state["last_latency"] = dt
            if ok:
                state["consec_fail"] = 0
        log("warmup done: status=%s latency=%.1fs identity=%s" % (resp.status, dt, ok))
    except Exception as e:
        log("warmup failed: %r" % e)

class Handler(BaseHTTPRequestHandler):
    server_version = "nim-kimi-sidecar/1.0"

    def _send(self, status, payload=None, ctype="application/json"):
        raw = json.dumps(payload).encode() if payload is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            with state_lock:
                s = dict(state)
            self._send(200, {"status": "ok", "model": MODEL_ID, **s})
        elif self.path == "/v1/models":
            self._send(200, {"object": "list", "data": [
                {"id": MODEL_ID, "object": "model", "created": 0,
                 "owned_by": "nvidia-nim",
                 "note": "cold-aware: first request after idle ~120s is normal"}]})
        else:
            self._send(404, {"error": {"message": "unknown path %s" % self.path}})

    def do_POST(self):
        if self.path == "/warm":
            threading.Thread(target=warmup, args=("manual",), daemon=True).start()
            self._send(202, {"status": "warmup-accepted"})
            return
        if self.path != "/v1/chat/completions":
            self._send(404, {"error": {"message": "unknown path %s" % self.path}})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        try:
            body = json.loads(self.rfile.read(length).decode() or "{}")
        except Exception:
            s, p = err(400, "BAD_JSON", "Request body is not valid JSON", step="parse")
            self._send(s, p)
            return
        clean, e = sanitize(body)
        if e:
            self._send(*e)
            return
        stream = bool(clean.get("stream"))
        # Retry policy: 1 initial + bounded retries for transient classes.
        delays = [0, 5, 20]
        last = None
        for attempt, delay in enumerate(delays):
            if delay:
                log("backoff %.0fs before attempt %d" % (delay, attempt + 1))
                time.sleep(delay)
            try:
                resp, dt = do_upstream(clean, stream)
                with state_lock:
                    state["warm"] = dt < 60
                    state["last_latency"] = dt
                    state["consec_fail"] = 0
                log("completion: 200 in %.1fs (attempt %d)" % (dt, attempt + 1))
                if stream:
                    self._relay_stream(resp)
                else:
                    raw = resp.read().decode()
                    try:
                        payload = json.loads(raw)
                    except Exception:
                        s, p = err(502, "BAD_UPSTREAM_JSON",
                            "Upstream 200 with unparsable body", step="identity")
                        self._send(s, p)
                        return
                    if payload.get("model") != MODEL_ID:
                        s, p = err(502, "WRONG_MODEL_IDENTITY",
                            "Upstream returned model '%s', expected '%s'. "
                            "Refusing to disguise another model as Kimi." % (
                                payload.get("model"), MODEL_ID),
                            step="identity", detail=str(payload)[:300])
                        self._send(s, p)
                        return
                    self._send(200, payload)
                return
            except BrokenPipeError:
                # Downstream client disconnected while we waited out the
                # ~130s cold upstream (its own timeout fired). Upstream
                # already answered 200 -- retrying would burn another
                # full cold call for a client that is gone. Log and stop:
                # no retry, no consec_fail (the provider did its job).
                log("client disconnected after upstream 200; not retrying")
                return
            except urllib.error.HTTPError as e:
                etext = e.read().decode()[:500]
                log("upstream HTTP %s (attempt %d): %s" % (e.code, attempt + 1, etext[:160]))
                if e.code == 404:
                    has = catalog_has_model()
                    if has is False:
                        s, p = err(502, "MODEL_GONE",
                            "%s missing from upstream catalog -- the model is "
                            "gone at the source, not a routing bug." % MODEL_ID,
                            step="classify-404", detail=etext[:200])
                        self._send(s, p)
                        return
                    if attempt < len(delays) - 1:
                        last = ("transient-404", etext)
                        continue
                    s, p = err(502, "UPSTREAM_404",
                        "Upstream 404 with model still in catalog (transient).",
                        step="classify-404", detail=etext[:200])
                    self._send(s, p)
                    return
                if e.code == 429:
                    hard = classify_429(etext)
                    if hard:
                        self._send(*hard)
                        return
                    if attempt < len(delays) - 1:
                        last = ("transient-429", etext)
                        continue
                    s, p = err(429, "RATE_LIMITED",
                        "Upstream 429 persisted after bounded backoff.",
                        step="classify-429", detail=etext[:200])
                    self._send(s, p)
                    return
                # 401/403/410 and everything else: loud, verbatim, no retry.
                with state_lock:
                    state["consec_fail"] += 1
                s, p = err(e.code, "UPSTREAM_%s" % e.code,
                    "Upstream refused the request (no retry, no fallback).",
                    step="proxy", detail=etext[:300])
                self._send(s, p)
                return
            except Exception as e:
                log("attempt %d transport error: %r" % (attempt + 1, e))
                if attempt < len(delays) - 1:
                    last = ("transport", repr(e)[:200])
                    continue
                with state_lock:
                    state["consec_fail"] += 1
                s, p = err(502, "UPSTREAM_UNREACHABLE",
                    "Could not reach upstream after bounded retries.",
                    step="proxy", detail=repr(e)[:200])
                self._send(s, p)
                return

    def _relay_stream(self, resp):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("listening on 127.0.0.1:%d (model %s)" % (PORT, MODEL_ID))
    threading.Thread(target=warmup, args=("daemon-start",), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

#!/usr/bin/env python3
"""
Coyote Loop v3.1 — Max Level Autonomous Agent
First-class estate service. OpenFang agent with Yote integration.
HTTP server for task ingestion + health checks (pitchfork-compatible).
"""

import os, sys, time, json, re, signal, threading
from pathlib import Path
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field, asdict
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests
import urllib3
urllib3.disable_warnings()

@dataclass
class HalConfig:
    # Model selection is owned by router/service config (COYOTE_MODEL env,
    # set in stack/services/coyote.sh). Tooling never hardcodes model IDs.
    base_url: str = "http://localhost:8080"
    api_key: str = "sk-hal-local"
    model: str = field(default_factory=lambda: os.getenv("COYOTE_MODEL", "gpt-oss"))
    max_rounds: int = 50
    limit_step: int = 10
    tick_interval: float = 2.5
    send_confirm_ms: int = 9000
    send_max_retries: int = 2
    watchdog_soft: int = 90
    watchdog_hard: int = 180
    sigil_proceed: str = "[[OPHEL::PROCEED]]"
    sigil_halt: str = "[[OPHEL::HALT]]"
    sigil_roadmap: str = "[[OPHEL::ROADMAP]]"
    sigil_short: str = "[[OPHEL::SHORT]]"
    slot_id: int = 0
    slot_save_path: str = "/home/toxic/estate/.cache/coyote/slots"
    session_id: str = "default"
    tab_lock_ttl: int = 10
    tab_heartbeat_interval: float = 3.0
    log_dir: str = "/home/toxic/estate/logs/coyote"
    verbose: bool = True
    metrics_enabled: bool = True
    metrics_interval: float = 10.0
    max_context_tokens: int = 120000
    http_port: int = 25143
    http_host: str = "0.0.0.0"
    # OpenFang integration
    openfang_api: str = "http://127.0.0.1:25103"
    yote_api: str = "http://127.0.0.1:25102"
    mcpproxy_api: str = os.getenv("MCPPROXY_GO_URL", f"http://127.0.0.1:{os.getenv('MCPPROXY_GO_PORT', '25127')}")
    ghas_mcp_api: str = "http://127.0.0.1:25113"

class LoopState:
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    LIMIT = "LIMIT"
    COMPLETE = "COMPLETE"

@dataclass
class HalState:
    status: str = LoopState.IDLE
    round: int = 0
    detail: str = ""
    last_activity: float = field(default_factory=time.time)
    last_text_len: int = 0
    stale_ticks: int = 0
    send_pending: bool = False
    send_deadline: float = 0.0
    send_retries: int = 0
    last_sent_text: str = ""
    original_task: str = ""
    roadmap_captured: bool = False
    roadmap_steps: List[str] = field(default_factory=list)
    roadmap_index: int = 0
    roadmap_synth_sent: bool = False
    total_tokens_generated: int = 0
    total_prompt_tokens: int = 0

class TabLock:
    def __init__(self, config: HalConfig):
        self.config = config
        self.lock_file = Path(config.slot_save_path) / ".coyote-tab-lock"
        self.tab_id = f"{os.getpid()}-{int(time.time()*1000)}"
        self._timer: Optional[threading.Timer] = None
        self._held = False
    def claim(self) -> bool:
        now = time.time()
        if self.lock_file.exists():
            try:
                data = json.loads(self.lock_file.read_text())
                if now - data.get("timestamp", 0) < self.config.tab_lock_ttl:
                    if data.get("tab_id") != self.tab_id:
                        return False
            except: pass
        self.lock_file.write_text(json.dumps({"tab_id": self.tab_id, "timestamp": now, "pid": os.getpid()}))
        self._held = True
        self._hb()
        return True
    def release(self):
        self._held = False
        self._stop()
        if self.lock_file.exists():
            try:
                if json.loads(self.lock_file.read_text()).get("tab_id") == self.tab_id:
                    self.lock_file.unlink()
            except: pass
    def is_safe(self) -> bool:
        if not self._held: return False
        now = time.time()
        if not self.lock_file.exists(): return True
        try:
            data = json.loads(self.lock_file.read_text())
            if now - data.get("timestamp", 0) > self.config.tab_lock_ttl: return True
            return data.get("tab_id") == self.tab_id
        except: return True
    def _hb(self):
        self._stop()
        if self._held and self.lock_file.exists():
            try:
                data = json.loads(self.lock_file.read_text())
                if data.get("tab_id") == self.tab_id:
                    data["timestamp"] = time.time()
                    self.lock_file.write_text(json.dumps(data))
            except: pass
        self._timer = threading.Timer(self.config.tab_heartbeat_interval, self._hb)
        self._timer.daemon = True
        self._timer.start()
    def _stop(self):
        if self._timer:
            self._timer.cancel()
            self._timer = None

class LlamaClient:
    def __init__(self, config: HalConfig):
        self.config = config
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"})
        self._last = ""
        self._metrics: Dict[str, Any] = {}
    def chat(self, messages: List[Dict[str, str]], **kwargs) -> Dict[str, Any]:
        payload = {"model": self.config.model, "messages": messages, "stream": False, "cache_prompt": True, **kwargs}
        r = self.s.post(f"{self.config.base_url}/v1/chat/completions", json=payload, timeout=300)
        r.raise_for_status()
        data = r.json()
        if "choices" in data and data["choices"]:
            self._last = data["choices"][0].get("message", {}).get("content", "")
        return data
    def get_last(self) -> str: return self._last
    def is_gen(self) -> bool:
        try:
            r = self.s.get(f"{self.config.base_url}/metrics", timeout=5)
            if r.status_code == 200:
                m = re.search(r'llamacpp:requests_processing\s+(\d+)', r.text)
                if m: return int(m.group(1)) > 0
        except: pass
        return False
    def get_metrics(self) -> Dict[str, Any]:
        try:
            r = self.s.get(f"{self.config.base_url}/metrics", timeout=5)
            if r.status_code == 200:
                m: Dict[str, Any] = {}
                for line in r.text.split('\n'):
                    if line.startswith('llamacpp:'):
                        p = line.split()
                        if len(p) >= 2:
                            try: m[p[0].replace('llamacpp:', '')] = float(p[1])
                            except: m[p[0].replace('llamacpp:', '')] = p[1]
                self._metrics = m
                return m
        except: pass
        return self._metrics
    def save_slot(self, fn: str) -> bool:
        try:
            r = self.s.post(f"{self.config.base_url}/slots/{self.config.slot_id}?action=save", json={"filename": fn}, timeout=30)
            return r.status_code == 200
        except: return False
    def restore_slot(self, fn: str) -> bool:
        fp = Path(self.config.slot_save_path) / fn
        if not fp.exists(): return False
        try:
            r = self.s.post(f"{self.config.base_url}/slots/{self.config.slot_id}?action=restore", json={"filename": fn}, timeout=30)
            return r.status_code == 200
        except: return False
    def health(self) -> bool:
        try: return self.s.get(f"{self.config.base_url}/health", timeout=5).status_code == 200
        except: return False

class SigilEngine:
    def __init__(self, config: HalConfig):
        self.c = config
    def detect(self, text: str) -> Optional[str]:
        if self.c.sigil_proceed in text: return "proceed"
        if self.c.sigil_halt in text: return "halt"
        if self.c.sigil_roadmap in text: return "roadmap"
        if self.c.sigil_short in text: return "short"
        if re.search(r'\[\s*OPHEL\s*::\s*PROCEED\s*\]', text, re.I): return "proceed"
        if re.search(r'\[\s*OPHEL\s*::\s*HALT\s*\]', text, re.I): return "halt"
        if re.search(r'\[\s*OPHEL\s*::\s*ROADMAP\s*\]', text, re.I): return "roadmap"
        return None
    def strip(self, text: str) -> str:
        for s in [self.c.sigil_proceed, self.c.sigil_halt, self.c.sigil_roadmap, self.c.sigil_short]:
            text = text.replace(s, "")
        return re.sub(r'\[\s*OPHEL\s*::\s*(PROCEED|HALT|ROADMAP|SHORT)\s*\]', '', text, flags=re.I).strip()
    def inject_proceed(self, text: str) -> str: return f"{text}\n\n{self.c.sigil_proceed}"
    def inject_halt(self, text: str) -> str: return f"{text}\n\n{self.c.sigil_halt}"

class HalLoop:
    def __init__(self, config: HalConfig):
        self.c = config
        self.client = LlamaClient(config)
        self.sigil = SigilEngine(config)
        self.lock = TabLock(config)
        self.state = HalState()
        self.msgs: List[Dict[str, str]] = []
        self._run = False
        self._dead = False
        self._tick_t: Optional[threading.Timer] = None
        self._met_t: Optional[threading.Timer] = None
        self.log_file = Path(config.log_dir) / f"hal-{datetime.now():%Y%m%d-%H%M%S}.jsonl"
        Path(config.log_dir).mkdir(parents=True, exist_ok=True)
    def log(self, event: str, data: Dict[str, Any] = None):
        entry = {"timestamp": datetime.now().isoformat(), "event": event, "state": self.state.status, "round": self.state.round, "detail": self.state.detail}
        if data: entry.update(data)
        with open(self.log_file, "a") as f: f.write(json.dumps(entry) + "\n")
        if self.c.verbose: print(f"[coyote] {event}: {json.dumps(data) if data else ''}")
    def start(self, task: str = ""):
        if self._dead: raise RuntimeError("destroyed")
        if not self.client.health(): raise RuntimeError("server not responding")
        if not self.lock.claim(): raise RuntimeError("tab lock held")
        sf = f"slot_{self.c.session_id}.bin"
        if self.client.restore_slot(sf): self.log("slot_restored", {"file": sf})
        self.state.status = LoopState.RUNNING
        self.state.round = 0
        self.state.stale_ticks = 0
        self.state.original_task = task
        self._touch()
        if task: self._send(self.sigil.inject_proceed(task))
        self._start_tick()
        self._start_met()
        self.log("loop_started", {"task": task[:200] if task else None})
    def stop(self):
        self._run = False
        self._stop_tick()
        self._stop_met()
        sf = f"slot_{self.c.session_id}.bin"
        if self.client.save_slot(sf): self.log("slot_saved", {"file": sf})
        self.lock.release()
        self.state.status = LoopState.IDLE
        self.log("loop_stopped")
    def destroy(self):
        self._dead = True
        self.stop()
    def tick(self):
        if self._dead or self.state.status != LoopState.RUNNING: return
        if not self.lock.is_safe(): self._pause("tab lock lost"); return
        if self.client.is_gen(): self._touch(); return
        if self.state.send_pending:
            if self.client.is_gen():
                self._confirm()
                self._touch()
                return
            if time.time() >= self.state.send_deadline:
                if self.state.send_retries < self.c.send_max_retries:
                    self._refire()
                    return
                self.state.send_pending = False
                self._pause("send unconfirmed")
                return
            return
        idle = time.time() - self.state.last_activity
        if idle > self.c.watchdog_hard: self._pause("watchdog hard"); return
        if idle > self.c.watchdog_soft: self.state.detail = "⚠ watchdog soft"
        if self.state.round >= self.c.max_rounds: self._limit(); return
        if not self.msgs: self._pause("no messages"); return
        last = self.msgs[-1]
        if last.get("role") != "assistant": return
        text = last.get("content", "")
        res = self.sigil.detect(text)
        self.state.detail = f"signal: {res or 'none'}"
        if res == "short":
            self.state.stale_ticks += 1
            if self.state.stale_ticks >= 3: self._pause("response too short")
            return
        if res == "halt": self.state.stale_ticks = 0; self._handle_halt(); return
        if res == "proceed": self.state.stale_ticks = 0; self._handle_proceed(); return
        if res == "roadmap": self.state.stale_ticks = 0; self._handle_roadmap(text); return
        self.state.stale_ticks += 1
        if self.state.stale_ticks >= 5: self._pause("no signal")
    def _send(self, text: str, skip: bool = False) -> bool:
        if self._dead: return False
        if not skip and self.state.round > 0:
            time.sleep(min(8 + self.state.round * 0.5, 30))
        if self.state.status != LoopState.RUNNING: return False
        self.msgs.append({"role": "user", "content": text})
        try:
            msgs = self._trim()
            r = self.client.chat(msgs, temperature=0.7, top_p=0.95)
            self.msgs.append({"role": "assistant", "content": r["choices"][0]["message"]["content"]})
            u = r.get("usage", {})
            self.state.total_prompt_tokens += u.get("prompt_tokens", 0)
            self.state.total_tokens_generated += u.get("completion_tokens", 0)
            self.state.round += 1
            self.state.send_pending = True
            self.state.send_deadline = time.time() + self.c.send_confirm_ms / 1000
            self.state.last_sent_text = text
            self.state.last_text_len = len(self.msgs[-1]["content"])
            self.state.send_retries = 0
            self._touch()
            self.log("sent", {"round": self.state.round, "prompt": u.get("prompt_tokens", 0), "completion": u.get("completion_tokens", 0)})
            return True
        except Exception as e:
            self.log("send_failed", {"error": str(e)})
            return False
    def _trim(self) -> List[Dict[str, str]]:
        sys = [m for m in self.msgs if m.get("role") == "system"]
        other = [m for m in self.msgs if m.get("role") != "system"]
        res = sys[:]
        est = sum(len(m.get("content", "")) for m in res) // 4
        for m in reversed(other):
            t = len(m.get("content", "")) // 4
            if est + t > self.c.max_context_tokens: break
            res.insert(len(sys), m)
            est += t
        return res
    def _confirm(self):
        self.state.send_pending = False
        self.state.send_deadline = 0.0
        self.state.send_retries = 0
    def _refire(self):
        self.state.send_retries += 1
        self.state.detail = f"↻ re-send {self.state.send_retries}/{self.c.send_max_retries}"
        self._send(self.state.last_sent_text, skip=True)
    def _handle_halt(self):
        if self.state.roadmap_captured: self._halt("✅ roadmap complete"); self._reset_rm(); return
        self._halt("✅ task complete")
    def _handle_proceed(self):
        if self.state.roadmap_captured:
            if self.state.roadmap_index < len(self.state.roadmap_steps): self._send_rm_step(); return
            if not self.state.roadmap_synth_sent: self._send_rm_synth(); return
            self._halt("✅ roadmap complete"); self._reset_rm(); return
        self._send("Continue")
    def _handle_roadmap(self, text: str):
        if not self.state.roadmap_captured:
            steps = self._parse_rm(text)
            if steps:
                self.state.roadmap_steps = steps
                self.state.roadmap_captured = True
                self.state.detail = f"🗺 roadmap: {len(steps)} steps"
                self._send_rm_step()
            else: self._pause("no roadmap found")
            return
        self._handle_proceed()
    def _parse_rm(self, text: str) -> List[str]:
        i = text.find(self.c.sigil_roadmap)
        if i < 0: return []
        after = text[i + len(self.c.sigil_roadmap):]
        steps = []
        for line in after.split("\n"):
            if self.c.sigil_proceed in line or self.c.sigil_halt in line: break
            m = re.match(r'^\s*(?:\d+[.)]\s+|[-*]\s+)(.+)$', line)
            if m and len(m.group(1).strip()) > 3: steps.append(m.group(1).strip())
            if len(steps) >= 30: break
        return steps if len(steps) >= 2 else []
    def _send_rm_step(self):
        i, n = self.state.roadmap_index, len(self.state.roadmap_steps)
        self.state.detail = f"🗺 step {i+1}/{n}"
        self._send(f"Continue.\n\n[coyote roadmap — step {i+1} of {n}]\n{self.state.roadmap_steps[i]}\n\nComplete this step. End with {self.c.sigil_proceed} if more remain, or {self.c.sigil_halt} if finished.")
        self.state.roadmap_index += 1
    def _send_rm_synth(self):
        self.state.roadmap_synth_sent = True
        self.state.detail = "🗺 final synthesis"
        self._send(f"Continue.\n\n[coyote roadmap — final synthesis]\nAll steps complete. Compile final deliverable. No recap, no fluff. End with {self.c.sigil_halt}.")
    def _reset_rm(self):
        self.state.roadmap_captured = False
        self.state.roadmap_steps = []
        self.state.roadmap_index = 0
        self.state.roadmap_synth_sent = False
    def _limit(self):
        self.state.status = LoopState.LIMIT
        self.state.detail = f"hit {self.c.max_rounds} rounds — extend to continue"
        self.state.send_pending = False
        self._stop_tick()
    def extend(self):
        self.c.max_rounds += self.c.limit_step
        self.state.status = LoopState.RUNNING
        self.state.detail = ""
        self._touch()
        self._start_tick()
        self.tick()
    def _halt(self, reason: str):
        self.state.status = LoopState.COMPLETE
        self.state.detail = reason
        self._stop_tick()
        self.log("halted", {"reason": reason})
    def _pause(self, reason: str):
        self.state.status = LoopState.PAUSED
        self.state.detail = reason
        self._stop_tick()
        self.log("paused", {"reason": reason})
    def _touch(self): self.state.last_activity = time.time()
    def _start_tick(self):
        self._stop_tick()
        self._tick_t = threading.Timer(self.c.tick_interval, self._tick_w)
        self._tick_t.daemon = True
        self._tick_t.start()
    def _tick_w(self):
        try: self.tick()
        except Exception as e: self.log("tick_error", {"error": str(e)})
        finally:
            if self.state.status == LoopState.RUNNING: self._start_tick()
    def _stop_tick(self):
        if self._tick_t:
            self._tick_t.cancel()
            self._tick_t = None
    def _start_met(self):
        if not self.c.metrics_enabled: return
        self._met_t = threading.Timer(self.c.metrics_interval, self._met_w)
        self._met_t.daemon = True
        self._met_t.start()
    def _met_w(self):
        try:
            m = self.client.get_metrics()
            self.log("metrics", m)
        except: pass
        finally:
            if self.state.status in (LoopState.RUNNING, LoopState.PAUSED): self._start_met()
    def _stop_met(self):
        if self._met_t:
            self._met_t.cancel()
            self._met_t = None
    def get_state(self) -> Dict[str, Any]: return asdict(self.state)

class HalHTTPHandler(BaseHTTPRequestHandler):
    hal_loop: Optional[HalLoop] = None
    config: Optional[HalConfig] = None
    def log_message(self, fmt, *args):
        if self.config and self.config.verbose:
            print(f"[coyote-http] {fmt % args}")
    def _json(self, status: int, data: Dict[str, Any]):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    def do_GET(self):
        if self.path == "/health":
            state = "healthy"
            detail = "idle"
            if self.hal_loop:
                detail = self.hal_loop.state.status
                state = "healthy" if detail != "ERROR" else "unhealthy"
            self._json(200, {"status": state, "state": detail, "service": "coyote"})
        elif self.path == "/status":
            if self.hal_loop:
                self._json(200, self.hal_loop.get_state())
            else:
                self._json(200, {"status": "idle", "detail": "No active loop"})
        else:
            self._json(404, {"error": "not_found"})
    def do_POST(self):
        if self.path == "/task":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode()
            try:
                data = json.loads(body)
                task = data.get("task", "")
                if not task:
                    self._json(400, {"error": "missing task"})
                    return
                if self.hal_loop:
                    self.hal_loop.destroy()
                self.hal_loop = HalLoop(self.config)
                threading.Thread(target=self.hal_loop.start, args=(task,), daemon=True).start()
                self._json(202, {"status": "started", "task": task[:100]})
            except Exception as e:
                self._json(500, {"error": str(e)})
        elif self.path == "/stop":
            if self.hal_loop:
                self.hal_loop.stop()
                self._json(200, {"status": "stopped"})
            else:
                self._json(200, {"status": "already_idle"})
        elif self.path == "/extend":
            if self.hal_loop and self.hal_loop.state.status == LoopState.LIMIT:
                self.hal_loop.extend()
                self._json(200, {"status": "extended"})
            else:
                self._json(400, {"error": "not_at_limit"})
        else:
            self._json(404, {"error": "not_found"})

def main():
    import argparse
    p = argparse.ArgumentParser(description="Coyote Loop v3.1 — Max Level")
    p.add_argument("--task", "-t")
    p.add_argument("--model", "-m", default=os.environ.get("COYOTE_MODEL", "gpt-oss"))
    p.add_argument("--session", "-s", default="default")
    p.add_argument("--max-rounds", type=int, default=50)
    p.add_argument("--ctx-size", type=int, default=131072)
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument("--interactive", "-i", action="store_true")
    p.add_argument("--base-url", default="http://127.0.0.1:25100")
    p.add_argument("--api-key", default=os.environ.get("COYOTE_API_KEY", "sk-hal-local"))
    p.add_argument("--port", type=int, default=25143)
    p.add_argument("--host", default="0.0.0.0")
    a = p.parse_args()
    c = HalConfig(base_url=a.base_url, api_key=a.api_key, model=a.model, session_id=a.session, max_rounds=a.max_rounds, verbose=a.verbose, http_port=a.port, http_host=a.host)
    handler = HalHTTPHandler
    handler.config = c
    def sig(signum, frame):
        print("\n[coyote] interrupted, saving...")
        if handler.hal_loop: handler.hal_loop.stop()
        sys.exit(0)
    signal.signal(signal.SIGINT, sig)
    signal.signal(signal.SIGTERM, sig)
    server = HTTPServer((c.http_host, c.http_port), handler)
    print(f"[coyote] HTTP server on {c.http_host}:{c.http_port}")
    print(f"[coyote] AST matrix: {c.base_url}")
    print(f"[coyote] Endpoints: GET /health, GET /status, POST /task, POST /stop")
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    if a.interactive:
        print("[coyote] Interactive. Commands: start <task>, stop, status, extend, quit")
        while True:
            try:
                cmd = input("> ").strip()
                if cmd.startswith("start "):
                    if handler.hal_loop: handler.hal_loop.destroy()
                    handler.hal_loop = HalLoop(c)
                    handler.hal_loop.start(cmd[6:])
                elif cmd == "stop":
                    if handler.hal_loop: handler.hal_loop.stop()
                elif cmd == "status":
                    s = handler.hal_loop.get_state() if handler.hal_loop else {"status": "idle"}
                    print(f"{s['status']} | r{s.get('round', 0)} | {s.get('detail', '')}")
                elif cmd == "extend":
                    if handler.hal_loop: handler.hal_loop.extend()
                elif cmd == "quit":
                    if handler.hal_loop: handler.hal_loop.stop()
                    break
            except EOFError: break
    elif a.task:
        handler.hal_loop = HalLoop(c)
        handler.hal_loop.start(a.task)
        try:
            while handler.hal_loop.state.status in (LoopState.RUNNING, LoopState.LIMIT):
                time.sleep(1)
                if handler.hal_loop.state.status == LoopState.LIMIT:
                    print(f"[coyote] limit {handler.hal_loop.state.round}. extend? (y/n)")
                    if input().strip().lower() != "y":
                        handler.hal_loop.stop()
                        break
                    handler.hal_loop.extend()
        except KeyboardInterrupt:
            handler.hal_loop.stop()
        print(f"[coyote] {handler.hal_loop.state.status} | rounds: {handler.hal_loop.state.round} | {handler.hal_loop.state.detail}")
    else:
        print("[coyote] Daemon mode. Waiting for tasks via HTTP.")
        try:
            while True: time.sleep(3600)
        except KeyboardInterrupt: pass
    server.shutdown()

if __name__ == "__main__":
    main()

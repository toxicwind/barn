#!/usr/bin/env python3
"""termstream — semi-live terminal window stream for browser viewing.

Captures a window (or full screen) with grim at ~2fps and serves it as
MJPEG (multipart/x-mixed-replace), which browsers render natively in an
<img> tag — no plugins, no video codec. "Semi-live": a few frames per
second, good enough to watch a terminal.

Usage:
  termstream.py [--window PATTERN] [--port 25160] [--fps 2] [--scale 0.6]

  --window PATTERN  match window title (hyprctl) to capture; default: full screen
  Serves:
    /            tiny viewer page (auto-refreshing <img>)
    /stream      MJPEG stream
    /shot        single JPEG snapshot
"""
import argparse
import io
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

BOUNDARY = "frame"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def find_window(pattern):
    """Return hyprctl window address matching pattern in title/class."""
    r = sh(["hyprctl", "clients", "-j"])
    if r.returncode != 0:
        return None
    import json
    try:
        clients = json.loads(r.stdout)
    except Exception:
        return None
    pat = pattern.lower()
    for c in clients:
        if pat in (c.get("title") or "").lower() or pat in (c.get("class") or "").lower():
            return c["address"]
    return None


def focus_window(pattern):
    """Focus the first window matching pattern (title/class)."""
    r = sh(["hyprctl", "clients", "-j"])
    if r.returncode != 0:
        return False
    import json
    try:
        clients = json.loads(r.stdout)
    except Exception:
        return False
    pat = pattern.lower()
    for c in clients:
        if pat in (c.get("title") or "").lower() or pat in (c.get("class") or "").lower():
            sh(["hyprctl", "dispatch", "focuswindow",
                "address:" + c["address"]])
            return True
    return False


def grab_jpeg(window=None, scale=0.6):
    """Capture the focused terminal window (or full screen) as JPEG."""
    import tempfile
    tmpd = tempfile.mkdtemp()
    png = os.path.join(tmpd, "cap.png")
    try:
        env = dict(os.environ,
                   WAYLAND_DISPLAY=os.environ.get("WAYLAND_DISPLAY", "wayland-1"))
        if window:
            focus_window(window)
            time.sleep(0.3)
            cmd = ["hyprshot", "-m", "window", "-m", "active",
                   "-s", "-o", tmpd, "-f", "cap.png"]
        else:
            cmd = ["hyprshot", "-m", "output", "-s", "-o", tmpd, "-f", "cap.png"]
        r = subprocess.run(cmd, capture_output=True, env=env, timeout=15)
        # note: hyprshot returns rc=1 even on success — check file existence only
        if not os.path.exists(png):
            return None
        # scale down via ffmpeg for bandwidth
        out = png + ".jpg"
        w = int(1920 * scale)
        r2 = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", png, "-vf", f"scale={w}:-1",
             "-q:v", "5", out],
            capture_output=True, timeout=10)
        if r2.returncode != 0:
            return None
        with open(out, "rb") as f:
            return f.read()
    except Exception:
        return None
    finally:
        import shutil
        try:
            shutil.rmtree(tmpd, ignore_errors=True)
        except OSError:
            pass


class State:
    def __init__(self, window_pattern, fps, scale):
        self.window_pattern = window_pattern
        self.fps = fps
        self.scale = scale
        self.frame = None
        self.lock = threading.Lock()
        self.window = None

    def loop(self):
        while True:
            img = grab_jpeg(self.window_pattern, self.scale)
            if img:
                with self.lock:
                    self.frame = img
            time.sleep(1.0 / self.fps)


VIEWER = """<!doctype html><html><head><title>termstream</title>
<style>body{background:#111;color:#ccc;font-family:monospace;text-align:center}
img{max-width:98vw;max-height:92vh;border:1px solid #333;margin-top:8px}</style>
</head><body><div>termstream — semi-live (~%d fps) — %s</div>
<img src="/stream"><script>
// cache-buster fallback if the stream stalls
setInterval(()=>{const i=document.querySelector('img');
if(i.naturalWidth===0)i.src='/stream?'+Date.now()},15000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        st = self.server.state
        if self.path == "/" or self.path.startswith("/?"):
            body = (VIEWER % (st.fps, st.window_pattern or "full screen")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/shot":
            with st.lock:
                frame = st.frame
            if not frame:
                self.send_error(503, "no frame yet")
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)
        elif self.path.startswith("/stream"):
            self.send_response(200)
            self.send_header("Content-Type",
                             "multipart/x-mixed-replace; boundary=" + BOUNDARY)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    with st.lock:
                        frame = st.frame
                    if frame:
                        self.wfile.write(
                            ("--" + BOUNDARY + "\r\n"
                             "Content-Type: image/jpeg\r\n"
                             f"Content-Length: {len(frame)}\r\n\r\n").encode())
                        self.wfile.write(frame)
                        self.wfile.write(b"\r\n")
                    time.sleep(1.0 / st.fps)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_error(404)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default="")
    ap.add_argument("--port", type=int, default=25160)
    ap.add_argument("--fps", type=float, default=2)
    ap.add_argument("--scale", type=float, default=0.6)
    a = ap.parse_args()
    st = State(a.window or None, a.fps, a.scale)
    threading.Thread(target=st.loop, daemon=True).start()
    srv = Server(("0.0.0.0", a.port), Handler)
    srv.state = st
    print(f"termstream on :{a.port} window={a.window or 'screen'} fps={a.fps}",
          flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

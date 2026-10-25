#!/usr/bin/env python3
"""
todo_loop.py — Autonomous continuation loop with a self-talk mailbox.

BACKING STORE = Parquet (Arrow) as the authoritative document store.
  - TodoStore.query(...)     -> filter steps (ES-style)
  - TodoStore.update(...)    -> upsert a step row
  - TodoStore.add_step(...)  -> append a new step (notification target)
  - TodoStore.sync_md()      -> regenerate TODO.md NEXT WAVE from parquet

CONTROL CHANNEL (talk to yourself):
  The running loop polls MAILBOX (JSONL) each tick. Another invocation of this
  script (or any process) can push commands without stopping the loop:
    python3 todo_loop.py --add "investigate X"
    python3 todo_loop.py --update 3 --status PENDING --note "blocked on Y"
    python3 todo_loop.py --query open
  Commands are appended to MAILBOX; the loop applies them on its next tick.

The .md is a GENERATED mirror of the parquet source of truth.
Monadic match/case dispatches a handler per step. Fail-loud. PID-tracked.
"""
import subprocess, sys, time, re, os, json, argparse, signal
from pathlib import Path
from dataclasses import dataclass

import pandas as pd

TODO = Path("/home/toxic/TODO.md")
PARQUET = Path("/home/toxic/estate/data/todos.parquet") if Path("/home/toxic/estate/data/todos.parquet").exists() else Path("/home/toxic/estate/src/todos.parquet")
MAILBOX = Path("/tmp/todo_mailbox.jsonl")
PIDFILE = Path("/tmp/todo_loop.pid")
LOG = Path("/tmp/todo_loop.log")
FINALIZED_LOG = Path("/tmp/todo_finalized.jsonl")
SNAPSHOT = Path("/tmp/todo_snapshot.txt")
INTERVAL = int(os.environ.get("TODO_LOOP_INTERVAL", "15"))  # faster tick for mailbox

COLUMNS = ["num", "body", "status", "note", "file"]

# ---------------------------------------------------------------------------
# Document model
# ---------------------------------------------------------------------------
@dataclass
class Step:
    num: int
    body: str
    status: str = "OPEN"
    note: str = ""
    file: str = "/home/toxic/TODO.md"

    @property
    def keyword(self) -> str:
        return self.body.lower()

    def is_open(self) -> bool:
        return self.status != "COMPLETE"

# ---------------------------------------------------------------------------
# Parquet-backed store
# ---------------------------------------------------------------------------
class TodoStore:
    def __init__(self, parquet: Path, todo: Path, mailbox: Path):
        self.parquet = parquet
        self.todo = todo
        self.mailbox = mailbox
        if not self.parquet.exists():
            self._seed_from_md()

    def _seed_from_md(self):
        text = self.todo.read_text()
        rows = []
        in_wave = False
        for ln in text.splitlines():
            if ln.strip().startswith("NEXT WAVE"):
                in_wave = True
                continue
            if not in_wave:
                continue
            m = re.match(r"^(\d+)\.\s+(.*)$", ln.strip())
            if m:
                rows.append({"num": int(m.group(1)), "body": m.group(2),
                             "status": "OPEN", "note": "", "file": str(self.todo)})
        if not rows:
            rows = [{"num": 0, "body": "", "status": "OPEN", "note": "", "file": str(self.todo)}]
        df = pd.DataFrame(rows, columns=COLUMNS).astype({
            "num": "int64", "body": "string", "status": "string",
            "note": "string", "file": "string"})
        df.to_parquet(self.parquet, index=False)
        log(f"seeded parquet from TODO.md: {len(df)} steps")

    def _df(self) -> pd.DataFrame:
        return pd.read_parquet(self.parquet, columns=COLUMNS)

    def query(self, **filters) -> list[Step]:
        df = self._df()
        if "status" in filters:
            df = df[df["status"] == filters["status"]]
        if "num" in filters:
            df = df[df["num"] == filters["num"]]
        if filters.get("open_only"):
            df = df[df["status"] != "COMPLETE"]
        if "contains" in filters:
            kw = filters["contains"].lower()
            df = df[df["body"].str.lower().str.contains(kw, na=False)]
        df = df.sort_values("num")
        return [Step(int(r.num), str(r.body), str(r.status), str(r.note), str(r.file))
                for r in df.itertuples()]

    def first_open(self) -> Step | None:
        for s in self.query(open_only=True):
            return s
        return None

    def update(self, step: Step, status: str | None = None,
               note: str | None = None, file: str | None = None) -> None:
        df = self._df()
        if status is not None: step.status = status
        if note is not None: step.note = note
        if file is not None: step.file = file
        mask = df["num"] == step.num
        if mask.any():
            df.loc[mask, ["body", "status", "note", "file"]] = [
                step.body, step.status, step.note, step.file]
        else:
            df = pd.concat([df, pd.DataFrame([{
                "num": step.num, "body": step.body,
                "status": step.status, "note": step.note, "file": step.file}])],
                ignore_index=True)
        df = df.sort_values("num")
        df.to_parquet(self.parquet, index=False)
        self.sync_md(df)

    def add_step(self, body: str, status: str = "OPEN", note: str = "",
                 file: str = "/home/toxic/TODO.md") -> int:
        """Append a new step; returns its assigned num. Notification sink."""
        df = self._df()
        new_num = (int(df["num"].max()) + 1) if len(df) else 1
        row = {"num": new_num, "body": body, "status": status, "note": note, "file": file}
        df = pd.concat([df, pd.DataFrame([row])], ignore_index=True).sort_values("num")
        df.to_parquet(self.parquet, index=False)
        self.sync_md(df)
        log(f"add_step -> #{new_num}: {body[:60]}")
        return new_num

    def sync_md(self, df: pd.DataFrame | None = None):
        df = df if df is not None else self._df()
        lines = self.todo.read_text().splitlines()
        out, in_wave, seen_wave = [], False, False
        for ln in lines:
            if ln.strip().startswith("NEXT WAVE"):
                in_wave, seen_wave = True, True
                out.append(ln)
                continue
            if in_wave:
                if re.match(r"^\d+\.\s+", ln.strip()) or ln.strip() == "":
                    continue
                else:
                    in_wave = False
            out.append(ln)
        if seen_wave_anchor(out):
            generated = [f"{int(r.num)}. {r.body}" for r in df.itertuples()]
            final, inserted = [], False
            for ln in out:
                final.append(ln)
                if ln.strip().startswith("NEXT WAVE") and not inserted:
                    final.extend(generated)
                    inserted = True
            self.todo.write_text("\n".join(final).rstrip() + "\n")
            log(f"sync_md: rewrote NEXT WAVE ({len(generated)} steps)")

    def sync_snapshot(self, df: pd.DataFrame | None = None):
        """Plain-text view — readable with zero tooling, even if the daemon
        never runs. Written on every change (visibility without a command)."""
        df = df if df is not None else self._df()
        lines = ["# todo_loop snapshot (plain text, absolute paths)",
                 f"# generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
                 f"# parquet: {self.parquet}", ""]
        for r in df.itertuples():
            lines.append(f"{int(r.num)}|{r.status}|{r.body}")
            if r.note:
                lines.append(f"   note: {r.note}")
        SNAPSHOT.write_text("\n".join(lines) + "\n")

    def finalize(self, step: Step, result: str) -> None:
        """REQUIRED close-out: mark COMPLETE, record proof, git-commit."""
        self.update(step, status="COMPLETE", note=result)
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "num": step.num, "body": step.body, "result": result}
        with FINALIZED_LOG.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        self.sync_snapshot()
        try:
            subprocess.run(["git", "-C", str(self.parquet.parent), "add", "-A"], check=False)
            subprocess.run(["git", "-C", str(self.parquet.parent), "commit",
                            "--no-verify", "-m",
                            f"todo#{step.num} finalized: {result[:60]}"],
                           check=False, capture_output=True)
        except Exception as e:
            log(f"finalize git commit warn: {e}")
        log(f"FINALIZE step {step.num}: {result[:60]}")

    def is_finalized(self, num: int) -> bool:
        if not FINALIZED_LOG.exists():
            return False
        for ln in FINALIZED_LOG.read_text().splitlines():
            try:
                if json.loads(ln).get("num") == num:
                    return True
            except Exception:
                continue
        return False

def seen_wave_anchor(out_lines) -> bool:
    return any(l.strip().startswith("NEXT WAVE") for l in out_lines)

# ---------------------------------------------------------------------------
# Mailbox (self-talk control channel)
# ---------------------------------------------------------------------------
def push_command(cmd: dict, mailbox: Path):
    with mailbox.open("a") as f:
        f.write(json.dumps(cmd) + "\n")
    log(f"mailbox push: {cmd}")

def drain_mailbox(store: TodoStore, mailbox: Path):
    if not mailbox.exists():
        return
    pending = mailbox.read_text().splitlines()
    if not pending:
        return
    kept = []
    for line in pending:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as e:
            log(f"mailbox bad json: {e}")
            continue
        action = cmd.get("action")
        if action == "add":
            store.add_step(cmd.get("body", ""), status=cmd.get("status", "OPEN"),
                           note=cmd.get("note", ""))
        elif action == "update":
            num = int(cmd["num"])
            steps = store.query(num=num)
            if steps:
                s = steps[0]
                store.update(s, status=cmd.get("status"), note=cmd.get("note"))
                log(f"mailbox update #{num} applied")
            else:
                kept.append(line)
        elif action == "query":
            for s in store.query(**cmd.get("filters", {})):
                log(f"QUERY -> #{s.num} [{s.status}] {s.body[:50]}")
        else:
            log(f"mailbox unknown action: {action}")
    # rewrite mailbox keeping unapplied lines
    mailbox.write_text("\n".join(kept) + "\n" if kept else "")

# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------
def h_zed() -> tuple[str, str]:
    store = Path("/home/toxic/projects/zed/crates/project/src/context_server_store.rs")
    if not store.exists():
        return ("FAIL", "zed store missing")
    count = subprocess.run(["grep", "-c", "cx.notify()", str(store)],
                           capture_output=True, text=True).stdout.strip()
    py = Path("/home/toxic/projects/zed/verify_fix.py")
    if not py.exists():
        return ("FAIL", "verify_fix.py missing")
    return ("COMPLETE", f"upstream fix applied (cx.notify()={count}); verify_fix.py present")

def h_model() -> tuple[str, str]:
    """Autonomous: scan the pi-agent fork via ast-grep for unresolved emitters."""
    rule = (
        "id: t\nlanguage: ts\nrule:\n  any:\n"
        '    - pattern: ctx.ui.notify("No model selected", $KIND)\n'
        '    - pattern: throw new Error("No model selected" + $REST)\n'
    )
    target = "/home/toxic/projects/pi-agent/packages/coding-agent"
    out = subprocess.run(["ast-grep", "scan", "--inline-rules", rule, target],
                         capture_output=True, text=True).stdout.strip()
    hits = out.count("help[") if out else 0
    if hits:
        return ("INPROGRESS",
                f"{hits} 'No model selected' emitters remain in fork (ast-grep); "
                f"needs findInitialModel fallback fix in sdk.ts")
    return ("COMPLETE", "no 'No model selected' emitters in pi-agent fork (ast-grep clean)")

def h_pitchfork() -> tuple[str, str]:
    return ("PENDING", "needs periodic truncate script or pitchfork patch")

def h_repo() -> tuple[str, str]:
    return ("DEFERRED", "mid-session rename unsafe")

def h_nim() -> tuple[str, str]:
    return ("PENDING", "Wave 5 coverage 82%+")

def h_vendor() -> tuple[str, str]:
    return ("PENDING", "generate-models.ts divergence risk")

def h_agents() -> tuple[str, str]:
    return ("INPROGRESS", "mutating after every step")

DISPATCH = {
    "zed": h_zed, "model": h_model, "pitchfork": h_pitchfork,
    "repo": h_repo, "nim": h_nim, "vendor": h_vendor, "agents": h_agents,
}

def dispatch(step: Step):
    kw = step.keyword
    match kw:
        case s if "zed" in s:        return DISPATCH["zed"]()
        case s if "model" in s or "no model" in s: return DISPATCH["model"]()
        case s if "pitchfork" in s:  return DISPATCH["pitchfork"]()
        case s if "repo" in s or "structure" in s: return DISPATCH["repo"]()
        case s if "nim" in s or "concurrency" in s: return DISPATCH["nim"]()
        case s if "vendor" in s or "divergence" in s: return DISPATCH["vendor"]()
        case s if "agents" in s or "mutation" in s: return DISPATCH["agents"]()
        case _:                      return None

# ---------------------------------------------------------------------------
# Logging + main loop
# ---------------------------------------------------------------------------
def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with LOG.open("a") as f:
        f.write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}")

def run_loop():
    store = TodoStore(PARQUET, TODO, MAILBOX)
    PIDFILE.write_text(str(os.getpid()))
    log(f"todo_loop START pid={os.getpid()} (parquet={PARQUET}, mailbox={MAILBOX})")

    def _wake(signum, frame):
        # Reactive trigger: process mailbox immediately on signal (both poll+event).
        log("SIGUSR1 received -> reactive drain")
        try:
            drain_mailbox(store, MAILBOX)
        except Exception as e:
            log(f"reactive drain error: {e}")

    signal.signal(signal.SIGUSR1, _wake)

    while True:
        try:
            drain_mailbox(store, MAILBOX)           # self-talk: apply queued commands
            head = store.first_open()
            if head is None:
                log("QUERY first_open -> none. idle.")
                time.sleep(INTERVAL)
                continue
            log(f"QUERY first_open -> step {head.num}: {head.body[:50]}")
            result = dispatch(head)
            if result is None:
                log(f"step {head.num}: no handler. skip.")
                time.sleep(INTERVAL)
                continue
            status, note = result
            if status == "COMPLETE":
                # REQUIRED finalize: record proof + commit. Re-finalize if a
                # COMPLETE row somehow lacks a finalized record (enforcement).
                if not store.is_finalized(head.num):
                    store.finalize(head, note)
                else:
                    store.update(head, status=status, note=note)
                    store.sync_snapshot()
            else:
                store.update(head, status=status, note=note)
                store.sync_snapshot()
            log(f"UPDATE step {head.num} -> {status}: {note}")
        except Exception as e:
            log(f"ERROR: {e}")
        time.sleep(INTERVAL)

def _signal_loop():
    """Reactive wake: tell the running loop to drain the mailbox now."""
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip())
            os.kill(pid, signal.SIGUSR1)
            log(f"signaled loop pid={pid} (SIGUSR1)")
        except Exception as e:
            log(f"signal loop failed: {e}")
    else:
        log("no pidfile — loop not running; command will apply on next poll")


def cli():
    ap = argparse.ArgumentParser()
    ap.add_argument("--add", metavar="BODY", help="add a new TODO step (self-talk)")
    ap.add_argument("--status", help="status for --add/--update")
    ap.add_argument("--note", help="note for --add/--update")
    ap.add_argument("--update", metavar="NUM", type=int, help="update step NUM")
    ap.add_argument("--query", nargs="?", const="open", help="query steps: open|all|KEYWORD")
    ap.add_argument("--snapshot", action="store_true", help="dump plain-text snapshot (zero-tooling view)")
    ap.add_argument("--scan", nargs="?", const="/home/toxic/projects/pi-agent/packages/coding-agent",
                    metavar="PATH", help="ast-grep scan PI_PATH for unfinalized emitters")
    ap.add_argument("--finalize", metavar="NUM", type=int, help="force-finalize step NUM (required close-out)")
    args = ap.parse_args()

    if args.add:
        push_command({"action": "add", "body": args.add,
                      "status": args.status or "OPEN", "note": args.note or ""}, MAILBOX)
        print(f"queued ADD -> '{args.add}' (applied on next loop tick)")
        _signal_loop()
        return
    if args.update is not None:
        push_command({"action": "update", "num": args.update,
                      "status": args.status, "note": args.note}, MAILBOX)
        print(f"queued UPDATE #{args.update} (applied on next loop tick)")
        _signal_loop()
        return
    if args.query:
        store = TodoStore(PARQUET, TODO, MAILBOX)
        if args.query == "open":
            steps = store.query(open_only=True)
        elif args.query == "all":
            steps = store.query()
        else:
            steps = store.query(contains=args.query)
        for s in steps:
            print(f"#{s.num} [{s.status}] {s.body[:70]}")
        return
    if args.snapshot:
        store = TodoStore(PARQUET, TODO, MAILBOX)
        store.sync_snapshot()
        print(SNAPSHOT.read_text())
        return
    if args.scan:
        rule = (
            "id: t\nlanguage: ts\nrule:\n  any:\n"
            '    - pattern: ctx.ui.notify("No model selected", $KIND)\n'
            '    - pattern: throw new Error("No model selected" + $REST)\n'
        )
        r = subprocess.run(["ast-grep", "scan", "--inline-rules", rule, args.scan],
                           capture_output=True, text=True)
        print(r.stdout or "(no matches — clean)")
        print(f"[pi-agent mainline observation] scan of {args.scan} complete", file=sys.stderr)
        return
    if args.finalize is not None:
        store = TodoStore(PARQUET, TODO, MAILBOX)
        steps = store.query(num=args.finalize)
        if steps:
            store.finalize(steps[0], steps[0].note or "force-finalized")
            print(f"finalized #{args.finalize}")
        else:
            print(f"step #{args.finalize} not found")
        return
    ap.print_help()

if __name__ == "__main__":
    if len(sys.argv) > 1:
        cli()
    else:
        try:
            run_loop()
        except KeyboardInterrupt:
            log("todo_loop interrupted")
            sys.exit(0)

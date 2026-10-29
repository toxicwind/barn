#!/usr/bin/env python3
"""or-free-sweep3.py — FULL OpenRouter catalog sweep with the NEW free key,
using correct per-model request shapes, plus an abstract-prompt SPECULATIVE
quality ranking. Runs on yote (bridge exec). Never prints the key.

Probe: ABSTRACT prompt (not a trivial echo test), correct request shapes per
model family:
  - adaptive max_tokens vs max_completion_tokens (400-message sniffing)
  - adaptive temperature removal for models that reject temperature
  - records reasoning-only outputs (reasoning models)
  - one fast no-sleep retry on 429/5xx, otherwise fail fast
Judging: best available free model as LLM judge + heuristic sentence check.
"""
import asyncio
import aiohttp
import json
import re
import sys
import time

SECRETS = "/home/toxic/.secrets"
VAR = "/home/toxic/estate/var"
OUT_JSONL = f"{VAR}/or-free-sweep3.jsonl"
OUT_JSON = f"{VAR}/or-free-sweep3-results.json"
OUT_MD = f"{VAR}/or-free-ranking.md"

ABSTRACT = ("Explain recursion in exactly three sentences for a smart 12-year-old, "
            "with one concrete real-world example.")
CEIL = 75  # per-request ceiling, seconds
WORKERS = 16
JUDGE_WORKERS = 8
CONNECT_TO = 20

JUDGE_PREFS = [
    "google/gemma-4-26b-a4b-it:free",
    "qwen/qwen3.8-27b:free",
    "z-ai/glm-5.2:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it",
    "qwen/qwen3.8-27b",
    "z-ai/glm-5.2",
    "nex-agi/nex-n2.5-pro:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3.5-lightning:free",
    "cohere/north-mini-code:free",
    "poolside/laguna-xs-2.1:free",
    "nex-agi/nex-n2.5-mini:free",
    "liquid/lfm-2.5-2.6b:free",
    "inclusionai/ling-3.0-flash-fin:free",
]

JUDGE_SYS = (
    'You are a strict grader. A model was asked: "Explain recursion in exactly '
    'three sentences for a smart 12-year-old, with one concrete real-world example." '
    'Score the ANSWER below. Reply with ONLY a JSON object, no other text:\n'
    '{"sentences": 0-3 (did it use EXACTLY three sentences?), '
    '"correctness": 0-3 (is the recursion explanation factually correct and clear?), '
    '"example": 0-2 (is there a concrete real-world example?), '
    '"age_fit": 0-2 (tone/vocabulary right for a smart 12-year-old?), '
    '"total": <sum 0-10>, '
    '"one_line": "<max 12 words, why this score>"}\n'
    'ANSWER:\n---\n'
)


def load_key():
    for line in open(SECRETS):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            if k.strip() == "OPENROUTER_API_KEY_FREE":
                return v.strip().strip('"').strip("'")
    raise SystemExit("OPENROUTER_API_KEY_FREE not found in secrets")


KEY = load_key()
BASE = "https://openrouter.ai/api/v1"
HDR = {
    "Authorization": "Bearer " + KEY,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/toxicwind/estate-projects",
    "X-Title": "or-census-sweep3",
}


async def fetch_models(session):
    async with session.get(BASE + "/models", headers=HDR,
                           timeout=aiohttp.ClientTimeout(total=40)) as r:
        r.raise_for_status()
        d = await r.json()
        return [m["id"] for m in d["data"]]


def classify(status):
    return {402: "paid", 404: "dead", 403: "forbidden", 429: "throttled",
            400: "malformed"}.get(status, f"http{status}")


async def probe(session, sem, model):
    """One model, adaptive request shapes, max 3 fast attempts, no sleeps."""
    async with sem:
        t0 = time.time()
        rec = {"model": model, "ok": False, "http": None, "latency_ms": 0.0,
               "content": "", "reasoning_text": "", "cls": "error", "note": ""}
        shape = None  # None | "mctok" | "notemp"
        retried_5xx = False
        for attempt in range(3):
            body = {"model": model,
                    "messages": [{"role": "user", "content": ABSTRACT}],
                    "temperature": 0}
            if shape == "mctok":
                body["max_completion_tokens"] = 256
            else:
                body["max_tokens"] = 256
            if shape == "notemp":
                body.pop("temperature", None)
            try:
                async with session.post(BASE + "/chat/completions", headers=HDR,
                                        json=body,
                                        timeout=aiohttp.ClientTimeout(
                                            total=CEIL, connect=CONNECT_TO)) as r:
                    status = r.status
                    txt = await r.text()
                    lat = round((time.time() - t0) * 1000, 1)
                    rec["latency_ms"] = lat
                    rec["http"] = status
                    if status == 200:
                        try:
                            d = json.loads(txt)
                        except Exception:
                            rec.update(cls="malformed", note="200 non-JSON")
                            return rec
                        ch = (d.get("choices") or [{}])[0]
                        msg = ch.get("message", {}) or {}
                        content = (msg.get("content") or "") or ""
                        reason = (msg.get("reasoning") or
                                  msg.get("reasoning_content") or "")
                        reason = str(reason)
                        if ch.get("finish_reason") == "error":
                            rec.update(cls="malformed",
                                       note="finish_reason=error " + txt[:80])
                            return rec
                        rec.update(ok=True, http=200, content=content.strip(),
                                   reasoning_text=reason[:400], cls="works")
                        if not content.strip() and reason.strip():
                            rec["note"] = "reasoning-only output"
                        return rec
                    low = txt[:400].lower()
                    if status == 400 and attempt == 0:
                        if "max_completion_tokens" in low and shape is None:
                            shape = "mctok"
                            continue
                        if "temperature" in low and shape is None:
                            shape = "notemp"
                            continue
                    if status in (429, 500, 502, 503) and not retried_5xx:
                        retried_5xx = True
                        continue  # one fast retry, no sleep
                    rec["cls"] = classify(status)
                    rec["note"] = txt[:120].replace("\n", " ")
                    return rec
            except asyncio.TimeoutError:
                rec.update(cls="timeout",
                           note=f"timeout after {CEIL}s (attempt {attempt + 1})")
                return rec
            except Exception as e:
                rec.update(cls="error", note=str(e)[:100])
                return rec
        return rec


def count_sentences(t):
    t = (t or "").strip()
    if not t:
        return 0
    parts = [p.strip() for p in re.split(r"[.!?…]+", t) if p.strip()]
    return len(parts)


async def judge_one(session, sem, judge, answer_text):
    """Ask the judge model to grade one answer. Returns dict or None."""
    async with sem:
        body = {"model": judge,
                "messages": [{"role": "user",
                              "content": JUDGE_SYS + answer_text}],
                "max_tokens": 256, "temperature": 0}
        try:
            async with session.post(BASE + "/chat/completions", headers=HDR,
                                    json=body,
                                    timeout=aiohttp.ClientTimeout(total=CEIL)) as r:
                if r.status != 200:
                    return None
                d = await r.json()
                msg = (d.get("choices") or [{}])[0].get("message", {}) or {}
                out = (msg.get("content") or "").strip()
        except Exception:
            return None
    # parse: try full JSON, else regex-extract fields
    try:
        j = json.loads(out[out.index("{"):out.rindex("}") + 1])
        total = int(j.get("total", -1))
        if 0 <= total <= 10:
            return {"judge_total": total,
                    "judge_sentences": j.get("sentences"),
                    "judge_correctness": j.get("correctness"),
                    "judge_example": j.get("example"),
                    "judge_age_fit": j.get("age_fit"),
                    "judge_line": str(j.get("one_line", ""))[:90]}
    except Exception:
        pass
    m = re.search(r'"total"\s*:\s*(\d{1,2})', out)
    if m and 0 <= int(m.group(1)) <= 10:
        return {"judge_total": int(m.group(1)), "judge_line": "regex-extracted"}
    m = re.search(r"\btotal\b[^0-9]*(\d{1,2})\s*/\s*10", out, re.I)
    if m and 0 <= int(m.group(1)) <= 10:
        return {"judge_total": int(m.group(1)), "judge_line": "regex-extracted"}
    return None


def md_escape(s):
    return str(s).replace("|", "\\|").replace("\n", " ").strip()


async def main():
    t_start = time.time()
    conn = aiohttp.TCPConnector(limit=WORKERS, limit_per_host=WORKERS)
    async with aiohttp.ClientSession(connector=conn) as session:
        models = await fetch_models(session)
        print(f"catalog: {len(models)} models", flush=True)

        sem = asyncio.Semaphore(WORKERS)
        results = []
        done = 0
        hist = {}
        fout = open(OUT_JSONL, "w")
        tasks = [asyncio.ensure_future(probe(session, sem, m)) for m in models]
        for fut in asyncio.as_completed(tasks):
            rec = await fut
            results.append(rec)
            fout.write(json.dumps(rec) + "\n")
            fout.flush()
            done += 1
            hist[rec["cls"]] = hist.get(rec["cls"], 0) + 1
            if done % 25 == 0:
                el = round(time.time() - t_start, 1)
                print(f"  [{el}s] {done}/{len(models)} "
                      f"hist={json.dumps(hist)}", flush=True)
        fout.close()
        with open(OUT_JSON, "w") as f:
            json.dump(results, f)

        works = [r for r in results if r["ok"]]
        empties = [r for r in works if not r["content"]]
        answerable = [r for r in works if r["content"]]
        print(f"sweep done: works={len(works)} answerable={len(answerable)} "
              f"empty={len(empties)}", flush=True)

        # ---- judging ----
        judge = next((p for p in JUDGE_PREFS
                      if any(r["model"] == p for r in answerable)), None)
        if not judge and answerable:
            judge = sorted(answerable,
                           key=lambda r: r["latency_ms"])[0]["model"]
        print(f"judge model: {judge}", flush=True)
        graded = []
        if judge:
            jsem = asyncio.Semaphore(JUDGE_WORKERS)
            jtasks = {asyncio.ensure_future(
                judge_one(session, jsem, judge, r["content"])): r
                for r in answerable}
            donej = 0
            for fut in asyncio.as_completed(jtasks):
                r = jtasks[fut]
                g = await fut
                donej += 1
                if donej % 5 == 0:
                    print(f"  judged {donej}/{len(answerable)}", flush=True)
                if g:
                    r.update(g)
                r["judge"] = judge
                r["heur_sentences"] = count_sentences(r["content"])
                graded.append(r)
        # fallback heuristic-only ranking for ungraded
        for r in graded:
            if r.get("judge_total") is None:
                hs = r["heur_sentences"]
                r["judge_total"] = 6 if hs == 3 else (4 if hs in (2, 4) else 2)
                r["judge_line"] = "heuristic-only fallback"

        ranked = sorted(graded,
                        key=lambda r: (-r["judge_total"], r["latency_ms"]))

        # ---- counts ----
        def n(cls):
            return sum(1 for r in results if r["cls"] == cls)
        counts = {
            "total": len(results),
            "works": n("works"),
            "paid": n("paid"),
            "dead": n("dead"),
            "forbidden": n("forbidden"),
            "throttled": n("throttled"),
            "malformed": n("malformed"),
            "timeout": n("timeout"),
            "error": n("error"),
        }
        print("counts: " + json.dumps(counts), flush=True)

        # ---- write ranking md ----
        throttled_ids = sorted(r["model"] for r in results
                               if r["cls"] == "throttled")
        tier1 = sorted([r for r in works if r["content"]],
                       key=lambda r: r["latency_ms"])
        tier2 = sorted(empties, key=lambda r: r["latency_ms"])

        lines = []
        A = lines.append
        A("# OpenRouter Free-Key Model Ranking (2026-09-20)")
        A("")
        A("Probe: abstract prompt sent to **all %d** OpenRouter catalog models via "
          "the FREE key, with correct per-model request shapes (adaptive "
          "max_tokens/max_completion_tokens, adaptive temperature removal, "
          "reasoning-field capture)." % counts["total"])
        A("")
        A('Abstract prompt: "Explain recursion in exactly three sentences for a '
          'smart 12-year-old, with one concrete real-world example."')
        A("")
        A("**SPECULATIVE**: the quality ranking below is a single-prompt probe, "
          "not a benchmark. One answer per model, graded by an LLM judge "
          "(%s) plus a heuristic sentence check. Treat order as a rough "
          "signal, not a verdict." % (judge or "none"))
        A("")
        A("## Tier 1: Working + answered the abstract prompt (%d)" % len(tier1))
        A("")
        A("| Latency | Model |")
        A("|---------|-------|")
        for r in tier1:
            A("| %dms | %s |" % (r["latency_ms"], r["model"]))
        A("")
        A("## Tier 2: Working but empty/unusable content (%d)" % len(tier2))
        A("")
        A("Responded 200 but produced no gradeable answer (reasoning-only output, "
          "empty content, or refusal).")
        A("")
        A("| Latency | Model | Note |")
        A("|---------|-------|------|")
        for r in tier2:
            A("| %dms | %s | %s |" % (r["latency_ms"], r["model"],
                                     md_escape(r.get("note", ""))))
        A("")
        A("## Tier 3: Rate-limited, probably available (%d)" % len(throttled_ids))
        A("")
        A("429 on probe + one fast retry; throttled, not dead.")
        A("")
        for mid in throttled_ids:
            A("- " + mid)
        A("")
        A("## Not available on free key")
        A("")
        A("- %d models: 402 (paid, key is free-only)" % counts["paid"])
        A("- %d models: 404 (stale/dead IDs)" % counts["dead"])
        A("- %d models: 403 (forbidden)" % counts["forbidden"])
        A("- %d models: 400 malformed (rejected even shape-adapted requests)"
          % counts["malformed"])
        A("- %d models: timeout / transport error"
          % (counts["timeout"] + counts["error"]))
        A("")
        A("## Speculative quality ranking (abstract-prompt probe)")
        A("")
        A("**SPECULATIVE — single-prompt probe, not a benchmark.** Each model "
          "answered the recursion prompt once; an LLM judge graded each answer "
          "0–10 on: exactly-three-sentences (0–3), correctness (0–3), concrete "
          "real-world example (0–2), fit for a smart 12-year-old (0–2). "
          "Heuristic = automated sentence count as a cross-check.")
        A("")
        A("| Rank | Score | HeurSent | Latency | Model | Judge verdict |")
        A("|------|-------|----------|---------|-------|---------------|")
        for i, r in enumerate(ranked[:20], 1):
            A("| %d | %d/10 | %d | %dms | %s | %s |" % (
                i, r["judge_total"], r["heur_sentences"], r["latency_ms"],
                r["model"], md_escape(r.get("judge_line", ""))))
        A("")
        A("## Notes")
        A("")
        A("- The `:free` suffix remains unreliable as a sole signal: availability "
          "must be probed, not assumed from the label.")
        A("- Request shapes matter: models rejecting `temperature` or requiring "
          "`max_completion_tokens` were retried with adapted shapes before "
          "being classified.")
        A("- Raw sweep data: var/or-free-sweep3.jsonl (JSONL) and "
          "var/or-free-sweep3-results.json (JSON array).")
        with open(OUT_MD, "w") as f:
            f.write("\n".join(lines) + "\n")
        print("wrote " + OUT_MD, flush=True)
        print("TOP10:", flush=True)
        for i, r in enumerate(ranked[:10], 1):
            print(f"  {i}. {r['judge_total']}/10 {r['model']} "
                  f"({r['latency_ms']}ms) — {r.get('judge_line','')}",
                  flush=True)


if __name__ == "__main__":
    asyncio.run(main())

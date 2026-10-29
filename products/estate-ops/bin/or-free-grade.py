#!/usr/bin/env python3
"""or-free-grade.py — phase 2 of the sweep3 census.
1. Re-probes reasoning-only/empty + throttled models with a bigger token budget
   (reasoning models exhaust 256 tokens on thinking alone).
2. Grades every answerable response with an LLM judge (fixed: gather, no
   as_completed dict-key bug) + heuristic sentence check.
3. Writes or-free-sweep3-results.json and or-free-ranking.md.
Never prints the key.
"""
import asyncio
import aiohttp
import json
import re
import time
from collections import Counter

SECRETS = "/home/toxic/.secrets"
VAR = "/home/toxic/estate/var"
IN_JSONL = f"{VAR}/or-free-sweep3.jsonl"
OUT_JSON = f"{VAR}/or-free-sweep3-results.json"
OUT_MD = f"{VAR}/or-free-ranking.md"

ABSTRACT = ("Explain recursion in exactly three sentences for a smart 12-year-old, "
            "with one concrete real-world example.")
CEIL = 120
WORKERS = 12

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
    "liquid/lfm-2.5-2.6b:free",
    "inclusionai/ling-3.0-flash-fin:free",
    "nex-agi/nex-n2.5-mini:free",
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
    raise SystemExit("no key")


KEY = load_key()
BASE = "https://openrouter.ai/api/v1"
HDR = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json",
       "HTTP-Referer": "https://github.com/toxicwind/estate-projects",
       "X-Title": "or-census-grade"}


def classify(status):
    return {402: "paid", 404: "dead", 403: "forbidden", 429: "throttled",
            400: "malformed"}.get(status, f"http{status}")


async def reprobe(session, sem, rec):
    """One model, big token budget for reasoning models, adaptive shapes."""
    model = rec["model"]
    async with sem:
        t0 = time.time()
        new = dict(rec)
        shape = None
        retried = False
        for attempt in range(3):
            body = {"model": model,
                    "messages": [{"role": "user", "content": ABSTRACT}],
                    "temperature": 0}
            if shape == "mctok":
                body["max_completion_tokens"] = 2048
            else:
                body["max_tokens"] = 2048
            if shape == "notemp":
                body.pop("temperature", None)
            try:
                async with session.post(
                        BASE + "/chat/completions", headers=HDR, json=body,
                        timeout=aiohttp.ClientTimeout(total=CEIL, connect=20)) as r:
                    status = r.status
                    txt = await r.text()
                    lat = round((time.time() - t0) * 1000, 1)
                    if status == 200:
                        d = json.loads(txt)
                        ch = (d.get("choices") or [{}])[0]
                        msg = ch.get("message", {}) or {}
                        content = ((msg.get("content") or "") or "").strip()
                        reason = str(msg.get("reasoning") or
                                     msg.get("reasoning_content") or "")
                        new.update(ok=True, http=200, latency_ms=lat,
                                   content=content, reasoning_text=reason[:400],
                                   cls="works" if content else "works_empty",
                                   note="" if content else "empty even at 2048")
                        return new
                    low = txt[:400].lower()
                    if status == 400 and attempt == 0:
                        if "max_completion_tokens" in low and shape is None:
                            shape = "mctok"; continue
                        if "temperature" in low and shape is None:
                            shape = "notemp"; continue
                    if status in (429, 500, 502, 503) and not retried:
                        retried = True; continue
                    new.update(http=status, latency_ms=lat,
                               cls=classify(status),
                               note="reprobe: " + txt[:100].replace("\n", " "))
                    return new
            except asyncio.TimeoutError:
                new.update(cls="timeout", note=f"reprobe timeout {CEIL}s")
                return new
            except Exception as e:
                new.update(cls="error", note="reprobe: " + str(e)[:80])
                return new
        return new


def count_sentences(t):
    t = (t or "").strip()
    if not t:
        return 0
    return len([p for p in re.split(r"[.!?…]+", t) if p.strip()])


async def judge_one(session, sem, judge, text, prog):
    async with sem:
        body = {"model": judge,
                "messages": [{"role": "user",
                              "content": JUDGE_SYS + text[:3000]}],
                "max_tokens": 256, "temperature": 0}
        try:
            async with session.post(
                    BASE + "/chat/completions", headers=HDR, json=body,
                    timeout=aiohttp.ClientTimeout(total=90, connect=20)) as r:
                if r.status != 200:
                    prog["n"] += 1
                    return None
                d = await r.json()
                msg = (d.get("choices") or [{}])[0].get("message", {}) or {}
                out = (msg.get("content") or "").strip()
        except Exception:
            prog["n"] += 1
            return None
    prog["n"] += 1
    if prog["n"] % 4 == 0:
        print(f"  judged {prog['n']}/{prog['total']}", flush=True)
    try:
        j = json.loads(out[out.index("{"):out.rindex("}") + 1])
        total = int(j.get("total", -1))
        if 0 <= total <= 10:
            return {"judge_total": total,
                    "judge_line": str(j.get("one_line", ""))[:90]}
    except Exception:
        pass
    m = re.search(r'"total"\s*:\s*(\d{1,2})', out)
    if m and 0 <= int(m.group(1)) <= 10:
        return {"judge_total": int(m.group(1)), "judge_line": "regex-extracted"}
    return None


def md_escape(s):
    return str(s).replace("|", "\\|").replace("\n", " ").strip()


async def main():
    recs = [json.loads(l) for l in open(IN_JSONL)]
    by_id = {r["model"]: r for r in recs}
    print(f"loaded {len(recs)} records", flush=True)

    conn = aiohttp.TCPConnector(limit=WORKERS, limit_per_host=WORKERS)
    async with aiohttp.ClientSession(connector=conn) as session:
        # ---- re-probe empties + throttled with big budget ----
        targets = [r for r in recs
                   if (r["ok"] and not r["content"]) or r["cls"] == "throttled"]
        print(f"re-probing {len(targets)} (empty/throttled) at 2048 tokens",
              flush=True)
        sem = asyncio.Semaphore(WORKERS)
        newrecs = await asyncio.gather(
            *[reprobe(session, sem, r) for r in targets])
        for nr in newrecs:
            by_id[nr["model"]] = nr
            print(f"  {nr['model']}: {nr['cls']} "
                  f"len={len(nr.get('content', ''))}", flush=True)
        recs = list(by_id.values())
        with open(IN_JSONL, "w") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
        print("jsonl updated", flush=True)

        # ---- judge ----
        answerable = [r for r in recs if r["ok"] and r["content"]]
        judge = next((p for p in JUDGE_PREFS
                      if any(r["model"] == p for r in answerable)), None)
        if not judge and answerable:
            judge = sorted(answerable,
                           key=lambda r: r["latency_ms"])[0]["model"]
        print(f"judge: {judge} over {len(answerable)} answers", flush=True)
        jsem = asyncio.Semaphore(8)
        prog = {"n": 0, "total": len(answerable)}
        outs = await asyncio.gather(
            *[judge_one(session, jsem, judge, r["content"], prog)
              for r in answerable])
        for r, g in zip(answerable, outs):
            r["heur_sentences"] = count_sentences(r["content"])
            r["judge"] = judge
            if g:
                r.update(g)
            else:
                hs = r["heur_sentences"]
                r["judge_total"] = 6 if hs == 3 else (4 if hs in (2, 4) else 2)
                r["judge_line"] = "heuristic-only (judge call failed)"
        ranked = sorted(answerable,
                        key=lambda r: (-r["judge_total"], r["latency_ms"]))

        with open(OUT_JSON, "w") as f:
            json.dump(recs, f)

        # ---- counts ----
        c = Counter(r["cls"] for r in recs)
        counts = {"total": len(recs), "works": c.get("works", 0),
                  "works_empty": c.get("works_empty", 0),
                  "paid": c.get("paid", 0), "dead": c.get("dead", 0),
                  "forbidden": c.get("forbidden", 0),
                  "throttled": c.get("throttled", 0),
                  "malformed": c.get("malformed", 0),
                  "timeout": c.get("timeout", 0), "error": c.get("error", 0)}
        print("counts: " + json.dumps(counts), flush=True)

        tier1 = sorted([r for r in recs if r["cls"] == "works"
                        and r["content"]], key=lambda r: r["latency_ms"])
        tier2 = sorted([r for r in recs if r["cls"] in ("works_empty",)
                        or (r["ok"] and not r["content"])],
                       key=lambda r: r["latency_ms"])
        throttled_ids = sorted(r["model"] for r in recs
                               if r["cls"] == "throttled")

        L = []
        A = L.append
        A("# OpenRouter Free-Key Model Ranking (2026-09-20)")
        A("")
        A("Probe: abstract prompt sent to **all %d** OpenRouter catalog models via "
          "the FREE key, with correct per-model request shapes (adaptive "
          "max_tokens/max_completion_tokens, adaptive temperature removal, "
          "reasoning-field capture, 2048-token budget re-probe for reasoning "
          "models whose thinking exhausted the small budget)." % counts["total"])
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
          "empty content, or refusal) even after a 2048-token re-probe.")
        A("")
        A("| Latency | Model | Note |")
        A("|---------|-------|------|")
        for r in tier2:
            A("| %dms | %s | %s |" % (r["latency_ms"], r["model"],
                                     md_escape(r.get("note", ""))))
        A("")
        A("## Tier 3: Rate-limited, probably available (%d)" % len(throttled_ids))
        A("")
        A("429 on probe + fast retry + 2048-token re-probe; throttled, not dead.")
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
          "HeurSent = automated sentence count as a cross-check "
          "(3 = nailed the constraint).")
        A("")
        A("| Rank | Score | HeurSent | Latency | Model | Judge verdict |")
        A("|------|-------|----------|---------|-------|---------------|")
        for i, r in enumerate(ranked, 1):
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
          "being classified; reasoning models were re-probed at 2048 tokens "
          "because 256 tokens were exhausted by thinking traces.")
        A("- Raw sweep data: var/or-free-sweep3.jsonl (JSONL) and "
          "var/or-free-sweep3-results.json (JSON array).")
        A("- Scripts: bin/or-free-sweep3.py (sweep), bin/or-free-grade.py "
          "(re-probe + judge + rank).")
        with open(OUT_MD, "w") as f:
            f.write("\n".join(L) + "\n")
        print("wrote " + OUT_MD, flush=True)
        print("TOP10:", flush=True)
        for i, r in enumerate(ranked[:10], 1):
            print(f"  {i}. {r['judge_total']}/10 {r['model']} "
                  f"({r['latency_ms']}ms) — {r.get('judge_line', '')}",
                  flush=True)


if __name__ == "__main__":
    asyncio.run(main())

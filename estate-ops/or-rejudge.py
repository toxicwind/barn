#!/usr/bin/env python3
"""or-rejudge.py — re-judge the heuristic-only fallback entries with a
different judge model, then regenerate the ranking markdown."""
import asyncio, aiohttp, json, re
from collections import Counter

SECRETS = "/home/toxic/.secrets"
VAR = "/home/toxic/estate/var"
OUT_JSON = f"{VAR}/or-free-sweep3-results.json"
OUT_MD = f"{VAR}/or-free-ranking.md"
JUDGES = ["openrouter/free", "inclusionai/ling-3.0-flash-fin:free",
          "nex-agi/nex-n2.5-pro:free"]

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
    'ANSWER:\n---\n')


def load_key():
    for line in open(SECRETS):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            if k.strip() == "OPENROUTER_API_KEY_FREE":
                return v.strip().strip('"').strip("'")


KEY = load_key()
BASE = "https://openrouter.ai/api/v1"
HDR = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}


async def judge_call(session, judge, text):
    body = {"model": judge,
            "messages": [{"role": "user", "content": JUDGE_SYS + text[:3000]}],
            "max_tokens": 256, "temperature": 0}
    for _ in range(2):
        try:
            async with session.post(
                    BASE + "/chat/completions", headers=HDR, json=body,
                    timeout=aiohttp.ClientTimeout(total=90, connect=20)) as r:
                if r.status != 200:
                    continue
                d = await r.json()
                msg = (d.get("choices") or [{}])[0].get("message", {}) or {}
                out = (msg.get("content") or "").strip()
        except Exception:
            continue
        try:
            j = json.loads(out[out.index("{"):out.rindex("}") + 1])
            total = int(j.get("total", -1))
            if 0 <= total <= 10:
                return {"judge_total": total,
                        "judge_line": str(j.get("one_line", ""))[:90] + " [rejudge]"}
        except Exception:
            pass
        m = re.search(r'"total"\s*:\s*(\d{1,2})', out)
        if m and 0 <= int(m.group(1)) <= 10:
            return {"judge_total": int(m.group(1)),
                    "judge_line": "regex-extracted [rejudge]"}
    return None


def md_escape(s):
    return str(s).replace("|", "\\|").replace("\n", " ").strip()


async def main():
    recs = json.load(open(OUT_JSON))
    targets = [r for r in recs if "heuristic-only" in r.get("judge_line", "")]
    print(f"re-judging {len(targets)}", flush=True)
    async with aiohttp.ClientSession() as session:
        for r in targets:
            g = None
            for j in JUDGES:
                g = await judge_call(session, j, r["content"])
                if g:
                    r["judge"] = j
                    break
            if g:
                r.update(g)
                print(f"  {r['model']}: {r['judge_total']}/10 via {r['judge']}",
                      flush=True)
            else:
                print(f"  {r['model']}: still heuristic-only", flush=True)

    json.dump(recs, open(OUT_JSON, "w"))

    c = Counter(r["cls"] for r in recs)
    counts = {"total": len(recs), "works": c.get("works", 0),
              "paid": c.get("paid", 0), "dead": c.get("dead", 0),
              "forbidden": c.get("forbidden", 0),
              "throttled": c.get("throttled", 0),
              "malformed": c.get("malformed", 0),
              "timeout": c.get("timeout", 0), "error": c.get("error", 0)}
    answerable = [r for r in recs if r["ok"] and r["content"]]
    ranked = sorted(answerable, key=lambda r: (-r["judge_total"], r["latency_ms"]))
    tier1 = sorted(answerable, key=lambda r: r["latency_ms"])
    tier2 = sorted([r for r in recs if r["ok"] and not r["content"]],
                   key=lambda r: r["latency_ms"])
    throttled_ids = sorted(r["model"] for r in recs if r["cls"] == "throttled")
    judges_used = sorted(set(r.get("judge", "?") for r in answerable))

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
      "not a benchmark. One answer per model, graded by LLM judges "
      "(%s) plus a heuristic sentence check. Treat order as a rough "
      "signal, not a verdict." % ", ".join(judges_used))
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
      "answered the recursion prompt once; LLM judges graded each answer "
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
      "(re-probe + judge + rank), bin/or-rejudge.py (judge fallback pass).")
    open(OUT_MD, "w").write("\n".join(L) + "\n")
    print("wrote " + OUT_MD, flush=True)
    for i, r in enumerate(ranked[:10], 1):
        print(f"  {i}. {r['judge_total']}/10 {r['model']} — {r.get('judge_line','')}",
              flush=True)


if __name__ == "__main__":
    asyncio.run(main())

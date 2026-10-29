#!/usr/bin/env python3
"""Sweep OpenRouter models DIRECTLY with the FREE key (bypasses pool cooldowns).
For each model: POST chat/completions, record http, latency, response quality.
Output: JSONL to /home/toxic/estate/var/or-free-sweep2.jsonl"""
import json, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

OUT = "/home/toxic/estate/var/or-free-sweep2.jsonl"
PROMPT = "Reply with exactly: PROBE-OK"

def load_key():
    secrets = {}
    for line in open("/home/toxic/.secrets"):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            secrets[k.strip()] = v.strip().strip(chr(34)+chr(39))
    return secrets["OPENROUTER_API_KEY_FREE"]

KEY = load_key()

def get_models():
    req = urllib.request.Request("https://openrouter.ai/api/v1/models",
        headers={"Authorization": "Bearer " + KEY})
    return [m["id"] for m in json.load(urllib.request.urlopen(req, timeout=30))["data"]]

def probe(model_id):
    body = json.dumps({
        "model": model_id,
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": 32,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
        data=body, headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        d = json.load(resp)
        lat = round((time.time() - t0) * 1000, 1)
        ch = (d.get("choices") or [{}])[0]
        msg = ch.get("message", {})
        content = (msg.get("content") or "").strip()
        reasoning = (msg.get("reasoning") or "")[:80]
        # exact match in content OR reasoning contains the target
        exact = content == "PROBE-OK" or "PROBE-OK" in reasoning
        return {"model": model_id, "ok": True, "http": 200, "latency_ms": lat,
                "exact_match": exact, "content": content[:100], "has_reasoning": bool(reasoning)}
    except urllib.error.HTTPError as e:
        return {"model": model_id, "ok": False, "http": e.code,
                "latency_ms": round((time.time()-t0)*1000, 1)}
    except Exception as e:
        return {"model": model_id, "ok": False, "http": -1,
                "latency_ms": round((time.time()-t0)*1000, 1), "error": str(e)[:80]}

def main():
    models = get_models()
    print(f"probing {len(models)} models directly", flush=True)
    done = 0
    with open(OUT, "w") as f, ThreadPoolExecutor(max_workers=6) as ex:
        for r in ex.map(probe, models):
            f.write(json.dumps(r) + "\n"); f.flush()
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(models)}", flush=True)
    print("sweep2 complete", flush=True)

if __name__ == "__main__":
    main()

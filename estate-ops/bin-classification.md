# estate/bin → pens Classification Map (Phase 2a — Final)

**Source**: /home/toxic/pens/barn/estate-ops/ (162 entries, 0 remaining after move)
**Target**: /home/toxic/pens/barn/estate-ops/ (161 files + 4 subdirs moved)
**Branch**: reorg/phase-0-1

## Summary

| Category | Count |
|---|---|
| Files moved to estate-ops | 157 |
| Directories moved (tests/, tmp-reaper/) | 2 |
| Archive backups preserved | 0 (all moved then deleted from estate/bin) |
| Directories removed (empty) | 5 (__pycache__, model-audit.out, model-audit-max.out, tests, tmp-reaper) |
| estate/bin entries remaining | 0 |
| ~/.local/bin entries repointed | 13 |

## Phase 2a Actions Taken

### 1. Created pens/barn/estate-ops/ product holding
- Structure: `estate-ops/` with scratch/, tests/, tmp-reaper/ subdirs
- All 157 estate/bin files copied here with preserved permissions

### 2. Removed estate/bin/ contents
- All files deleted from /home/toxic/pens/barn/estate-ops/
- All subdirectories (tests/, tmp-reaper/, __pycache__, model-audit.out/, model-audit-max.out/) removed
- /home/toxic/pens/barn/estate-ops/ is now an empty directory (ready for deletion in Phase 3)

### 3. Repointed ~/.local/bin entries (13 total)
| Entry | Old Target | New Target |
|---|---|---|
| audio-probe | estate/bin/audio-probe | pens/barn/estate-ops/audio-probe |
| pitchfork | estate/bin/pitchfork | pens/barn/estate-ops/pitchfork |
| set-audio | estate/bin/set-audio | pens/barn/estate-ops/set-audio |
| ffs | copy (estate/bin) | pens/barn/estate-ops/ffs |
| hashline | copy (estate/bin) | pens/barn/estate-ops/hashline |
| io-rate-reaper | copy (estate/bin) | pens/barn/estate-ops/io-rate-reaper |
| iowait-gate | copy (estate/bin) | pens/barn/estate-ops/iowait-gate |
| isleep | copy (estate/bin) | pens/barn/estate-ops/isleep |
| kappa-config-audit | copy (estate/bin) | pens/barn/estate-ops/kappa-config-audit |
| oracle-judge | copy (estate/bin) | pens/barn/estate-ops/oracle-judge |
| orphan-reaper | copy (estate/bin) | pens/barn/estate-ops/orphan-reaper |
| safe-rg | copy (estate/bin) | pens/barn/estate-ops/safe-rg |
| saturation-watchdog | copy (estate/bin) | pens/barn/estate-ops/saturation-watchdog |

### 4. Updated pitchfork.toml
- 8 `exec /home/toxic/pens/barn/estate-ops/...` → `exec /home/toxic/pens/barn/estate-ops/...`
- 1 comment reference updated
- 0 remaining estate/bin references

### 5. Updated manifest.yaml
- Header updated: estate/bin → pens/barn/estate-ops
- Paths repointed throughout

## Gate Verification

```
estate/bin remaining entries: 0
estate-ops file count: 161
pitchfork.toml estate/bin refs: 0
```

## Stubs
No deliberate stubs left at estate/bin paths — all entries moved to estate-ops.
The empty estate/bin/ directory remains for deletion in Phase 3.

## Dependencies
- pitchfork.toml daemon `run` directives updated for:
  - estate-reconcile (line 306)
  - bin-contract-audit.sh (line 522)
  - maximal-audit.sh (line 529)
  - kappa-serve.sh (line 564)
  - skopos-floaty.sh (line 572)
  - claim-port (line 644)
  - kitty-mcp-instance.sh (line 681)
  - nim-kimi-sidecar.py (line 836)
  - tmp-reaper/reap-loop.sh (line 1197)

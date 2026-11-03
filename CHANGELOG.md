# Changelog

Auto-backfilled from git history 2026-11-02 (real commits only).

## 2026-11-01
- chore(pens-sweep): fold forward uncommitted tree state (2026-11-01T22:46:40-07:00) (3a9304c)
- bin manifest: regenerate post-reorg — 103 FAIL → 0 FAIL (repointed lg-fleet/corral/ego/ffs-diff/tok/bm25/docs- (d9efda1)
- docs/: add tracked INDEX hub + whitelist (barn/guide/olympus pen docs) (9b8627e)
- master README generator delegation + fix make-pen ghost-root; regenerate pen README (37f6c65)

## 2026-10-31
- de-submodule: chute -> standalone repo toxicwind/chute (submoduleless doctrine) (03e8ffa)
- de-submodule: estate-ops -> standalone repo toxicwind/estate-ops (submoduleless doctrine) (1a8eca2)
- de-submodule: gem-dredge -> standalone repo toxicwind/gem-dredge (submoduleless doctrine) (37204eb)
- de-submodule: archguard -> standalone repo toxicwind/archguard (submoduleless doctrine) (9e1360d)
- de-submodule: thresher -> standalone repo toxicwind/thresher (submoduleless doctrine) (501e1a4)
- feat(thresher): federate tau-agent stdio MCP server (:25127) (31f8a8e)
- fix thresher upstreams: pin desktop-commander to local node install, reorg wezterm path, update timestamps (f5a1559)
- fix(pitchfork): use serve-guarded.sh with mise=false for thresher per recovery skill (d46768d)
- chore(mcp): rename repo-compare upstream to trio (merged audit tools); disable retired triphylite upstream (92608c3)

## 2026-10-30
- fix(thresher): ghas upstream was stale Oct 9 Go stdio binary (2 alert tools) — repoint at live github-advanced (13f519d)
- chore: retire maximal-estate-agentic-audit; canonical now agentic-moment/products/audit (aa61b57)
- chore(thresher): disable github search on websearch-mcp + forge-mcp; ghas/blackbird sole github search (8754d10)
- chore(eidos): last-pass commit-first (everything is state) (620cf0b)
- chore(eidos): apply bun-scaffold bunfig + infra drop-in env (qdrant/hindsight/kafka/redis) — eidos is the pare (f82936e)
- chore(eidos): apply bun-scaffold bunfig + infra drop-in env (qdrant/hindsight/kafka/redis) — eidos is the pare (b9f04dd)
- estate-ops: add detect-env.py — per-product env manifest generator (env/.env-first, secretsmith SSOT fallback) (654a2cf)
- thresher: fix config — dedupe azurite (grasp-hub rename created duplicate), rename grasp-hub->azurite, remove  (841ea2f)

## 2026-10-29
- chore: synchronize pen state after refactors and restructures (5f8b70b)
- fix(mcp): repoint squawk + hatch-mcp to products/ paths (9888180)
- fix(pitchfork): complete daemon-path reconciliation post five-shape reorg (5dedfc9)
- fix(pitchfork): mass-repoint daemon paths post five-shape pen reorg (a9f8f6d)
- fix(barn): untrack gitlinked products + ignore products/ and archive/ (submoduleless doctrine) (e02e831)
- refactor(barn): complete five-shape reorg — products -> products/, litter -> archive/ (09f15f2)
- fix(scaffold): move snapshot outside pen root to avoid cp -al recursion + fix copy args (84095da)
- chore(scaffold): add missing LICENSE (five-shape conformance) (a3534d6)
- feat(scaffold): maximally non-destructive apply — dry-run default, snapshot, moves-only (97c4c27)

## 2026-10-28
- fix(sync): default clone root to pens SSOT (single-truth lease) (6aedb4f)
- refactor(barn): align ports.env with rig cutover + manifest (11b1c91)
- refactor(secretsmith): retire monorepo copy — master lives at pens/olympus/products/kryptos (5b9faa3)
- reconcile(estate): ESTATE_ROOT default -> pens/estate (mirror ops fix) (495d58e)
- bin(estate-ops): morphe manifest target -> pens/estate/bridge/morphe.py (3c151d5)
- audit: kappa AGENTS.md injection — anomalies 48-50 (read-tool stacking, mirror wall, 10K-token wall) (7e7e1a1)
- chore: fold WIP (manifest regen, gemini-mcp) into main (rule 1b) (d561c6a)
- scaffold: Bun-1.4 native conversions (readme-gen/make-pen/manifest-gen — no sync node:fs, import.meta.dir), gu (1d6d9a1)
- estate-ops: bin-verify ~/.local/bin link-name expansion (was double-joining SOV); register declared links in s (606a32c)
- estate-ops: pixel fast-bridge CLI (openshot/connect/tap/ui, zero fixed sleeps) (7f4357b)

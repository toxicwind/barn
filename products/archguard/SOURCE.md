# barn/archguard — provenance

In-tree import of **toxicwind/archguard** (the canonical toxicwind fork of
SKfaizan-786/ArchGuard), pinned at upstream tip:

- **Pinned SHA:** `9f925e65709f1b2b074b74948fe503cdc8ea5d84` ("Update demo video badge duration in README")
- **Imported:** 2026-10-20, via `git archive <SHA>` from the Phase-1 scratch clone
  (`/home/toxic/kite/forge-archguard-p1/archguard`) — tracked files only, byte-exact.
- **Reference mechanism:** in-tree directory, mirroring how ranch references
  `barn/thresher` (one-directory-per-component, owning-repo rule; ranch README
  contract). Not a gitlink: the Pens seed, ADR nodes, and pitchfork wiring are
  Pens-specific and live here; genuine fork fixes go to the toxicwind/archguard
  fork, never to an upstream.

## Update procedure (pin refresh)

1. `gh repo clone toxicwind/archguard /tmp/archguard-upd && cd /tmp/archguard-upd`
2. `git fetch origin && git log -1 origin/main` — record the new SHA.
3. `git archive <NEW_SHA> | tar -x -C /home/toxic/pens/Pens/ranch/barn/archguard`
4. Re-apply Pens files (this file, `src/scripts/seedEstate.ts`, `seed:Pens`
   npm script) if the archive overwrote them.
5. `npx tsc --noEmit`, re-run `npm run seed:Pens` + the Phase-3 proof, commit,
   push, ls-remote verify. Update the pinned SHA above.

## Pens additions (not in the fork)

- `src/scripts/seedEstate.ts` — Pens seed graph (`archguard_estate`): real
  services/ports/daemons from Pens pitchfork.toml + live `ss` (verified
  2026-10-20), and ADR nodes EST-001..EST-004 from Chris's standing rulings.
- `seed:Pens` npm script: `tsx src/scripts/seedEstate.ts`.
- Phase-1 evidence: `/home/toxic/kite/forge-archguard-p1/EVIDENCE.md`
  (deterministic-audit proof, fork pristine at this SHA — no fork changes needed).
- Phase 2/3 evidence: `/home/toxic/kite/forge-archguard-p1/PHASE2-3.md`.

No LLM keys are ever required: extractor/advisor fall back to deterministic
synthesizers, and the Auditor agent is Cypher-only by construction.

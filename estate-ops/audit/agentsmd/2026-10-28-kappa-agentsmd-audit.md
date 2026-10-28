# kappa AGENTS.md injection audit — 2026-10-28 (kappa session, live-verified)

## Anomaly 48: read-tool nested-wall stacking
`instruction.ts:152` — system-prompt path takes FIRST ancestor match only ("so we
don't stack AGENTS.md from every ancestor"). But the READ tool's context
injection stacks EVERY ancestor AGENTS.md unconditionally. Live proof: reading
`packages/cli/src/session/instruction.ts` injected 4 walls in one turn
(kappa-code/AGENTS.md [Kilo-named], packages/cli/AGENTS.md, pens/olympus/AGENTS.md,
pens/AGENTS.md). ~15KB of unrelated monorepo docs per file read.

## Anomaly 49: global wall mirror = two truths
`/home/toxic/AGENTS.md` and `/home/toxic/estate/AGENTS.md` are md5-IDENTICAL
(4b4340bce4daa30f8209050505a7e7bb), 39,355 bytes ≈ ~10K tokens. When cwd=/home/toxic,
kappa injects the working-dir wall; the mirror makes edits drift-prone. Violates
estate's own "TWO TRUTHS ARE A BUG".

## Anomaly 50: wall size
The standing-rules wall (3 anomaly programs × full tables, fleet receipts, layout
doctrine ×3 duplicated sections) is ~10K tokens injected EVERY session/turn. No
vector recall, no lazy loading. Docs-mcp/qdrant (25133) + hindsight (25117) exist
on-box and are the intended fix: agents should RETRIEVE rules, not carry walls.

## Injection chain (verified in kappa-code source)
1. `~/.config/kappa/AGENTS.md` (global, trusted) — 7,537 bytes
2. First ancestor AGENTS.md/CLAUDE.md/CONTEXT.md from cwd → worktree (first-match-wins)
3. `config.instructions` from kappa.jsonc (currently empty {})
4. READ-tool: stacks ALL ancestor AGENTS.md (bug, anomaly 48)

## Verdict on "default poisoning"
No hidden default kappa agents.md found. The poison is ARCHITECTURAL: (a) read-tool
stacking, (b) mirror duplication, (c) 10K-token wall with no vector retrieval layer.

## Fixes (forward commits)
- estate-ops: this audit + preprobe script (committed)
- kappa-code: read-tool should use first-match-wins like the system path
- qdrant: index all AGENTS.md corpus → collection agentsmd_corpus, recall tool for agents

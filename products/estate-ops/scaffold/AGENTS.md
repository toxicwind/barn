# AGENTS.md — <PEN_NAME> (pens/<PEN_NAME>)

> **Part of the olympus/barn/ranch pens family.** A pens repo is a **thin
> coordinator**, not a product monorepo. It owns only its own metadata + `bin/`
> symlink surface. Products are peer standalone checkouts, referenced not owned.

## This repo is submoduleless by design

There are **no submodules** here. The repo's `.gitignore` is the kitchen-sink:

```
*
!.gitignore
!README.md
!LICENSE
!package.json
!mise.toml
!AGENTS.md
!bin/
!bin/**
```

- `*` ignores everything → any product checkout dropped into the repo is
  auto-ignored. No `git submodule add`, no gitlinks (mode 160000), no nested
  `.git` pollution in the index.
- Only the repo's own thin metadata + `bin/**` are tracked.
- Products are **peer clones** under `pens/` (e.g. `pens/barn/weave`, not
  `pens/barn/<repo>/weave`). `~/.local/bin` symlinks point at them; the
  product's manifest entry (via `estate-ops/bin/manifest.yaml`) documents the
  link. `bin-verify.sh` enforces it.

## Standing rules (from estate AGENTS.md)

1. **Products own their entrypoints; bins only point at them.** Real scripts
   live in the product; `pens/<PEN_NAME>/bin/*` is a thin owned surface.
2. **`~/.local/bin` is the one PATH surface.** Every product link there is a
   symlink; never a second copy. The manifest pins it — a broken link is FAIL.
3. **Secrets live in the secretsmith keyring** (SSOT). This repo's
   `.secrets*` are ignored; never commit them.
4. **No hardcoded product paths inside shims.** Resolve through the manifest
   or `pens/`, never a literal absolute path.
5. **The estate is additive-only**: never remove a peer/product/daemon without
   an explicit order.
6. **`pens/barn/estate-ops/ssot-scaffold.sh`** is the SSOT-consolidation
   helper — feeds this product's config into `estate/config/<PEN_NAME>` as SSOT.

## How a new product joins this pens repo

1. Clone the product next to this repo: `~/.../pens/<PEN_NAME>/<product>`.
   It is auto-ignored by `*` — nothing to register.
2. Symlink its entrypoint into `~/.local/bin/<product>`.
3. Run `bin/manifest-sync.sh` (or root `estate-ops/bin/manifest-gen.py`) to
   regenerate the manifest; `bin-verify.sh` must report 0 FAIL.

## Layout

```
pens/<PEN_NAME>/
├── .gitignore   # kitchen-sink `*` whitelist (submoduleless doctrine)
├── README.md
├── LICENSE
├── package.json
├── mise.toml
├── AGENTS.md
├── bin/         # <PEN_NAME> owned entrypoints, symlinks, or thin shims
└── <product>/   # peer standalone checkout — IGNORED, not a submodule
```

## The resident rig (Harvest Moon law — EVERY pen has one)

Every pen is a farmstead with a RESIDENT RIG — a fleet-joined OpenFang agent
that IS the pen's interface, plus squawk presence. The pen is not "done"
without its villager.

1. **Join the rig** (idempotent):
   ```bash
   bun /home/toxic/pens/ranch/squawk/join/fleet-join.ts \
     --name <rig-name> --species <species> \
     --personality "<persona, concrete, no roleplay fluff>" \
     --lane <pen>-ops --task "<the pen's duty>" --sigil <emoji>
   ```
   Renders estate/agents/<name>/agent.toml + system.md + ~/.openfang/agents/.
2. **Day-cycle**: schedule the rig with `rig cron create <name> <cron-spec>
   "<one-turn prompt>"` — stagger minutes across rigs so the village murmurs,
   never choruses. NO bespoke sidecar clocks: the rig runtime IS the scheduler.
3. **Squawk presence**: the rig narrates milestones in the fleet room
   ([name]: [status]); DM-to-rig for direct tasking.
4. **Model lane**: the rig's [model] block routes through the estate routers
   (herd :25100 / rhodochrosite :25193) — never a hardcoded provider URL.
5. **Dashboard**: the rig is visible on the Rig Dashboard (:25196).

Current residents: geode (ranch), hephaistos+ergane+hestia (ergasterion),
skopos/muse/keryx/kryptos/kairos (olympus), tack (barn), tau (the mountain).

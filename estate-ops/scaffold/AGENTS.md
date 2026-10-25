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

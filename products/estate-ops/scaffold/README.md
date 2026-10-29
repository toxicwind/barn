# <PEN_NAME>

One of the pens family (`pens/{barn,olympus,ranch,<PEN_NAME>}`). Holds a
curated collection of products. Submodule-LESS: peer products are standalone
checkouts, referenced-not-owned.

## Products

| Product | Subdir | Notes |
|---|---|---|
| <product-a> | `<product-a>/` | ... |
| <product-b> | `<product-b>/` | ... |

## Tooling

- **bin surface**: entrypoints symlinked into `~/.local/bin` (see
  `pens/barn/estate-ops/bin/manifest.yaml`).
- **SSOT config**: import via `pens/barn/estate-ops/ssot-scaffold.sh`.
- **add a new pens repo**: copy this scaffold → `pens/<name>/`
  (`scaffold/apply.sh <name>`), replace `<PEN_NAME>` placeholders, commit.

## Naming

- Greek codename lineage (tau, kappa, skopos, hodos, keryx, ...) joins
  `olympus`; ops tooling joins `barn`; fleet/model components join `ranch`.

# barn — the utility pen

Small single-purpose utilities that keep the ranch running. Each sub-component
has its own stack and its own lane; this directory is the pen, not a project.

| Component | Stack | Check |
|---|---|---|
| gatehouse | Go | `go build ./...` |
| secretsmith | Python | `python -m unittest discover -s tests` (12 tests) |
| gemini-mcp | Python | `py_compile server.py` |
| lookout | TOML | `tomllib` parse of `pitchfork.fragment.toml` |
| chute | Node | `node --check chute.mjs` |
| browserless | TypeScript | own lane (needs npm install + a live server) |

## Build

`scripts/mise-build.sh` is the main build entry. It submits the native
build+test above directly through mise,
streams the job log, and exits 0 on success:

```sh
./scripts/mise-build.sh
```

# batcorp

Projects by Shubham Yadav ([@batmnnn](https://github.com/batmnnn)).

| Path | What |
|---|---|
| [`framelab/`](framelab/) | FrameLab: a release-check workbench for frame-transaction (EIP-8141) alt-mempool nodes. Built at ETHGlobal Mumbai 2026 |
| [`docs/framelab-spec.md`](docs/framelab-spec.md) | FrameLab's product spec, build plan and measured results |
| `.github/workflows/framelab.yml` | Runs FrameLab's acceptance suite on every change under `framelab/` |

FrameLab was first developed as its own repository. Its history is merged here with the original
commit IDs, so `git show d2d3bec` and the `v0.1-rc` tag resolve as recorded.

`vendor/` holds pinned upstream clones and is not committed; `framelab/scripts/setup-vendor.sh`
recreates it. Each project carries its own license.

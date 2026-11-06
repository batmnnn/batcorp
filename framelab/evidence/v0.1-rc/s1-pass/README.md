# FrameLab bundle: s1-payer-drop

Original scenario `s1-payer-drop`: **PASS** (exit 0) on sidecar build `observe`, two fresh runs.

| Assertion | Rule | Expected | Observed | Verdict |
|---|---|---|---|---|
| S1-A1 | SP-BAL-ENFORCE | pending | pending | PASS |
| S1-A2 | SP-BAL-ENFORCE | pending | pending | PASS |
| S1-A3 | SP-BAL-ENFORCE | evicted | evicted | EXPECTED_INVALIDATION |
| S1-A4 | SP-BAL-ENFORCE | evicted | evicted | EXPECTED_INVALIDATION |
| S1-A5 | SP-BAL-ENFORCE | pending | pending | PASS |

No shrink ran for this bundle; there is no scenario.min.yaml.

## Replay

Prerequisites: macOS or Linux on arm64, Docker, Bun 1.3, a FrameLab checkout (bundle made at `d2d3beca038e6136976546e69d5d9bfb98e655a8`) with `../vendor/sidecar` at `2e22ff0a2898e69ea4bf5275bce1be8581a8582a`, and the local ethrex image `framelab/ethrex:9aa3645d-arm64-release-fast` built from `9aa3645d795945c64400f41a70aace0edfa7f383` (recorded image ID `sha256:ee5838be22d4074cb13c820a472cf59bbbacc7698532ec3c5851a3d061d157f6`).

```
FRAMELAB=/path/to/framelab ./replay.sh
```

`replay.sh` checks `SHA256SUMS`, checks pins, runs `scenario.original.yaml` twice on a fresh local chain and sidecar, then compares with this bundle. Expected exit: 0. Everything binds to 127.0.0.1; no public network is used. Replay output goes to `$FRAMELAB/.runs/` (or `$FRAMELAB_REPLAY_OUT`), never into this folder.

## Known limits

- Results apply to this pinned local build and config only, not to the public network or other clients.
- The two runs are a consistency check, not proof of determinism. Replay is a new execution.
- A PASS covers the assertions run, not the whole client.
- A mismatch means the observed fate differs from this scenario's written expectation under the cited rule. On its own it does not show a node bug: the expectation can be wrong.
- The sidecar runs with `patches/sidecar-observe.patch`, which only logs reconcile pass completion.

## Keys

All keys in this bundle and its scenario are PUBLIC TEST-ONLY: actor keys derive from the scenario seed, and the funder and relayer keys are public ethrex dev keys. Never fund or use them on any other network. Engine JWT secrets are per-run and are not exported.

## Credits

FrameLab is MIT-licensed. It includes frame-transaction helpers extracted from Etherspot's MIT-licensed sidecar (see NOTICE in the FrameLab repo). It runs ethrex (MIT and Apache-2.0 license files in its repo) and the Etherspot sidecar (MIT) as local dependencies. The only changes to them are the labelled patches in `patches/`.

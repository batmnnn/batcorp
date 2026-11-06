# FrameLab bundle: s1-noisy

> **LOCAL INJECTED REGRESSION.** This bundle was produced on a sidecar build with `patches/inject-s1-oldest-first.patch` (sha256 `7b0635ddfd30…`) applied on purpose. The mismatch below demonstrates FrameLab; it is not an upstream bug.

Original scenario `s1-noisy`: **FAIL** (exit 1) on sidecar build `inject-s1`, two fresh runs.

| Assertion | Rule | Expected | Observed | Verdict |
|---|---|---|---|---|
| S1-A1 | SP-BAL-ENFORCE | pending | evicted | WRONGLY_EVICTED |
| S1-A2 | SP-BAL-ENFORCE | pending | evicted | WRONGLY_EVICTED |
| S1-A3 | SP-BAL-ENFORCE | evicted | pending | STALE_KEPT |
| S1-A4 | SP-BAL-ENFORCE | evicted | pending | STALE_KEPT |
| S1-A5 | SP-BAL-ENFORCE | pending | pending | PASS |

Shrink target: `S1-A1` WRONGLY_EVICTED on `tx1` under `SP-BAL-ENFORCE`.

Smallest found: 7 steps (2 setup, 4 action, 1 checkpoint) from 18. 2 permitted single deletions of the final step set were tested: 0 did not reproduce, 2 unresolved. Not shown to be 1-minimal. Not a global minimum.

Reduced case `scenario.min.yaml` (hash `334f0293d8ec…`), final confirmation on two fresh runs: interesting.
- run 1: interesting (S1-A1 WRONGLY_EVICTED)
- run 2: interesting (S1-A1 WRONGLY_EVICTED)
- removed S1-A3: preconditions measured false on both runs; re-judged FAIL, S1-A1 WRONGLY_EVICTED / FAIL, S1-A1 WRONGLY_EVICTED

Removed from the reduced case because their preconditions no longer hold there: S1-A3. No expected fate was edited.

## Replay

Prerequisites: macOS or Linux on arm64, Docker, Bun 1.3, a FrameLab checkout (bundle made at `d2d3beca038e6136976546e69d5d9bfb98e655a8`) with `../vendor/sidecar` at `2e22ff0a2898e69ea4bf5275bce1be8581a8582a`, and the local ethrex image `framelab/ethrex:9aa3645d-arm64-release-fast` built from `9aa3645d795945c64400f41a70aace0edfa7f383` (recorded image ID `sha256:ee5838be22d4074cb13c820a472cf59bbbacc7698532ec3c5851a3d061d157f6`).

```
FRAMELAB=/path/to/framelab ./replay.sh
```

`replay.sh` checks `SHA256SUMS`, checks pins, runs `scenario.min.yaml` twice on a fresh local chain and sidecar, then compares with this bundle. Expected exit: 1. Everything binds to 127.0.0.1; no public network is used. Replay output goes to `$FRAMELAB/.runs/` (or `$FRAMELAB_REPLAY_OUT`), never into this folder.

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

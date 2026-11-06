# FrameLab

A release-check workbench for frame-transaction (EIP-8141) alt-mempool nodes.

Write down what should happen to pending frame transactions when the chain changes. FrameLab runs
the sequence twice on a pinned local node and judges expected against actual at each checkpoint.
It shrinks a mismatch to the smallest replayable case it can confirm, exports the case as a
bundle, and reruns it after a fix. The first target is the ERC-8421 workshop sidecar (Skandha fork)
on ethrex.

Built during ETHGlobal Mumbai 2026 (Classic track) for the EF prize "Best use of the Frame
Transaction Alternative Mempool". The design, decisions and measured results are in
[`../docs/framelab-spec.md`](../docs/framelab-spec.md).

**Status: `v0.1-rc`.** The §11 acceptance suite met 54 of 54 checks on the tagged commit `d2d3bec`
([summary](evidence/v0.1-rc/acceptance-summary.tsv)). CI reruns it on every push on linux/amd64
with the published ethrex image; the first green run met 54 of 54
([run 42181113803](https://github.com/batmnnn/batcorp/actions/runs/42181113803)). A qualifying
frame tx is on chain on the public devnet ([below](#public-devnet)).

## What a run shows

The scenario S1 funds a payer, which queues four keyed self-paid frame transactions, and an
unrelated control account queues one more. A normal transaction then drains the payer until only
2.5 times one frame tx's maximum cost is left. Under the sidecar's written policy
(SP-BAL-ENFORCE), the newest two (tx3, tx4) must be evicted, while tx1, tx2 and the control must
stay. FrameLab checks this once the sidecar reports its reconcile pass for the trigger block.
From the freeze run, with the payer's address shortened:

```
$ bun src/cli.ts run scenarios/s1-payer-drop.yaml
run 2: PASS (5/5 executed, reset 2189 ms, wall 11205 ms)
S1-A1      PASS                   expected pending, observed pending  (raw New)
S1-A2      PASS                   expected pending, observed pending  (raw New)
S1-A3      EXPECTED_INVALIDATION  expected evicted, observed evicted  (raw Cancelled); node reason: 0x0361…70C1 can no longer cover its pending frame transactions as of block 2
S1-A4      EXPECTED_INVALIDATION  expected evicted, observed evicted  (raw Cancelled); node reason: 0x0361…70C1 can no longer cover its pending frame transactions as of block 2
S1-A5      PASS                   expected pending, observed pending  (raw New)
PASS (exit 0)
```

An expected eviction is green. Only a removal that the cited rule does not allow is a failure.

The fail-and-fix loop uses a deliberately injected local regression, never an upstream bug:
[`patches/inject-s1-oldest-first.patch`](patches/inject-s1-oldest-first.patch) reverses the
eviction order. On that build, `s1-noisy` (S1 plus ten removable noise steps) fails at S1-A1
(`WRONGLY_EVICTED`) on both runs. `shrink` reduces it from 18 to 7 steps and confirms the result
on two fresh runs. The same reduced case passes on the unpatched build, and `compare` reports
`WRONGLY_EVICTED -> PASS` with the scenario and rule pack unchanged.

## Setup

Needs Docker, Bun 1.3.14 and git, on Linux amd64 or macOS arm64.

```sh
cd framelab
bun install
scripts/setup-vendor.sh   # pinned sidecar and ethrex fixtures into ../vendor (not committed)
```

The node image depends on the platform:

- **Linux amd64:** use the published image of the pinned commit.
  ```sh
  export FRAMELAB_ETHREX_IMAGE=ghcr.io/forshtat/eip8141-devnet@sha256:c9a7770f892e02255999e1c0ffd596ecee704d9175c2480811ccdcfa1c2224c6
  docker pull "$FRAMELAB_ETHREX_IMAGE"
  ```
- **Apple Silicon:** the published image does not start under Rosetta, so build the same commit
  natively:
  ```sh
  FULL_ETHREX=1 scripts/setup-vendor.sh
  docker build -t framelab/ethrex:9aa3645d-arm64-release-fast --build-arg PROFILE=release-fast ../vendor/ethrex
  ```

The sidecar is built from the pinned commit, with the FrameLab patches applied, on first use.

## Commands

| Command | Does |
|---|---|
| `run <scenario>` | Two fresh runs on a new stack, then verdicts. `--patch` builds the sidecar with a patch |
| `shrink <scenario>` | Run, then reduce the first mismatch; budget, cache and stop reason are recorded |
| `export <dir>` | Bundle a run or shrink: file allowlist, secret scan, checksums, `replay.sh` |
| `check-pins <bundle>` | Compare a bundle's node, rule and patch pins with this checkout |
| `compare <old> <new>` | Same scenario and rule pack across two node builds |
| `serve` | Local UI at `http://127.0.0.1:4173`: start the network, run, shrink, cancel, export |
| `env` | Start the pinned stack once and report capabilities |
| `devnet` | Send one qualifying frame tx to the public devnet (see below) |

Run commands as `bun src/cli.ts <command>`. Exit codes are `0` for a complete, consistent pass,
`1` for a confirmed mismatch, and `2` for anything incomplete, inconsistent or not applicable.
Per-assertion classes are `PASS`, `EXPECTED_INVALIDATION`, `STALE_KEPT`, `WRONGLY_EVICTED`,
`ASSERTION_MISMATCH` and `INCONCLUSIVE`. A missing checkpoint, a pass timeout, a sidecar restart,
disagreeing runs or zero reached assertions never produce a pass.

`scripts/acceptance.sh` reruns the whole §11 suite and writes `summary.tsv` itself. The freeze
run took 6.5 minutes on an Apple Silicon Mac.

## Evidence from the freeze run

[`evidence/v0.1-rc/`](evidence/v0.1-rc/) holds two bundles exported by the `v0.1-rc` suite run:

- `injected-s1-reduced`: the 7-step reduced case on the injected build (FAIL, exit 1)
- `s1-pass`: a fresh S1 pass (exit 0)

Replay either without the UI. The output goes to `.runs/`, outside the bundle:

```sh
FRAMELAB=$PWD evidence/v0.1-rc/injected-s1-reduced/replay.sh   # exit 1, as recorded
```

`replay.sh` checks `SHA256SUMS` and the pins before starting a node, and refuses a changed
bundle with exit 2.

## Hosted read-only copy

<https://batcorps.batmnnn.live/> serves the two bundles above in the same viewer, read only.
Nothing runs there, `.runs/` is never served and every write is refused. A link such as
[`?b=bundles/injected-s1-reduced`](https://batcorps.batmnnn.live/?b=bundles/injected-s1-reduced)
opens one bundle directly, and Download gives a `.tar.gz` that `replay.sh` replays on your own
machine.

Publishing makes a bundle public. `scripts/publish-bundle.ts` refuses a bundle unless every file
matches `SHA256SUMS`, nothing is unlisted, and the export's secret scan comes back clean again:

```sh
bun scripts/publish-bundle.ts bundles/NAME --dry-run   # checks only
bun scripts/publish-bundle.ts bundles/NAME             # uploads, prints the share link
bun scripts/publish-bundle.ts --remove NAME
```

`deploy/azure/deploy.sh` creates or updates the deployment in resource group `rg-framelab`: a
Container App that scales to zero, an Azure Files share mounted read-only, and a Basic registry.
It rolls the app to an image of the current commit. `az group delete -n rg-framelab` removes it
all.

## A VM of your own

<https://lab.batcorps.batmnnn.live/> gives anyone with a GitHub account a fresh Linux VM
(4 vCPU, 16 GB) with FrameLab set up from `main`, for 3 hours. You log in with the SSH keys
on your GitHub account, `ssh judge@ADDRESS`, and run the replays above or `bun src/cli.ts serve`
through `ssh -L 4173:127.0.0.1:4173`. Sign-in asks GitHub for no scopes; the token is used once
to read your account and then revoked.

Limits: 3 VMs at a time, one per account, 2 per account and 12 in all per UTC day, and accounts
must be at least 30 days old. A VM takes inbound SSH only, can reach only TCP 80 and 443, and
cannot reach the other VMs. It carries no Azure identity or secret. A reaper job deletes it at
expiry, and the VM powers itself off 10 minutes later in case the reaper does not run.

`deploy/azure/deploy-lab.sh` deploys it next to the hosted copy, with the VMs in their own
resource group `rg-framelab-vms` that the lab's identity alone can change.
`deploy/azure/lab-github.sh` connects the GitHub OAuth app; it reads the client secret without
echoing it.

## Public devnet

`bun src/cli.ts devnet` is the only command that touches a public network. It first reads chain
1337, the ethrex commit (which must match the encoder's pin) and the head block's age, and
refuses if the chain is not producing blocks. It then sends at most two transactions:

1. one transfer that funds a new throwaway key from the genesis account that the operators
   publish on purpose (the key is checked against the documented address)
2. one self-paid frame tx through the sidecar's `eth_sendFrameTransaction`, followed to `OnChain`

Every RPC method it may call is on an allowlist, so admin and privileged-submit methods cannot
be called. The throwaway key lives in `~/.framelab/`, outside the checkout, and bundle export
treats it as a secret. `--dry-run` sends nothing. CI runs the same code path against the local
stack (`src/gates/devnet-local.ts`).

**Result (2026-11-06, 07:06 UTC):** frame tx
[`0xd0585cf5…0814`](https://explorer.altmempool.wtf/tx/0xd0585cf5ee9e6a599d206c6f2acdcafc62e5e73e6c65cc67acaf4877c0eb0814?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc)
went from admitted by the public sidecar to `OnChain` in block 378. The ethrex receipt shows type
`0x6`, status `0x1` and 26,102 gas, and the explorer's admission report shows every rule passed.
The devnet can be reset and the explorer keeps history in memory only, so the record, the raw RPC
log and a screenshot are kept in [`evidence/devnet-2026-11-06/`](evidence/devnet-2026-11-06/).

## Safety and limits

- Checks run only on a disposable local chain, with debug RPC bound to 127.0.0.1.
- Actor keys derive from the scenario seed, and the funder and relayer keys are public ethrex dev
  keys. All of them are **public test-only keys**: never fund or use them on another network.
- A bundle passes an allowlist and a secret scan. A clean scan is not proof that no secret is
  present.
- The oracle is a human reading of a cited policy. Rule quotes are checked verbatim against the
  pinned source, but the oracle is reviewable, not proved. A pass covers the assertions run on the
  pinned build and config, not the whole client or the public network.
- The shrink result is the smallest case found, not a proven minimum.
- Known open issue: once on CI, a shrink candidate's fresh sidecar did not report its first
  reconcile pass within 15 s. The shrink stopped with exit 2, not a verdict. It has not recurred
  locally or on CI, and its cause is not yet known.

## License

MIT (see [`LICENSE`](LICENSE)). `src/vendor/sidecar/` holds helpers extracted from the ERC-8421
Mempool Sidecar (MIT, Etherspot); details are in [`NOTICE`](NOTICE). Dependencies: viem, yaml,
ajv, @ethereumjs/rlp.

/**
 * Cloud-init for a judge VM. The VM gets no Azure identity and no secret: it clones the public
 * repository, sets FrameLab up as the CI job does, and proves the setup with the s1-pass replay
 * before it reports ready on its serial console.
 */
export const ETHREX_IMAGE = "ghcr.io/forshtat/eip8141-devnet@sha256:c9a7770f892e02255999e1c0ffd596ecee704d9175c2480811ccdcfa1c2224c6";
export const READY_MARK = "FRAMELAB_SETUP_READY";
export const FAILED_MARK = "FRAMELAB_SETUP_FAILED";

const KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** GitHub serves `<login>.keys` as one bare key per line; anything else is dropped. */
export function sshKeys(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().split(/\s+/).slice(0, 2).join(" "))
    .filter((l) => l.length < 16_384 && KEY.test(l))
    .slice(0, 10);
}

const indent = (text: string, n: number) => text.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

export function judgeCloudInit(o: { keys: string[]; expiresAt: Date; repo: string; ref: string }): string {
  if (!o.keys.length) throw new Error("no usable SSH key");
  for (const k of o.keys) if (!KEY.test(k)) throw new Error("not an SSH public key");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(o.repo) || !REF.test(o.ref)) throw new Error("bad repository or ref");
  const until = o.expiresAt.toISOString().replace(/\.\d+Z$/, "Z");
  // Powers the VM off shortly after expiry even if the reaper never runs; deleting it is the reaper's job.
  const backstopMinutes = Math.max(15, Math.ceil((o.expiresAt.getTime() - Date.now()) / 60_000) + 10);

  const setup = `#!/usr/bin/env bash
# Runs once as judge, from cloud-init. Same steps as the CI job.
set -euo pipefail
exec >>"$HOME/framelab-setup.log" 2>&1
trap 'echo "setup failed at line $LINENO"' ERR
echo "setup started $(date -u +%FT%TZ)"
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH" FRAMELAB_ETHREX_IMAGE="${ETHREX_IMAGE}"
git clone --depth 1 --branch "${o.ref}" "${o.repo}" "$HOME/batcorp"
cd "$HOME/batcorp/framelab"
bun install --frozen-lockfile
scripts/setup-vendor.sh
docker pull "$FRAMELAB_ETHREX_IMAGE"
echo "warm-up: replaying evidence/v0.1-rc/s1-pass (builds the sidecar; must exit 0)"
FRAMELAB="$PWD" evidence/v0.1-rc/s1-pass/replay.sh
echo "setup done $(date -u +%FT%TZ)"
`;

  const status = `#!/usr/bin/env bash
# Waits for setup to finish, showing the latest log line.
log="$HOME/framelab-setup.log"
while ! grep -q "^setup done" "$log" 2>/dev/null; do
  if grep -q "^setup failed" "$log" 2>/dev/null; then echo; echo "Setup failed. The log is $log:"; tail -n 30 "$log"; exit 1; fi
  printf '\\r\\033[K%s' "$(tail -n 1 "$log" 2>/dev/null | cut -c1-100)"
  sleep 3
done
printf '\\r\\033[KFrameLab is set up in ~/batcorp/framelab\\n'
`;

  const motd = `
FrameLab judge VM. It is deleted automatically at ${until}.

  framelab-status              wait for setup to finish (about 10 minutes after boot)
  cd ~/batcorp/framelab

  FRAMELAB=$PWD evidence/v0.1-rc/injected-s1-reduced/replay.sh   # exit 1, as recorded
  FRAMELAB=$PWD evidence/v0.1-rc/s1-pass/replay.sh               # exit 0
  bun src/cli.ts serve         # the UI, on 127.0.0.1:4173 of this VM

For the UI, reconnect with a tunnel and open http://127.0.0.1:4173 on your machine:
  ssh -L 4173:127.0.0.1:4173 judge@<this VM's address>

Only TCP 80 and 443 go out from here. Nothing on this VM is kept.
`;

  return `#cloud-config
packages: [unzip]
write_files:
  - path: /etc/profile.d/framelab.sh
    permissions: "0644"
    content: |
      export PATH="$HOME/.bun/bin:$PATH"
      export FRAMELAB_ETHREX_IMAGE="${ETHREX_IMAGE}"
  - path: /etc/motd
    permissions: "0644"
    content: |
${indent(motd, 6)}
  - path: /usr/local/bin/framelab-setup
    permissions: "0755"
    content: |
${indent(setup, 6)}
  - path: /usr/local/bin/framelab-status
    permissions: "0755"
    content: |
${indent(status, 6)}
  - path: /home/judge/.ssh/authorized_keys
    owner: judge:judge
    permissions: "0600"
    append: true
    defer: true
    content: |
${indent(o.keys.join("\n"), 6)}
runcmd:
  - [shutdown, -h, "+${backstopMinutes}", "FrameLab judge VM: time is up"]
  - [bash, -c, "chmod -x /etc/update-motd.d/* || true"]
  - [bash, -c, "curl -fsSL https://get.docker.com | sh"]
  - [usermod, -aG, docker, judge]
  - [bash, -c, "if su - judge -c /usr/local/bin/framelab-setup; then echo ${READY_MARK} > /dev/ttyS0; else echo ${FAILED_MARK} > /dev/ttyS0; fi"]
`;
}

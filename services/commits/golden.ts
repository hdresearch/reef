import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { VersClient } from "@hdresearch/pi-v/core";
import type { CommitRecord, CommitStore } from "./store.js";

const DEFAULT_GOLDEN_VM_CONFIG = {
  vcpu_count: 2,
  mem_size_mib: 4096,
  fs_size_mib: 8192,
};

const DEFAULT_PUNKIN_RELEASE_TAG = "w/router";

export interface EnsureGoldenResult {
  commitId: string;
  vmId?: string;
  label?: string;
  created: boolean;
  source: "env" | "store" | "created";
  record?: CommitRecord;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function deriveRootBaseUrl(): string {
  if (process.env.VERS_INFRA_URL) return process.env.VERS_INFRA_URL;
  if (process.env.VERS_VM_ID) return `https://${process.env.VERS_VM_ID}.vm.vers.sh:${process.env.PORT || "3000"}`;
  return `http://127.0.0.1:${process.env.PORT || "3000"}`;
}

function resolveSourcePath(label: string, candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate local ${label} source for golden image bootstrap`);
}

async function localApi(method: string, path: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (process.env.VERS_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.VERS_AUTH_TOKEN}`;
  }

  const response = await fetch(`${deriveRootBaseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Local API ${method} ${path} failed (${response.status}): ${text}`);
  }
}

async function registerGoldenRecord(vmId: string, commitId: string, label: string): Promise<void> {
  const metadata = {
    commitId,
    label,
    kind: "golden-image",
    createdBy: process.env.VERS_AGENT_NAME || "reef",
  };

  try {
    await localApi("POST", "/registry/vms", {
      id: vmId,
      name: label,
      role: "golden",
      address: `${vmId}.vm.vers.sh`,
      registeredBy: "commits-service",
      metadata,
    });
    await localApi("PATCH", `/registry/vms/${encodeURIComponent(vmId)}`, {
      status: "stopped",
      metadata,
    });
  } catch {
    // Registry visibility is useful, but not required for the golden commit to exist.
  }
}

export function buildGoldenBootstrapScript(rootBaseUrl: string): string {
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

apt-get update -qq
apt-get install -y -qq curl git ca-certificates build-essential openssl unzip

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="/root/.bun/bin:$PATH"
fi

if [ -d /root/punkin-pi ]; then
  cd /root/punkin-pi
  git fetch --tags --force
else
  git clone https://github.com/hdresearch/punkin-pi.git /root/punkin-pi
  cd /root/punkin-pi
fi
PUNKIN_RELEASE_TAG=${shellQuote(DEFAULT_PUNKIN_RELEASE_TAG)}
if ! git rev-parse --verify -q "refs/tags/$PUNKIN_RELEASE_TAG" >/dev/null; then
  echo "Missing punkin-pi release tag: $PUNKIN_RELEASE_TAG" >&2
  exit 1
fi
git -c advice.detachedHead=false checkout --detach "refs/tags/$PUNKIN_RELEASE_TAG"
HUSKY=0 npm install
npm run build

cd /root/pi-vers
npm install
npm run build

cd /root/reef
bun install

for pkg_root in /root/pi-vers /root/reef; do
  mkdir -p "$pkg_root/node_modules/@mariozechner"
  ln -sfn /root/punkin-pi/packages/tui "$pkg_root/node_modules/@mariozechner/pi-tui"
  ln -sfn /root/punkin-pi/packages/coding-agent "$pkg_root/node_modules/@mariozechner/pi-coding-agent"
  ln -sfn /root/punkin-pi/packages/ai "$pkg_root/node_modules/@mariozechner/pi-ai"
  ln -sfn /root/punkin-pi/packages/agent "$pkg_root/node_modules/@mariozechner/pi-agent-core"
done

rm -rf /root/reef/services-active
mkdir -p /root/reef/services-active
for dir in /root/reef/services/*/; do
  svc=$(basename "$dir")
  ln -s "../services/$svc" "/root/reef/services-active/$svc"
done

mkdir -p /root/workspace /root/.punkin/agent /root/.pi/agent /etc/profile.d

if [ -x /root/punkin-pi/builds/punkin ]; then
  cat > /usr/local/bin/punkin <<'EOF'
#!/bin/sh
if [ -f /etc/profile.d/reef-agent.sh ]; then
  set -a
  . /etc/profile.d/reef-agent.sh
  set +a
fi
exec /root/punkin-pi/builds/punkin "$@"
EOF
elif [ -x /root/punkin-pi/packages/coding-agent/dist/cli.js ]; then
  chmod +x /root/punkin-pi/packages/coding-agent/dist/cli.js
  cat > /usr/local/bin/punkin <<'EOF'
#!/bin/sh
if [ -f /etc/profile.d/reef-agent.sh ]; then
  set -a
  . /etc/profile.d/reef-agent.sh
  set +a
fi
exec /root/punkin-pi/packages/coding-agent/dist/cli.js "$@"
EOF
fi
chmod +x /usr/local/bin/punkin 2>/dev/null || true
ln -sf /usr/local/bin/punkin /usr/local/bin/pi

cat > /etc/profile.d/reef-agent.sh <<ENVEOF
export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export VERS_INFRA_URL=${shellQuote(rootBaseUrl)}
${process.env.LLM_PROXY_KEY ? `export LLM_PROXY_KEY=${shellQuote(process.env.LLM_PROXY_KEY)}` : ""}
export PUNKIN_RELEASE_TAG=${shellQuote(DEFAULT_PUNKIN_RELEASE_TAG)}
export PUNKIN_BIN=punkin
export PI_PATH=punkin
export PI_VERS_HOME=/root/pi-vers
export SERVICES_DIR=/root/reef/services-active
export REEF_CHILD_AGENT=true
ENVEOF
chmod 0644 /etc/profile.d/reef-agent.sh

for shell_rc in /root/.profile /root/.bashrc /root/.zshenv; do
  touch "$shell_rc"
  if ! grep -q "reef-agent.sh" "$shell_rc"; then
    printf '\n[ -f /etc/profile.d/reef-agent.sh ] && . /etc/profile.d/reef-agent.sh\n' >> "$shell_rc"
  fi
done

set -a
source /etc/profile.d/reef-agent.sh
set +a

if command -v "$PI_PATH" >/dev/null 2>&1; then
  "$PI_PATH" install /root/pi-vers
  "$PI_PATH" install /root/reef
fi

test -x /usr/local/bin/pi
test -d /root/pi-vers
test -d /root/reef/services-active
`;
}

export async function ensureGoldenCommit(
  store: CommitStore,
  options: { force?: boolean; label?: string } = {},
): Promise<EnsureGoldenResult> {
  const envCommitId = process.env.VERS_GOLDEN_COMMIT_ID || process.env.VERS_COMMIT_ID;
  if (!options.force && envCommitId?.trim()) {
    return {
      commitId: envCommitId.trim(),
      label: options.label,
      created: false,
      source: "env",
    };
  }

  const existing = !options.force ? store.latestByTag("golden") : null;
  if (existing) {
    return {
      commitId: existing.commitId,
      vmId: existing.vmId,
      label: existing.label,
      created: false,
      source: "store",
      record: existing,
    };
  }

  const client = new VersClient();
  const label = options.label?.trim() || "reef-agent-golden";
  const reefDir = resolveSourcePath("reef", ["/opt/src/reef", "/opt/reef", process.cwd()]);
  const piVersDir = resolveSourcePath("pi-vers", [
    process.env.PI_VERS_HOME,
    "/opt/src/pi-vers",
    "/opt/pi-vers",
    resolve(process.cwd(), "..", "pi-vers"),
  ]);

  const builder = await client.createRoot(DEFAULT_GOLDEN_VM_CONFIG, true);
  const vmId = builder.vm_id;

  try {
    await client.uploadDirectory(vmId, reefDir, "/root/reef");
    await client.uploadDirectory(vmId, piVersDir, "/root/pi-vers");
    await client.execScript(vmId, buildGoldenBootstrapScript(deriveRootBaseUrl()));

    const committed = await client.commit(vmId, true);
    const record = store.record({
      commitId: committed.commit_id,
      vmId,
      label,
      agent: process.env.VERS_AGENT_NAME || "reef",
      tags: ["golden", "reef-agent"],
    });

    await registerGoldenRecord(vmId, committed.commit_id, label);
    try {
      await client.delete(vmId);
    } catch {
      // Commit is already durable; deletion is best-effort.
    }

    return {
      commitId: committed.commit_id,
      vmId,
      label,
      created: true,
      source: "created",
      record,
    };
  } catch (error) {
    try {
      await client.delete(vmId);
    } catch {
      // Ignore cleanup failure while surfacing the original error.
    }
    throw error;
  }
}

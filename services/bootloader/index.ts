/**
 * Bootloader service — manages VM bootstrapping with selective module loading.
 *
 * When a lieutenant spins up agent VMs, this service handles the boot flow:
 *   1. Prepare boot config (VM DNA: which modules + capabilities)
 *   2. Generate boot scripts for different VM types
 *   3. Track boot status and report to the VM tree
 *
 * VM Type Profiles:
 *   Full agent VM  — reef + all core + lieutenant + pi-vers
 *   Swarm worker   — reef + minimal (store, cron) + pi-vers
 *   Lightweight     — reef + minimal, no pi-vers (short-lived haiku sessions)
 *   Infra VM       — reef + core + specific service module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, ServiceModule } from "../../src/core/types.js";

// =============================================================================
// Types
// =============================================================================

export type VMType = "full" | "swarm" | "lightweight" | "infra";

export interface BootProfile {
  type: VMType;
  organs: string[];
  capabilities: string[];
  installPiVers: boolean;
  description: string;
}

export interface BootRequest {
  vmId: string;
  name: string;
  type: VMType;
  parentVmId?: string;
  extraOrgans?: string[];
  extraCapabilities?: string[];
  roofReefUrl?: string;
}

export interface BootResult {
  vmId: string;
  name: string;
  type: VMType;
  script: string;
  profile: BootProfile;
}

// =============================================================================
// VM Type profiles
// =============================================================================

const PROFILES: Record<VMType, BootProfile> = {
  full: {
    type: "full",
    organs: ["store", "cron", "lieutenant", "registry", "vm-tree", "vers-config", "docs", "installer"],
    capabilities: ["punkin", "vers-vm", "vers-vm-copy", "vers-swarm", "ssh"],
    installPiVers: true,
    description: "Full agent VM — all core modules + pi-vers. Can promote to lieutenant.",
  },
  swarm: {
    type: "swarm",
    organs: ["store", "cron"],
    capabilities: ["punkin", "vers-vm", "vers-vm-copy", "vers-swarm"],
    installPiVers: true,
    description: "Swarm worker — minimal reef + pi-vers for fleet task execution.",
  },
  lightweight: {
    type: "lightweight",
    organs: ["store"],
    capabilities: ["punkin"],
    installPiVers: false,
    description: "Lightweight worker — minimal reef, no pi-vers. For short-lived sessions.",
  },
  infra: {
    type: "infra",
    organs: ["store", "cron", "docs"],
    capabilities: [],
    installPiVers: false,
    description: "Infra VM — core reef + specific service. For Gitea, MinIO, persistent services.",
  },
};

// =============================================================================
// Boot script generation
// =============================================================================

function generateBootScript(req: BootRequest): string {
  const profile = { ...PROFILES[req.type] };

  // Merge extra organs and capabilities
  if (req.extraOrgans) {
    for (const o of req.extraOrgans) {
      if (!profile.organs.includes(o)) profile.organs.push(o);
    }
  }
  if (req.extraCapabilities) {
    for (const c of req.extraCapabilities) {
      if (!profile.capabilities.includes(c)) profile.capabilities.push(c);
    }
  }

  const roofUrl = req.roofReefUrl || process.env.VERS_INFRA_URL || "http://localhost:3000";

  return `#!/bin/bash
# Reef bootloader — auto-generated for ${req.name} (${req.type})
# VM ID: ${req.vmId}
# Parent: ${req.parentVmId || "none"}
# Profile: ${profile.description}
set -e

echo "[boot] Starting reef bootstrap for ${req.name} (${req.type})"

# ===== 1. Fix DNS =====
echo "nameserver 8.8.8.8" > /etc/resolv.conf

# ===== 2. Ensure PATH =====
export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# ===== 3. Install node if not present =====
if ! command -v node &> /dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  echo "[boot] Installing node..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# ===== 4. Install bun if not present =====
if ! command -v bun &> /dev/null; then
  echo "[boot] Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="/root/.bun/bin:$PATH"
fi

# ===== 5. Clone/update reef =====
if [ -d /root/reef ]; then
  echo "[boot] Updating existing reef..."
  cd /root/reef && git pull --ff-only 2>/dev/null || true
else
  echo "[boot] Cloning reef..."
  git clone https://github.com/hdresearch/reef.git /root/reef 2>/dev/null || {
    echo "[boot] Git clone failed — checking for tarball..."
    # Fallback: download tarball from roof reef
    curl -sf "${roofUrl}/installer/seeds" > /dev/null && {
      echo "[boot] Installing from roof reef..."
      mkdir -p /root/reef
      cd /root/reef
      # Will be populated by installer
    }
  }
fi

# ===== 6. Clone/update pi-vers =====
if [ -d /root/pi-vers ]; then
  echo "[boot] Updating existing pi-vers..."
  cd /root/pi-vers && git pull --ff-only 2>/dev/null || true
else
  echo "[boot] Cloning pi-vers..."
  git clone https://github.com/hdresearch/pi-vers.git /root/pi-vers 2>/dev/null || true
fi

# ===== 7. Clone/update punkin-pi =====
if [ -d /root/punkin-pi ]; then
  echo "[boot] Updating existing punkin-pi..."
  cd /root/punkin-pi && git fetch --tags --force 2>/dev/null || true
  cd /root/punkin-pi && git checkout v1rc3 2>/dev/null || true
else
  echo "[boot] Cloning punkin-pi..."
  git clone https://github.com/hdresearch/punkin-pi.git /root/punkin-pi 2>/dev/null || true
  cd /root/punkin-pi && git checkout v1rc3 2>/dev/null || true
fi

cd /root/reef

# ===== 8. Build punkin harness =====
if [ -d /root/punkin-pi ]; then
  cd /root/punkin-pi
  HUSKY=0 npm install 2>/dev/null || npm install
  npm run build 2>/dev/null || true
  if [ -x /root/punkin-pi/builds/punkin ]; then
    ln -sf /root/punkin-pi/builds/punkin /usr/local/bin/punkin
  elif [ -x /root/punkin-pi/packages/coding-agent/dist/cli.js ]; then
    ln -sf /root/punkin-pi/packages/coding-agent/dist/cli.js /usr/local/bin/punkin
    chmod +x /root/punkin-pi/packages/coding-agent/dist/cli.js
  fi
  if [ -x /usr/local/bin/punkin ]; then
    ln -sf /usr/local/bin/punkin /usr/local/bin/pi
  fi
fi

cd /root/reef

# ===== 9. Install dependencies =====
bun install --frozen-lockfile 2>/dev/null || bun install

# ===== 10. Configure reef DNA =====
cat > /root/reef/.env << 'ENVEOF'
# Auto-generated by reef bootloader
VERS_VM_ID=${req.vmId}
VERS_AGENT_NAME=${req.name}
VERS_AGENT_ROLE=${req.type === "full" ? "agent" : req.type}
VERS_INFRA_URL=${roofUrl}
PUNKIN_BIN=punkin
PI_PATH=punkin
PI_VERS_HOME=/root/pi-vers
REEF_VM_TYPE=${req.type}
REEF_ORGANS=${profile.organs.join(",")}
REEF_CAPABILITIES=${profile.capabilities.join(",")}
${req.parentVmId ? `REEF_PARENT_VM_ID=${req.parentVmId}` : ""}
ENVEOF

# Source env
set -a; source .env; set +a

# ===== 11. Selective module loading =====
# Reef discovers services from SERVICES_DIR. Build a curated directory so the
# selected DNA actually controls which service modules load.
ACTIVE_ORGANS="${profile.organs.join(" ")}"
echo "[boot] Active organs: $ACTIVE_ORGANS"

${
  req.type !== "full"
    ? `
# Build an active services directory with symlinks to the selected modules
rm -rf /root/reef/services-active
mkdir -p /root/reef/services-active
for dir in /root/reef/services/*/; do
  svc=$(basename "$dir")
  if echo "$ACTIVE_ORGANS" | grep -qw "$svc"; then
    ln -s "../services/$svc" "/root/reef/services-active/$svc"
    echo "[boot] Enabled: $svc"
  fi
done
export SERVICES_DIR=/root/reef/services-active
`
    : 'export SERVICES_DIR="/root/reef/services"'
}

${
  profile.installPiVers
    ? `
# ===== 12. Register harness packages =====
echo "[boot] Registering reef + pi-vers in harness..."
mkdir -p /root/.pi/agent
if command -v "$PI_PATH" >/dev/null 2>&1; then
  "$PI_PATH" install /root/reef
  "$PI_PATH" install /root/pi-vers
fi
`
    : `# Skipping pi-vers (not needed for ${req.type} VMs)`
}

# ===== 13. Register in roof reef's VM tree =====
echo "[boot] Registering in VM tree..."
curl -sf -X POST "${roofUrl}/vm-tree/vms" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${VERS_AUTH_TOKEN:-}" \\
  -d '{
    "vmId": "${req.vmId}",
    "name": "${req.name}",
    "category": "${req.type === "full" ? "agent_vm" : req.type === "swarm" ? "swarm_vm" : req.type === "lightweight" ? "swarm_vm" : "infra_vm"}",
    "parentVmId": ${req.parentVmId ? `"${req.parentVmId}"` : "null"},
    "reefConfig": ${JSON.stringify({ organs: profile.organs, capabilities: profile.capabilities })}
  }' 2>/dev/null || echo "[boot] VM tree registration failed (non-fatal)"

# ===== 14. Start reef via systemd =====
echo "[boot] Starting reef..."
if systemctl is-system-running &>/dev/null; then
  cp /root/reef/scripts/reef.service /etc/systemd/system/reef.service
  systemctl daemon-reload
  systemctl enable reef
  systemctl start reef
else
  # No systemd — run directly
  nohup bun run src/main.ts > /tmp/reef.log 2>&1 &
fi

# ===== 15. Health check =====
echo "[boot] Waiting for reef..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "[boot] Reef up in \${i}s"

    # Register in registry
    curl -sf -X POST "${roofUrl}/registry/vms" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer \${VERS_AUTH_TOKEN:-}" \\
      -d '{
        "id": "${req.vmId}",
        "name": "${req.name}",
        "role": "${req.type === "full" ? "worker" : req.type === "infra" ? "infra" : "worker"}",
        "address": "${req.vmId}.vm.vers.sh",
        "registeredBy": "bootloader",
        "reefConfig": ${JSON.stringify({ organs: profile.organs, capabilities: profile.capabilities })}
      }' 2>/dev/null || true

    echo "[boot] Bootstrap complete for ${req.name}"
    exit 0
  fi
  sleep 1
done

echo "[boot] Reef failed to start"
tail -20 /tmp/reef.log 2>/dev/null
exit 1
`;
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// GET /profiles — list available VM type profiles
routes.get("/profiles", (c) => {
  return c.json({ profiles: PROFILES });
});

// GET /profiles/:type — get a specific profile
routes.get("/profiles/:type", (c) => {
  const type = c.req.param("type") as VMType;
  const profile = PROFILES[type];
  if (!profile) return c.json({ error: `Unknown VM type: ${type}` }, 404);
  return c.json(profile);
});

// POST /generate — generate a boot script for a VM
routes.post("/generate", async (c) => {
  const body = await c.req.json();
  const { vmId, name, type, parentVmId, extraOrgans, extraCapabilities, roofReefUrl } = body;

  if (!vmId || !name || !type) {
    return c.json({ error: "vmId, name, and type are required" }, 400);
  }
  if (!PROFILES[type as VMType]) {
    return c.json({ error: `Unknown VM type: ${type}. Valid: full, swarm, lightweight, infra` }, 400);
  }

  const script = generateBootScript({
    vmId,
    name,
    type: type as VMType,
    parentVmId,
    extraOrgans,
    extraCapabilities,
    roofReefUrl,
  });

  const profile = { ...PROFILES[type as VMType] };
  if (extraOrgans) {
    for (const o of extraOrgans) {
      if (!profile.organs.includes(o)) profile.organs.push(o);
    }
  }
  if (extraCapabilities) {
    for (const c of extraCapabilities) {
      if (!profile.capabilities.includes(c)) profile.capabilities.push(c);
    }
  }

  return c.json({ vmId, name, type, profile, script }, 201);
});

// GET /script/:type — get a generic boot script for a VM type
routes.get("/script/:type", (c) => {
  const type = c.req.param("type") as VMType;
  if (!PROFILES[type]) return c.json({ error: `Unknown VM type: ${type}` }, 404);

  const script = generateBootScript({
    vmId: "__VERS_VM_ID__",
    name: "__VERS_AGENT_NAME__",
    type,
    parentVmId: "__REEF_PARENT_VM_ID__",
  });

  return new Response(script, {
    headers: { "Content-Type": "text/x-shellscript" },
  });
});

// =============================================================================
// Module export
// =============================================================================

const bootloader: ServiceModule = {
  name: "bootloader",
  description: "VM bootstrapping — generates boot scripts based on VM DNA profiles",
  routes,

  registerTools(pi: ExtensionAPI, client: FleetClient) {
    pi.registerTool({
      name: "reef_boot_generate",
      label: "Bootloader: Generate Script",
      description:
        "Generate a boot script to bootstrap reef on a new VM. Configures modules and capabilities based on VM type.",
      parameters: Type.Object({
        vmId: Type.String({ description: "VM ID to bootstrap" }),
        name: Type.String({ description: "VM name" }),
        type: Type.Union(
          [Type.Literal("full"), Type.Literal("swarm"), Type.Literal("lightweight"), Type.Literal("infra")],
          { description: "VM type profile" },
        ),
        parentVmId: Type.Optional(Type.String({ description: "Parent VM ID" })),
        extraOrgans: Type.Optional(Type.Array(Type.String(), { description: "Additional service modules" })),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("POST", "/bootloader/generate", params);
          return client.ok(
            [
              `Boot script generated for "${result.name}" (${result.type})`,
              `  Organs: ${result.profile.organs.join(", ")}`,
              `  Capabilities: ${result.profile.capabilities.join(", ")}`,
              `  Pi-vers: ${result.profile.installPiVers ? "yes" : "no"}`,
              `  Script length: ${result.script.length} chars`,
              "",
              "Use SCP to copy and execute on the VM:",
              `  scp boot.sh root@${params.vmId}.vm.vers.sh:/tmp/boot.sh`,
              `  ssh root@${params.vmId}.vm.vers.sh 'bash /tmp/boot.sh'`,
            ].join("\n"),
            { result },
          );
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "reef_boot_profiles",
      label: "Bootloader: List Profiles",
      description: "List available VM type profiles and their default DNA (modules + capabilities).",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("GET", "/bootloader/profiles");
          const lines: string[] = [];
          for (const [type, profile] of Object.entries(result.profiles) as [string, any][]) {
            lines.push(
              [
                `${type}:`,
                `  ${profile.description}`,
                `  Organs: ${profile.organs.join(", ")}`,
                `  Capabilities: ${profile.capabilities.join(", ") || "none"}`,
                `  Pi-vers: ${profile.installPiVers ? "yes" : "no"}`,
              ].join("\n"),
            );
          }
          return client.ok(lines.join("\n\n"), { profiles: result.profiles });
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });
  },

  capabilities: ["vm.boot", "vm.provision"],

  routeDocs: {
    "GET /profiles": {
      summary: "List available VM type profiles",
      response: "{ profiles: { full, swarm, lightweight, infra } }",
    },
    "GET /profiles/:type": {
      summary: "Get a specific VM profile",
      params: { type: { type: "string", required: true, description: "full | swarm | lightweight | infra" } },
    },
    "POST /generate": {
      summary: "Generate a boot script for a VM",
      body: {
        vmId: { type: "string", required: true, description: "VM ID" },
        name: { type: "string", required: true, description: "VM name" },
        type: { type: "string", required: true, description: "VM type: full | swarm | lightweight | infra" },
        parentVmId: { type: "string", description: "Parent VM ID" },
        extraOrgans: { type: "string[]", description: "Additional modules to include" },
      },
      response: "{ vmId, name, type, profile, script }",
    },
    "GET /script/:type": {
      summary: "Get a generic boot script for a VM type (shell script)",
      params: { type: { type: "string", required: true } },
      response: "text/x-shellscript",
    },
  },
};

export default bootloader;

/**
 * Bootloader service — generates bootstrap scripts for infra-style Reef VMs.
 *
 * Runtime agent VMs should come from the reusable golden image. The bootloader
 * remains only for the cases where Reef needs to stand up another infra VM that
 * runs its own local Reef server with a selected service set.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, ServiceModule } from "../../src/core/types.js";

// =============================================================================
// Types
// =============================================================================

export type VMType = "infra";

export interface BootProfile {
  type: VMType;
  services: string[];
  capabilities: string[];
  description: string;
}

export interface BootRequest {
  vmId: string;
  name: string;
  type: VMType;
  parentVmId?: string;
  extraServices?: string[];
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
  infra: {
    type: "infra",
    services: ["store", "cron", "docs"],
    capabilities: [],
    description: "Infra VM — core reef + specific service. For Gitea, MinIO, persistent services.",
  },
};

// =============================================================================
// Boot script generation
// =============================================================================

export function generateBootScript(req: BootRequest): string {
  const profile = { ...PROFILES[req.type] };

  // Merge extra services and capabilities
  for (const service of [...(req.extraServices || []), ...(req.extraOrgans || [])]) {
    if (!profile.services.includes(service)) profile.services.push(service);
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

cd /root/reef

# ===== 6. Install dependencies =====
bun install --frozen-lockfile 2>/dev/null || bun install

# ===== 7. Activate the local service set =====
rm -rf /root/reef/services-active
mkdir -p /root/reef/services-active
ACTIVE_SERVICES="${profile.services.join(" ")}"
for dir in /root/reef/services/*/; do
  svc=$(basename "$dir")
  if echo "$ACTIVE_SERVICES" | grep -qw "$svc"; then
    ln -s "../services/$svc" "/root/reef/services-active/$svc"
  fi
done

# ===== 8. Register in roof reef's VM tree =====
echo "[boot] Registering in VM tree..."
curl -sf -X POST "${roofUrl}/vm-tree/vms" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${VERS_AUTH_TOKEN:-}" \\
  -d '{
    "vmId": "${req.vmId}",
    "name": "${req.name}",
    "category": "infra_vm",
    "parentVmId": ${req.parentVmId ? `"${req.parentVmId}"` : "null"},
    "reefConfig": ${JSON.stringify({ services: profile.services, capabilities: profile.capabilities })}
  }' 2>/dev/null || echo "[boot] VM tree registration failed (non-fatal)"

# ===== 9. Start reef via systemd =====
cat > /root/reef/.env << 'ENVEOF'
# Auto-generated by reef bootloader
VERS_VM_ID=${req.vmId}
VERS_AGENT_NAME=${req.name}
VERS_AGENT_ROLE=infra
VERS_INFRA_URL=${roofUrl}
REEF_VM_TYPE=infra
REEF_SERVICES=${profile.services.join(",")}
REEF_CAPABILITIES=${profile.capabilities.join(",")}
${req.parentVmId ? `REEF_PARENT_VM_ID=${req.parentVmId}` : ""}
ENVEOF

echo "[boot] Starting local reef service..."
if systemctl is-system-running &>/dev/null; then
  cp /root/reef/scripts/reef.service /etc/systemd/system/reef.service
  systemctl daemon-reload
  systemctl enable reef
  systemctl start reef
else
  nohup bun run src/main.ts > /tmp/reef.log 2>&1 &
fi

echo "[boot] Waiting for reef..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "[boot] Reef up in \${i}s"
    break
  fi
  sleep 1
done

if ! curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "[boot] Reef failed to start"
  tail -20 /tmp/reef.log 2>/dev/null
  exit 1
fi

# ===== 10. Register in root registry =====
curl -sf -X POST "${roofUrl}/registry/vms" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${VERS_AUTH_TOKEN:-}" \\
  -d '{
    "id": "${req.vmId}",
    "name": "${req.name}",
    "role": "infra",
    "address": "${req.vmId}.vm.vers.sh",
    "registeredBy": "bootloader",
    "reefConfig": ${JSON.stringify({ services: profile.services, capabilities: profile.capabilities })}
  }' 2>/dev/null || true

echo "[boot] Bootstrap complete for ${req.name}"
exit 0
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
  const { vmId, name, type, parentVmId, extraServices, extraOrgans, extraCapabilities, roofReefUrl } = body;

  if (!vmId || !name || !type) {
    return c.json({ error: "vmId, name, and type are required" }, 400);
  }
  if (!PROFILES[type as VMType]) {
    return c.json({ error: `Unknown VM type: ${type}. Valid: infra` }, 400);
  }

  const script = generateBootScript({
    vmId,
    name,
    type: type as VMType,
    parentVmId,
    extraServices,
    extraOrgans,
    extraCapabilities,
    roofReefUrl,
  });

  const profile = { ...PROFILES[type as VMType] };
  for (const service of [...(extraServices || []), ...(extraOrgans || [])]) {
    if (!profile.services.includes(service)) profile.services.push(service);
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
        "Generate a boot script to bootstrap an infra Reef VM. Agent VMs should come from the golden image instead.",
      parameters: Type.Object({
        vmId: Type.String({ description: "VM ID to bootstrap" }),
        name: Type.String({ description: "VM name" }),
        type: Type.Literal("infra", { description: "Bootloader only supports infra VMs" }),
        parentVmId: Type.Optional(Type.String({ description: "Parent VM ID" })),
        extraServices: Type.Optional(Type.Array(Type.String(), { description: "Additional services to include" })),
        extraOrgans: Type.Optional(
          Type.Array(Type.String(), { description: "Backward-compatible alias for extraServices" }),
        ),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("POST", "/bootloader/generate", params);
          return client.ok(
            [
              `Boot script generated for "${result.name}" (${result.type})`,
              `  Services: ${result.profile.services.join(", ")}`,
              `  Capabilities: ${result.profile.capabilities.join(", ")}`,
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
      description:
        "List available infra boot profiles. Child agent VMs should be created from the golden image instead.",
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
                `  Services: ${profile.services.join(", ")}`,
                `  Capabilities: ${profile.capabilities.join(", ") || "none"}`,
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
      summary: "List available infra VM boot profiles",
      response: "{ profiles: { infra } }",
    },
    "GET /profiles/:type": {
      summary: "Get a specific VM profile",
      params: { type: { type: "string", required: true, description: "infra" } },
    },
    "POST /generate": {
      summary: "Generate a boot script for an infra VM",
      body: {
        vmId: { type: "string", required: true, description: "VM ID" },
        name: { type: "string", required: true, description: "VM name" },
        type: { type: "string", required: true, description: "VM type: infra" },
        parentVmId: { type: "string", description: "Parent VM ID" },
        extraServices: { type: "string[]", description: "Additional services to include" },
        extraOrgans: { type: "string[]", description: "Backward-compatible alias for extraServices" },
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

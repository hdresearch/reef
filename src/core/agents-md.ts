/**
 * AGENTS.md inheritance — reads the current agent's AGENTS.md and builds
 * the inherited version for a child agent with appended context.
 *
 * The spawn flow uses this to construct the child's AGENTS.md:
 * 1. Read parent's AGENTS.md (which already includes ancestor context)
 * 2. Append a "## Context from <parent-name>" section
 * 3. Write to child VM at /root/.pi/agent/AGENTS.md
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the current agent's AGENTS.md content.
 * Checks multiple paths (root image vs golden image vs working dir).
 */
export function readParentAgentsMd(): string {
  const paths = [
    // Root image path
    join(process.cwd(), "AGENTS.md"),
    // Golden image path
    "/root/.pi/agent/AGENTS.md",
    // Reef source path (root image)
    "/opt/reef/AGENTS.md",
    "/opt/src/reef/AGENTS.md",
    // Golden image reef path
    "/root/reef/AGENTS.md",
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim();
        if (content.length > 0) return content;
      } catch {}
    }
  }

  // Fallback: return a minimal AGENTS.md
  return "# Reef Agent\n\nYou are an agent in a reef fleet. Check reef_self for your identity and reef_inbox for pending messages.";
}

/**
 * Build the inherited AGENTS.md for a child agent.
 *
 * @param parentAgentsMd - The parent's full AGENTS.md content
 * @param parentName - The parent agent's name (for the context header)
 * @param context - Optional situational context to append
 * @returns The child's AGENTS.md content
 */
export function buildChildAgentsMd(parentAgentsMd: string, parentName: string, context?: string): string {
  let result = parentAgentsMd;

  // Propagate principal registry if it exists
  try {
    const { readRegistry, exportableRegistry } = require("./webauthn.js");
    const reg = readRegistry();
    if (reg.credentials.length > 0) {
      const exported = exportableRegistry(reg);
      const pubkeys = exported.credentials
        .map((c: any) => `- **${c.label || c.providerHint || c.id.slice(0, 12)}** (${c.deviceType}): \`${c.id}\``)
        .join("\n");
      const registryBlock = [
        "\n\n## Principal Trust Registry",
        "",
        `Operator: **${exported.operatorName || "Unknown"}**`,
        `Registered passkeys: ${exported.credentials.length}`,
        `Policy: verify=${exported.policy.verifyMin}-of-N, add=${exported.policy.addRootMin}-of-N, revoke=${exported.policy.revokeMin}-of-N`,
        "",
        pubkeys,
        "",
        "These credentials were registered via WebAuthn by the operator with physical authenticator interaction.",
        `\`\`\`json\n${JSON.stringify(exported, null, 2)}\n\`\`\``,
      ].join("\n");
      result += registryBlock;
    }
  } catch {
    // webauthn module not available — skip registry propagation
  }

  if (!context) return result;

  // Always use the standard header for traceability
  const header = `## Context from ${parentName}`;
  return `${result}\n\n${header}\n\n${context}`;
}

/**
 * Generate the SSH command to write AGENTS.md to a child VM.
 * Uses a heredoc to handle multi-line content safely.
 */
export function buildAgentsMdWriteScript(agentsMdContent: string): string {
  // Escape any occurrences of the heredoc delimiter in the content
  const safeContent = agentsMdContent.replace(/AGENTS_MD_EOF/g, "AGENTS_MD_E0F");

  return [
    "mkdir -p /root/.pi/agent",
    `cat > /root/.pi/agent/AGENTS.md << 'AGENTS_MD_EOF'`,
    safeContent,
    "AGENTS_MD_EOF",
  ].join("\n");
}

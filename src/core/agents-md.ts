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
  if (!context) return parentAgentsMd;

  // Ensure context starts with the header
  const header = `## Context from ${parentName}`;
  const contextBlock = context.startsWith("##") ? context : `${header}\n\n${context}`;

  return `${parentAgentsMd}\n\n${contextBlock}`;
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

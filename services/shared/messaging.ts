/**
 * Shared messaging helpers for bot services (Discord, Slack, etc.)
 *
 * Handles the reef integration side that's identical across platforms:
 * - Submit messages to reef conversations
 * - Poll for task results
 * - Strip internal tags from output
 * - Split long messages into chunks
 */

// =============================================================================
// Reef integration
// =============================================================================

export function reefBaseUrl(): string {
  return process.env.VERS_INFRA_URL || "http://localhost:3000";
}

export function reefAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.VERS_AUTH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Submit a message to reef, continuing an existing conversation or creating one.
 * Returns the conversation ID used.
 */
export async function submitToReef(prompt: string, conversationId: string): Promise<{ conversationId: string }> {
  const baseUrl = reefBaseUrl();
  const headers = reefAuthHeaders();
  const body: Record<string, unknown> = { task: prompt };

  // Try to continue an existing conversation first
  let res = await fetch(`${baseUrl}/reef/conversations/${conversationId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // If conversation doesn't exist yet, create it
  if (res.status === 404) {
    body.conversationId = conversationId;
    res = await fetch(`${baseUrl}/reef/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reef submit failed (${res.status}): ${text}`);
  }

  await res.json();
  return { conversationId };
}

/**
 * Poll for a task/conversation result. Returns the full assistant output.
 */
export async function waitForTaskResult(conversationId: string): Promise<string> {
  const baseUrl = reefBaseUrl();
  const headers = reefAuthHeaders();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const res = await fetch(`${baseUrl}/reef/tasks`, { headers });
      if (!res.ok) continue;

      const data = (await res.json()) as any;
      const tasks = data.tasks || [...(data.active || []), ...(data.completed || [])];
      const task = tasks.find(
        (t: any) => t.id === conversationId || t.taskId === conversationId || t.name === conversationId,
      );

      if (task && (task.status === "done" || task.status === "error")) {
        if (task.status === "error") return `Error: ${task.error || "unknown error"}`;

        // Try to get full output from the conversation tree (artifacts.summary is capped at 500 chars)
        try {
          const convoRes = await fetch(`${baseUrl}/reef/conversations/${conversationId}`, { headers });
          if (convoRes.ok) {
            const convo = (await convoRes.json()) as any;
            const nodes: any[] = convo.nodes || [];
            const lastAssistant = [...nodes].reverse().find((n: any) => n.role === "assistant");
            if (lastAssistant?.content) return lastAssistant.content;
          }
        } catch {
          // Fall back to summary
        }

        return task.artifacts?.summary || task.output || "(no output)";
      }
    } catch {
      // Keep polling
    }
  }

  return "(task timed out after 4 minutes)";
}

// =============================================================================
// Content formatting
// =============================================================================

/**
 * Strip internal tags (boot, squiggle) that aren't useful to end users.
 */
export function stripInternalTags(content: string): string {
  content = content.replace(/<(boot|squiggle)>[\s\S]*?<\/\1>\s*/g, "").trim();
  content = content.replace(/<\/?(boot|squiggle)>/g, "").trim();
  return content || "(empty response)";
}

/**
 * Split a message into chunks that fit within a platform's character limit.
 * Tries to break at newlines for readability.
 */
export function splitMessage(content: string, maxLength = 1900): string[] {
  const chunks: string[] = [];
  while (content.length > 0) {
    if (content.length <= maxLength) {
      chunks.push(content);
      break;
    }
    let splitAt = content.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 3) splitAt = maxLength;
    chunks.push(content.slice(0, splitAt));
    content = content.slice(splitAt).trimStart();
  }
  return chunks;
}

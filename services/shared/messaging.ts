/**
 * Shared messaging helpers for bot services (Discord, Slack, etc.)
 *
 * Handles the reef integration side that's identical across platforms:
 * - Submit messages to reef conversations
 * - Wait for task results via event bus (no polling)
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
 * Fetch the full assistant output from a conversation.
 * The event bus only provides a 200-char summary — this gets the complete text.
 */
async function fetchFullOutput(conversationId: string): Promise<string | null> {
  const baseUrl = reefBaseUrl();
  const headers = reefAuthHeaders();
  try {
    const res = await fetch(`${baseUrl}/reef/conversations/${conversationId}`, { headers });
    if (!res.ok) return null;
    const convo = (await res.json()) as any;
    const nodes: any[] = convo.nodes || [];
    const lastAssistant = [...nodes].reverse().find((n: any) => n.role === "assistant");
    return lastAssistant?.content || null;
  } catch {
    return null;
  }
}

/**
 * Wait for a task to complete using the in-process event bus.
 * No polling — listens for the task_done/task_error event directly.
 * Resolves when reef fires the completion event. No timeout — reef
 * guarantees every task emits task_done or task_error (even on crash).
 *
 * @param conversationId - The reef conversation/task ID to wait for
 * @param eventBus - The ServiceEventBus from ctx.events (required, set in init())
 */
export async function waitForTaskResult(
  conversationId: string,
  eventBus: { on(event: string, handler: (data: any) => void): () => void },
): Promise<string> {
  if (!eventBus) {
    throw new Error("waitForTaskResult requires an event bus — services must pass ctx.events from init()");
  }

  return new Promise<string>((resolve) => {
    const unsubscribe = eventBus.on("reef:event", async (data: any) => {
      const taskId = data?.taskId;
      if (taskId !== conversationId) return;

      const type = data?.type;
      if (type !== "task_done" && type !== "task_error") return;

      unsubscribe();

      if (type === "task_error") {
        resolve(`Error: ${data.error || "unknown error"}`);
        return;
      }

      // Event has a 200-char summary — fetch the full output
      const fullOutput = await fetchFullOutput(conversationId);
      resolve(fullOutput || data.summary || "(no output)");
    });
  });
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

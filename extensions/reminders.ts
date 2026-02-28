/**
 * Reminders extension — schedule delayed messages that trigger agent turns.
 *
 * Tools:
 *   remind_me  — schedule a reminder after a delay
 *   reminders  — list pending and fired reminders
 *
 * When a reminder fires, it injects a user message that triggers a new turn,
 * so the agent wakes up and can act on it without any human input.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface Reminder {
  id: string;
  message: string;
  delayMs: number;
  scheduledAt: number;
  firesAt: number;
  status: "pending" | "fired";
  timerId?: ReturnType<typeof setTimeout>;
}

function parseDelay(delay: string): number | null {
  const match = delay.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("s")) return value * 1000;
  if (unit.startsWith("m")) return value * 60 * 1000;
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  return null;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export default function (pi: ExtensionAPI) {
  const reminders: Reminder[] = [];

  function fireReminder(reminder: Reminder) {
    reminder.status = "fired";
    delete reminder.timerId;

    const elapsed = formatDuration(Date.now() - reminder.scheduledAt);
    const msg = `⏰ REMINDER (scheduled ${elapsed} ago):\n\n${reminder.message}\n\nAct on this now.`;

    // This triggers a new agent turn even if idle — no user input needed
    pi.sendUserMessage(msg, { deliverAs: "followUp" });
  }

  pi.registerTool({
    name: "remind_me",
    label: "Schedule Reminder",
    description:
      "Schedule a reminder that will fire after a delay and trigger a new agent turn. " +
      "Use this instead of 'sleep && curl' patterns — schedule a check and move on. " +
      "The reminder fires even if the user hasn't typed anything. " +
      "Delay format: '30s', '5m', '1h', '2.5h', etc.",
    parameters: Type.Object({
      message: Type.String({
        description: "What to remind about — include enough context to act on it. " +
          "E.g. 'Check pipeline abc123 status on VM 0ed565. curl -s localhost:3000/pipeline/runs/abc123'",
      }),
      delay: Type.String({
        description: "How long to wait. Examples: '30s', '5m', '15m', '1h', '2h'",
      }),
    }),
    async execute(_toolCallId, params) {
      const delayMs = parseDelay(params.delay);
      if (!delayMs) {
        return {
          content: [{ type: "text", text: `Invalid delay format: "${params.delay}". Use e.g. '30s', '5m', '1h'.` }],
        };
      }

      const reminder: Reminder = {
        id: Date.now().toString(36),
        message: params.message,
        delayMs,
        scheduledAt: Date.now(),
        firesAt: Date.now() + delayMs,
        status: "pending",
      };

      reminder.timerId = setTimeout(() => fireReminder(reminder), delayMs);
      reminders.push(reminder);

      const firesAt = new Date(reminder.firesAt).toLocaleTimeString();
      return {
        content: [{
          type: "text",
          text: `✅ Reminder "${reminder.id}" scheduled.\n` +
            `  Fires in: ${formatDuration(delayMs)}\n` +
            `  At: ${firesAt}\n` +
            `  Message: ${params.message.slice(0, 100)}${params.message.length > 100 ? "..." : ""}`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "reminders",
    label: "List Reminders",
    description: "List all pending and recently fired reminders.",
    parameters: Type.Object({}),
    async execute() {
      if (reminders.length === 0) {
        return { content: [{ type: "text", text: "No reminders scheduled." }] };
      }

      const now = Date.now();
      const lines = reminders.map((r) => {
        const age = formatDuration(now - r.scheduledAt);
        if (r.status === "pending") {
          const remaining = formatDuration(r.firesAt - now);
          return `⏳ [${r.id}] fires in ${remaining} — ${r.message.slice(0, 80)}`;
        } else {
          return `✅ [${r.id}] fired ${age} ago — ${r.message.slice(0, 80)}`;
        }
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // Clean up timers on shutdown
  pi.on("session_shutdown", async () => {
    for (const r of reminders) {
      if (r.timerId) clearTimeout(r.timerId);
    }
  });
}

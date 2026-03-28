/**
 * Usage service — fleet-wide token and cost visibility.
 *
 * Aggregates assistant message usage from root, lieutenants, and swarm workers
 * into the shared fleet SQLite so owners can see where budget goes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { VMTreeStore } from "../vm-tree/store.js";

let vmTreeStore: VMTreeStore | null = null;

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordUsageMessage(input: { agentId?: string; agentName?: string; taskId?: string | null; message?: any }) {
  if (!vmTreeStore || !input.agentId || !input.agentName || !input.message) return;

  const usage = input.message.usage;
  if (!usage || typeof usage !== "object") return;

  const cost = typeof usage.cost === "object" && usage.cost ? usage.cost : {};
  vmTreeStore.insertUsage({
    agentId: input.agentId,
    agentName: input.agentName,
    taskId: input.taskId || null,
    provider: input.message.provider || input.message.api || null,
    model: input.message.model || null,
    inputTokens: toFiniteNumber(usage.input),
    outputTokens: toFiniteNumber(usage.output),
    cacheReadTokens: toFiniteNumber(usage.cacheRead),
    cacheWriteTokens: toFiniteNumber(usage.cacheWrite),
    totalTokens:
      toFiniteNumber(usage.input) +
      toFiniteNumber(usage.output) +
      toFiniteNumber(usage.cacheRead) +
      toFiniteNumber(usage.cacheWrite),
    inputCost: toFiniteNumber(cost.input),
    outputCost: toFiniteNumber(cost.output),
    cacheReadCost: toFiniteNumber(cost.cacheRead),
    cacheWriteCost: toFiniteNumber(cost.cacheWrite),
    totalCost: toFiniteNumber(cost.total),
  });
}

function recordUsageStats(input: {
  agentId?: string;
  agentName?: string;
  taskId?: string | null;
  provider?: string | null;
  model?: string | null;
  stats?: any;
}) {
  if (!vmTreeStore || !input.agentId || !input.agentName || !input.stats?.sessionId) return;

  const tokens = typeof input.stats.tokens === "object" && input.stats.tokens ? input.stats.tokens : {};
  vmTreeStore.upsertUsageSession({
    agentId: input.agentId,
    agentName: input.agentName,
    taskId: input.taskId || null,
    sessionId: String(input.stats.sessionId),
    sessionFile: typeof input.stats.sessionFile === "string" ? input.stats.sessionFile : null,
    provider: input.provider || null,
    model: input.model || null,
    userMessages: toFiniteNumber(input.stats.userMessages),
    assistantMessages: toFiniteNumber(input.stats.assistantMessages),
    toolCalls: toFiniteNumber(input.stats.toolCalls),
    toolResults: toFiniteNumber(input.stats.toolResults),
    totalMessages: toFiniteNumber(input.stats.totalMessages),
    inputTokens: toFiniteNumber(tokens.input),
    outputTokens: toFiniteNumber(tokens.output),
    cacheReadTokens: toFiniteNumber(tokens.cacheRead),
    cacheWriteTokens: toFiniteNumber(tokens.cacheWrite),
    totalTokens: toFiniteNumber(tokens.total),
    totalCost: toFiniteNumber(input.stats.cost),
  });
}

const routes = new Hono();

routes.post("/record", async (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);

  try {
    const body = await c.req.json();
    recordUsageMessage(body);
    return c.json({ recorded: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

routes.get("/summary", (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);
  const windowMinutes = Number.parseInt(c.req.query("windowMinutes") || "0", 10) || 0;
  const since = windowMinutes > 0 ? Date.now() - windowMinutes * 60_000 : undefined;
  const summary = vmTreeStore.usageSummary(since);
  return c.json({ windowMinutes, since: since || null, ...summary });
});

routes.get("/records", (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);
  const windowMinutes = Number.parseInt(c.req.query("windowMinutes") || "0", 10) || 0;
  const since = windowMinutes > 0 ? Date.now() - windowMinutes * 60_000 : undefined;
  const agent = c.req.query("agent");
  const taskId = c.req.query("taskId");
  const limit = Number.parseInt(c.req.query("limit") || "100", 10) || 100;
  const records = vmTreeStore.queryUsage({
    agentName: agent || undefined,
    taskId: taskId || undefined,
    since,
    limit,
  });
  return c.json({ records, count: records.length });
});

routes.get("/_panel", (c) => {
  if (!vmTreeStore) {
    return c.html('<div style="font-family:monospace;color:#888">Usage service not initialized</div>');
  }

  const summary = vmTreeStore.usageSummary(Date.now() - 24 * 60 * 60 * 1000);
  const recent = vmTreeStore.queryUsage({ since: Date.now() - 24 * 60 * 60 * 1000, limit: 120 }).reverse();
  const top = summary.byAgent.slice(0, 8);
  const lineages = summary.lineages.slice(0, 5);

  return c.html(`
    <div id="usage-panel-root" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9f6ff;background:radial-gradient(circle at top,#14334d 0%,#09111b 58%,#05080d 100%);border:1px solid #1d3c5a;border-radius:14px;padding:14px;position:relative;overflow:hidden">
      <div style="position:absolute;inset:0;background:linear-gradient(transparent 96%,rgba(90,210,255,0.06) 100%),linear-gradient(90deg,transparent 96%,rgba(90,210,255,0.05) 100%);background-size:100% 24px,24px 100%;pointer-events:none"></div>
      <div style="position:relative;z-index:1">
        <div style="display:flex;justify-content:space-between;align-items:end;gap:12px;margin-bottom:12px">
          <div>
            <div style="font-size:11px;letter-spacing:.24em;color:#6cb9d8;text-transform:uppercase">Fleet Usage</div>
            <div style="font-size:24px;color:#f2fbff;text-shadow:0 0 12px rgba(94,220,255,0.2)">$${summary.totals.totalCost.toFixed(4)}</div>
            <div style="font-size:12px;color:#8cb4c6">${summary.totals.totalTokens.toLocaleString()} total tokens in the last 24h</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div style="min-width:110px;padding:8px 10px;border:1px solid rgba(92,177,211,0.25);border-radius:10px;background:rgba(5,18,28,0.55)">
              <div style="font-size:10px;color:#6cb9d8;text-transform:uppercase;letter-spacing:.18em">Input</div>
              <div style="font-size:16px;color:#e9fbff">${summary.totals.inputTokens.toLocaleString()}</div>
            </div>
            <div style="min-width:110px;padding:8px 10px;border:1px solid rgba(92,177,211,0.25);border-radius:10px;background:rgba(5,18,28,0.55)">
              <div style="font-size:10px;color:#6cb9d8;text-transform:uppercase;letter-spacing:.18em">Output</div>
              <div style="font-size:16px;color:#e9fbff">${summary.totals.outputTokens.toLocaleString()}</div>
            </div>
            <div style="min-width:110px;padding:8px 10px;border:1px solid rgba(92,177,211,0.25);border-radius:10px;background:rgba(5,18,28,0.55)">
              <div style="font-size:10px;color:#6cb9d8;text-transform:uppercase;letter-spacing:.18em">Agents</div>
              <div style="font-size:16px;color:#e9fbff">${summary.byAgent.length}</div>
            </div>
          </div>
        </div>
        <div style="margin-bottom:12px;padding:10px 12px;border:1px solid rgba(92,177,211,0.22);border-radius:12px;background:rgba(4,13,22,0.65)">
          <div style="font-size:11px;color:#7eb9d1;text-transform:uppercase;letter-spacing:.18em;margin-bottom:6px">Accuracy</div>
          <div style="font-size:12px;color:#c2e8f5;line-height:1.5">
            Root and child-agent totals prefer the latest successful <code>get_session_stats</code> snapshot for each known session.
            Child sessions come from lieutenant, agent VM, and swarm worker RPC handles; root sessions come from reef's local task RPC processes.
            If an agent has no session snapshot yet, reef falls back to assistant-message usage rows for that agent.
            Subtree totals are then rolled up over the vm-tree lineage.
            Displayed dollar cost is harness-side model pricing, not provider billing reconciliation.
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1.2fr .8fr;gap:14px">
          <div style="border:1px solid rgba(92,177,211,0.22);border-radius:12px;padding:10px;background:rgba(4,13,22,0.65)">
            <div style="font-size:11px;color:#7eb9d1;text-transform:uppercase;letter-spacing:.18em;margin-bottom:8px">Usage Stream</div>
            <svg id="usage-stream-svg" viewBox="0 0 640 220" style="width:100%;height:220px;display:block"></svg>
          </div>
          <div style="display:grid;gap:14px">
            <div style="border:1px solid rgba(92,177,211,0.22);border-radius:12px;padding:10px;background:rgba(4,13,22,0.65)">
              <div style="font-size:11px;color:#7eb9d1;text-transform:uppercase;letter-spacing:.18em;margin-bottom:8px">Top Agents</div>
              <div style="display:grid;gap:8px">
                ${top
                  .map((row, index) => {
                    const pct =
                      summary.totals.totalTokens > 0
                        ? Math.max(6, Math.round((row.totalTokens / summary.totals.totalTokens) * 100))
                        : 0;
                    return `<div style="padding:8px 10px;border:1px solid rgba(92,177,211,0.18);border-radius:10px;background:rgba(6,17,28,0.72)">
                      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                        <div style="min-width:0">
                          <div style="color:#f2fbff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${index + 1}. ${esc(row.agentName)}</div>
                          <div style="color:#7fa7ba;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.model || row.provider || row.category || "unknown")}</div>
                        </div>
                        <div style="text-align:right">
                          <div style="color:#d9f6ff;font-size:13px">${row.totalTokens.toLocaleString()}</div>
                          <div style="color:#7fa7ba;font-size:11px">$${row.totalCost.toFixed(4)}</div>
                        </div>
                      </div>
                      <div style="margin-top:8px;height:6px;background:rgba(41,72,90,0.45);border-radius:999px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#26d5ff,#8ef3ff);box-shadow:0 0 10px rgba(38,213,255,0.45)"></div>
                      </div>
                    </div>`;
                  })
                  .join("")}
              </div>
            </div>
            <div style="border:1px solid rgba(92,177,211,0.22);border-radius:12px;padding:10px;background:rgba(4,13,22,0.65)">
              <div style="font-size:11px;color:#7eb9d1;text-transform:uppercase;letter-spacing:.18em;margin-bottom:8px">Top Lineages</div>
              <div style="display:grid;gap:8px">
                ${lineages
                  .map((row, index) => {
                    const pct =
                      summary.totals.totalTokens > 0
                        ? Math.max(6, Math.round((row.subtreeTokens / summary.totals.totalTokens) * 100))
                        : 0;
                    return `<div style="padding:8px 10px;border:1px solid rgba(92,177,211,0.18);border-radius:10px;background:rgba(6,17,28,0.72)">
                      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                        <div style="min-width:0">
                          <div style="color:#f2fbff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${index + 1}. ${esc(row.agentName)}</div>
                          <div style="color:#7fa7ba;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.category || "agent")} · ${row.descendantAgents} descendant(s)</div>
                        </div>
                        <div style="text-align:right">
                          <div style="color:#d9f6ff;font-size:13px">${row.subtreeTokens.toLocaleString()}</div>
                          <div style="color:#7fa7ba;font-size:11px">self ${row.selfTokens.toLocaleString()}</div>
                        </div>
                      </div>
                      <div style="margin-top:8px;height:6px;background:rgba(41,72,90,0.45);border-radius:999px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#56ffa4,#9efff1);box-shadow:0 0 10px rgba(86,255,164,0.35)"></div>
                      </div>
                    </div>`;
                  })
                  .join("")}
              </div>
            </div>
          </div>
        </div>
      </div>
      <script>
        (() => {
          const svg = document.getElementById('usage-stream-svg');
          if (!svg) return;
          const records = ${JSON.stringify(recent)};
          const width = 640;
          const height = 220;
          const pad = { left: 42, right: 12, top: 14, bottom: 22 };
          const plotW = width - pad.left - pad.right;
          const plotH = height - pad.top - pad.bottom;
          const maxValue = Math.max(1, ...records.map((r) => r.totalTokens || 0));

          const line = [];
          const area = [];
          records.forEach((r, i) => {
            const x = pad.left + (records.length <= 1 ? plotW / 2 : (i / (records.length - 1)) * plotW);
            const y = pad.top + plotH - ((r.totalTokens || 0) / maxValue) * plotH;
            line.push(i === 0 ? \`M \${x} \${y}\` : \`L \${x} \${y}\`);
            area.push([x, y]);
          });

          const grid = [];
          for (let i = 0; i < 5; i++) {
            const y = pad.top + (plotH / 4) * i;
            grid.push(\`<line x1="\${pad.left}" y1="\${y}" x2="\${width - pad.right}" y2="\${y}" stroke="rgba(111,182,208,0.14)" stroke-width="1"/>\`);
          }

          const dots = records.map((r, i) => {
            const x = pad.left + (records.length <= 1 ? plotW / 2 : (i / (records.length - 1)) * plotW);
            const y = pad.top + plotH - ((r.totalTokens || 0) / maxValue) * plotH;
            return \`<circle cx="\${x}" cy="\${y}" r="2.8" fill="#9df6ff" stroke="#26d5ff" stroke-width="1.5"><title>\${r.agentName}: \${(r.totalTokens || 0).toLocaleString()} tokens</title></circle>\`;
          }).join('');

          let areaPath = '';
          if (area.length > 0) {
            areaPath = \`M \${area[0][0]} \${pad.top + plotH} \` + area.map(([x, y]) => \`L \${x} \${y}\`).join(' ') + \` L \${area[area.length - 1][0]} \${pad.top + plotH} Z\`;
          }

          svg.innerHTML = \`
            <defs>
              <linearGradient id="usageGlow" x1="0" x2="1">
                <stop offset="0%" stop-color="#155a7e"/>
                <stop offset="55%" stop-color="#26d5ff"/>
                <stop offset="100%" stop-color="#9df6ff"/>
              </linearGradient>
              <linearGradient id="usageArea" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="rgba(38,213,255,0.42)"/>
                <stop offset="100%" stop-color="rgba(38,213,255,0.02)"/>
              </linearGradient>
              <filter id="usageBlur">
                <feGaussianBlur stdDeviation="4" />
              </filter>
            </defs>
            \${grid.join('')}
            <path d="\${areaPath}" fill="url(#usageArea)"></path>
            <path d="\${line.join(' ')}" fill="none" stroke="rgba(38,213,255,0.22)" stroke-width="8" filter="url(#usageBlur)"></path>
            <path d="\${line.join(' ')}" fill="none" stroke="url(#usageGlow)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"></path>
            \${dots}
            <text x="\${pad.left}" y="16" fill="#6cb9d8" font-size="10">tokens / assistant turn</text>
            <text x="\${pad.left}" y="\${height - 6}" fill="#56798a" font-size="10">older</text>
            <text x="\${width - pad.right - 22}" y="\${height - 6}" fill="#56798a" font-size="10">newer</text>
            <text x="6" y="\${pad.top + 8}" fill="#7eb9d1" font-size="10">\${maxValue.toLocaleString()}</text>
            <text x="10" y="\${pad.top + plotH}" fill="#56798a" font-size="10">0</text>
          \`;
        })();
      </script>
    </div>
  `);
});

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_usage",
    label: "Usage: Fleet Summary",
    description: "Inspect recent token and cost usage across the fleet or for a specific agent.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Optional agent name filter" })),
      windowMinutes: Type.Optional(Type.Number({ description: "Time window in minutes (default: 1440)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const windowMinutes = params.windowMinutes || 1440;
        const summary = await client.api<any>("GET", `/usage/summary?windowMinutes=${windowMinutes}`);
        const lines = [
          `Window: ${windowMinutes}m`,
          `Total tokens: ${(summary.totals?.totalTokens || 0).toLocaleString()}`,
          `Total cost: $${(summary.totals?.totalCost || 0).toFixed(4)}`,
          `Child accuracy: ${summary.accuracy?.childAgentsSource || "unknown"}`,
          `Root accuracy: ${summary.accuracy?.rootSource || "unknown"}`,
          ...((summary.accuracy?.caveats || []).map((c: string) => `- ${c}`) || []),
        ];

        const rows = params.agent
          ? (summary.byAgent || []).filter((row: any) => row.agentName === params.agent)
          : (summary.byAgent || []).slice(0, 8);
        if (rows.length > 0) {
          lines.push("", "Top agents:");
          for (const row of rows) {
            lines.push(
              `- ${row.agentName}: ${row.totalTokens.toLocaleString()} tokens, $${row.totalCost.toFixed(4)}, ${row.turns} turn(s)`,
            );
          }
        }

        const lineages = params.agent
          ? (summary.lineages || []).filter((row: any) => row.agentName === params.agent)
          : (summary.lineages || []).slice(0, 5);
        if (lineages.length > 0) {
          lines.push("", "Top lineages:");
          for (const row of lineages) {
            lines.push(
              `- ${row.agentName}: self ${row.selfTokens.toLocaleString()} / subtree ${row.subtreeTokens.toLocaleString()} tokens, $${row.subtreeCost.toFixed(4)}, ${row.descendantAgents} descendant(s)`,
            );
          }
        }

        return client.ok(lines.join("\n"), { summary });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

const routeDocs: Record<string, RouteDocs> = {
  "POST /record": {
    summary: "Record assistant-message usage",
    response: "{ recorded: true }",
  },
  "GET /summary": {
    summary: "Aggregate usage summary across the fleet",
    query: {
      windowMinutes: { type: "number", description: "Only include records newer than this many minutes" },
    },
    response: "{ totals, byAgent, lineages, accuracy, since, windowMinutes }",
  },
  "GET /records": {
    summary: "List raw usage records",
    query: {
      agent: { type: "string", description: "Optional agent name filter" },
      taskId: { type: "string", description: "Optional task/conversation filter" },
      windowMinutes: { type: "number", description: "Only include records newer than this many minutes" },
      limit: { type: "number", description: "Maximum rows" },
    },
    response: "{ records, count }",
  },
  "GET /_panel": {
    summary: "Sci-fi usage dashboard panel",
    response: "text/html",
  },
};

const usage: ServiceModule = {
  name: "usage",
  description: "Fleet usage accounting and visualization",
  routes,
  routeDocs,
  registerTools,

  init(ctx: ServiceContext) {
    const storeHandle = ctx.getStore<any>("vm-tree");
    if (storeHandle?.vmTreeStore) {
      vmTreeStore = storeHandle.vmTreeStore as VMTreeStore;
    }

    ctx.events.on("usage:message", (data: any) => {
      recordUsageMessage(data || {});
    });
    ctx.events.on("usage:stats", (data: any) => {
      recordUsageStats(data || {});
    });
  },

  dependencies: ["vm-tree"],
  capabilities: ["agent.usage"],
};

export default usage;

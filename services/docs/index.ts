/**
 * Docs service module — auto-generated API documentation.
 *
 * Introspects all loaded service modules to produce endpoint documentation.
 * Reads routes from Hono instances and combines with routeDocs metadata.
 *
 *   GET /docs           — full API docs (JSON)
 *   GET /docs/:service  — docs for a specific service
 *   GET /docs/ui        — browsable HTML docs
 */

import { Hono } from "hono";
import type { ParamDoc, ServiceContext, ServiceModule } from "../src/core/types.js";

let ctx: ServiceContext;

// =============================================================================
// Types
// =============================================================================

interface RouteDoc {
  method: string;
  path: string;
  summary?: string;
  detail?: string;
  params?: Record<string, ParamDoc>;
  query?: Record<string, ParamDoc>;
  body?: Record<string, ParamDoc>;
  response?: string;
}

interface ServiceDoc {
  name: string;
  description: string | undefined;
  auth: boolean;
  routes: RouteDoc[];
  capabilities: {
    hasTools: boolean;
    hasBehaviors: boolean;
    hasWidget: boolean;
    hasStore: boolean;
  };
  dependencies: string[];
}

// =============================================================================
// Introspection
// =============================================================================

function documentService(mod: ServiceModule): ServiceDoc {
  const routes: RouteDoc[] = [];
  const docMap = mod.routeDocs ?? {};

  if (mod.routes) {
    for (const r of (mod.routes as any).routes || []) {
      if (r.method === "ALL" && (r.path === "/*" || r.path === "*")) continue;

      const prefix = mod.mountAtRoot ? "" : `/${mod.name}`;

      // Look up docs by "METHOD /path" (path relative to module, as declared)
      const key = `${r.method} ${r.path}`;
      const docs = docMap[key];

      routes.push({
        method: r.method,
        path: prefix + r.path,
        ...(docs ?? {}),
      });
    }
  }

  return {
    name: mod.name,
    description: mod.description,
    auth: mod.requiresAuth !== false,
    routes,
    capabilities: {
      hasTools: !!mod.registerTools,
      hasBehaviors: !!mod.registerBehaviors,
      hasWidget: !!mod.widget,
      hasStore: !!mod.store,
    },
    dependencies: mod.dependencies ?? [],
  };
}

const reefDoc: ServiceDoc = {
  name: "reef",
  description: "Agent conversation engine — task submission, branching conversations, user profile",
  auth: true,
  routes: [
    { method: "POST", path: "/reef/submit", summary: "Start a task (legacy)" },
    {
      method: "GET",
      path: "/reef/conversations",
      summary: "List conversations",
      query: { includeClosed: { type: "boolean", description: "Include closed" } },
    },
    { method: "GET", path: "/reef/conversations/:id", summary: "Get conversation with messages" },
    {
      method: "POST",
      path: "/reef/conversations",
      summary: "Create a conversation and start a task",
      body: { task: { type: "string", required: true, description: "The prompt" } },
    },
    {
      method: "POST",
      path: "/reef/conversations/:id/messages",
      summary: "Send a follow-up message",
      body: { task: { type: "string", required: true, description: "The prompt" } },
    },
    { method: "POST", path: "/reef/conversations/:id/close", summary: "Close a conversation" },
    { method: "POST", path: "/reef/conversations/:id/open", summary: "Reopen a conversation" },
    {
      method: "GET",
      path: "/reef/tasks",
      summary: "List tasks",
      query: { status: { type: "string", description: "Filter: running, done, error" } },
    },
    { method: "GET", path: "/reef/tasks/:name", summary: "Get full task conversation" },
    { method: "GET", path: "/reef/tree", summary: "Full conversation tree" },
    { method: "GET", path: "/reef/tree/:id", summary: "Get a node and its children" },
    { method: "GET", path: "/reef/tree/:id/path", summary: "Get ancestors of a node" },
    { method: "GET", path: "/reef/profile", summary: "Get user profile" },
    {
      method: "PUT",
      path: "/reef/profile",
      summary: "Update user profile — injected into agent prompts",
      body: {
        name: { type: "string", description: "User name" },
        timezone: { type: "string", description: "IANA timezone" },
        location: { type: "string", description: "User location" },
        preferences: { type: "string", description: "Free-text context for agents" },
      },
    },
    { method: "GET", path: "/reef/state", summary: "Status and counts" },
    { method: "GET", path: "/reef/events", summary: "SSE event stream" },
    { method: "POST", path: "/auth/magic-link", summary: "Generate a login link" },
  ],
  capabilities: { hasTools: false, hasBehaviors: false, hasWidget: false, hasStore: false },
  dependencies: [],
};

function documentAll(): ServiceDoc[] {
  const services = ctx
    .getModules()
    .filter((m) => m.name !== "docs")
    .map(documentService);
  services.push(reefDoc);
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

// =============================================================================
// HTML renderer
// =============================================================================

function renderHTML(docs: ServiceDoc[]): string {
  const methodColor: Record<string, string> = {
    GET: "#4f9",
    POST: "#5af",
    PATCH: "#fd0",
    PUT: "#fd0",
    DELETE: "#f55",
    ALL: "#888",
  };

  const services = docs
    .map((svc) => {
      const routes = svc.routes
        .map((r) => {
          const color = methodColor[r.method] || "#ccc";
          const summary = r.summary ? `<span class="summary">${esc(r.summary)}</span>` : "";
          const detail = r.detail ? `<div class="detail">${esc(r.detail)}</div>` : "";
          const params = renderParamTable("Path params", r.params);
          const query = renderParamTable("Query params", r.query);
          const body = renderParamTable("Body", r.body);
          const response = r.response
            ? `<div class="response-doc"><span class="field-label">Response:</span> <span class="response-text">${esc(r.response)}</span></div>`
            : "";
          const hasDetails = r.summary || r.params || r.query || r.body || r.response;
          const expandClass = hasDetails ? " expandable" : "";
          const detailBlock =
            detail || params || query || body || response
              ? `<div class="route-details">${detail}${params}${query}${body}${response}</div>`
              : "";

          return `<div class="route${expandClass}"${hasDetails ? " onclick=\"this.classList.toggle('open')\"" : ""}>
            <div class="route-header">
              <span class="method" style="color:${color}">${esc(r.method)}</span>
              <span class="path">${esc(r.path)}</span>
              ${summary}
            </div>
            ${detailBlock}
          </div>`;
        })
        .join("\n");

      const badges = [
        svc.auth ? '<span class="badge auth">auth</span>' : '<span class="badge public">public</span>',
        svc.capabilities.hasTools ? '<span class="badge tools">tools</span>' : "",
        svc.capabilities.hasBehaviors ? '<span class="badge behaviors">behaviors</span>' : "",
        svc.capabilities.hasWidget ? '<span class="badge widget">widget</span>' : "",
        svc.capabilities.hasStore ? '<span class="badge store">store</span>' : "",
      ]
        .filter(Boolean)
        .join(" ");

      const deps = svc.dependencies.length
        ? `<div class="deps">depends on: ${svc.dependencies.map((d) => `<code>${esc(d)}</code>`).join(", ")}</div>`
        : "";

      return `<div class="service" id="svc-${esc(svc.name)}">
        <div class="service-header">
          <h2><a href="#svc-${esc(svc.name)}">/${esc(svc.name)}</a></h2>
          <div class="badges">${badges}</div>
        </div>
        ${svc.description ? `<p class="desc">${esc(svc.description)}</p>` : ""}
        ${deps}
        <div class="routes">${routes || '<div class="empty">No routes</div>'}</div>
      </div>`;
    })
    .join("\n");

  const nav = docs
    .map(
      (svc) =>
        `<a href="#svc-${esc(svc.name)}" class="nav-item">/${esc(svc.name)} <span class="route-count">${svc.routes.length}</span></a>`,
    )
    .join("\n");

  const totalRoutes = docs.reduce((sum, s) => sum + s.routes.length, 0);
  const documented = docs.reduce((sum, s) => sum + s.routes.filter((r) => r.summary).length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Services — API Docs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0a; --bg-panel: #111; --bg-card: #1a1a1a;
      --border: #2a2a2a; --text: #ccc; --text-dim: #666;
      --text-bright: #eee; --accent: #4f9;
    }
    html, body {
      height: 100%; background: var(--bg); color: var(--text);
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 13px; line-height: 1.6;
    }
    .layout { display: flex; height: 100vh; }
    .sidebar {
      width: 220px; background: var(--bg-panel); border-right: 1px solid var(--border);
      padding: 16px 0; overflow-y: auto; flex-shrink: 0;
    }
    .sidebar h1 {
      font-size: 13px; color: var(--accent); padding: 0 16px 12px;
      border-bottom: 1px solid var(--border); margin-bottom: 8px; font-weight: 600;
    }
    .sidebar .summary { font-size: 11px; color: var(--text-dim); padding: 0 16px 12px; }
    .nav-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 16px; color: var(--text-dim); text-decoration: none;
      font-size: 12px; transition: all 0.1s;
    }
    .nav-item:hover { color: var(--text); background: var(--bg-card); }
    .route-count {
      font-size: 10px; background: var(--bg-card); padding: 1px 6px;
      border-radius: 3px; color: var(--text-dim);
    }
    .content { flex: 1; overflow-y: auto; padding: 24px 32px; }
    .service {
      margin-bottom: 32px; padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }
    .service:last-child { border-bottom: none; }
    .service-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .service-header h2 { font-size: 16px; font-weight: 600; }
    .service-header h2 a { color: var(--text-bright); text-decoration: none; }
    .service-header h2 a:hover { color: var(--accent); }
    .desc { color: var(--text-dim); margin-bottom: 8px; font-size: 12px; }
    .deps { color: var(--text-dim); font-size: 11px; margin-bottom: 8px; }
    .deps code { color: var(--accent); }
    .badges { display: flex; gap: 4px; }
    .badge {
      font-size: 10px; padding: 2px 8px; border-radius: 3px;
      text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;
    }
    .badge.auth { background: #2a1a1a; color: #f93; }
    .badge.public { background: #1a2a1a; color: var(--accent); }
    .badge.tools { background: #1a1a2a; color: #5af; }
    .badge.behaviors { background: #2a1a2a; color: #a7f; }
    .badge.widget { background: #2a2a1a; color: #fd0; }
    .badge.store { background: #1a2a2a; color: #5cc; }
    .routes { margin-top: 8px; }
    .route {
      margin: 2px 0; border-left: 2px solid var(--border);
      transition: border-color 0.15s;
    }
    .route:hover { border-left-color: #444; }
    .route.expandable { cursor: pointer; }
    .route.expandable .route-header::after {
      content: "▸"; color: var(--text-dim); font-size: 10px; margin-left: auto;
      transition: transform 0.15s;
    }
    .route.open .route-header::after { transform: rotate(90deg); }
    .route-header {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px; font-size: 13px;
    }
    .route-header:hover { background: var(--bg-card); }
    .method { display: inline-block; width: 65px; font-weight: 700; flex-shrink: 0; }
    .path { color: var(--text-bright); }
    .summary { color: var(--text-dim); font-size: 12px; margin-left: 8px; }
    .route-details {
      display: none; padding: 8px 12px 12px 24px;
      border-top: 1px solid var(--border); background: var(--bg-panel);
      font-size: 12px;
    }
    .route.open .route-details { display: block; }
    .detail { color: var(--text-dim); margin-bottom: 8px; font-style: italic; }
    .param-table { margin: 8px 0; }
    .param-table-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-dim); margin-bottom: 4px; font-weight: 600;
    }
    .param-row {
      display: flex; gap: 8px; padding: 3px 0;
      border-bottom: 1px solid #1a1a1a; align-items: baseline;
    }
    .param-row:last-child { border-bottom: none; }
    .param-name { color: var(--accent); font-weight: 600; min-width: 120px; flex-shrink: 0; }
    .param-type { color: #5af; font-size: 11px; min-width: 80px; flex-shrink: 0; }
    .param-required { color: #f93; font-size: 10px; font-weight: 600; }
    .param-desc { color: var(--text-dim); }
    .field-label { color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .response-doc { margin-top: 8px; }
    .response-text { color: var(--text); }
    .empty { color: var(--text-dim); font-style: italic; padding: 8px 12px; }
    @media (max-width: 700px) {
      .sidebar { display: none; }
      .content { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <div class="sidebar">
      <h1>▸ API Docs</h1>
      <div class="summary">${docs.length} services · ${totalRoutes} routes · ${documented} documented</div>
      ${nav}
    </div>
    <div class="content">
      ${services}
    </div>
  </div>
</body>
</html>`;
}

function renderParamTable(title: string, params?: Record<string, ParamDoc>): string {
  if (!params || Object.keys(params).length === 0) return "";

  const rows = Object.entries(params)
    .map(([name, p]) => {
      const req = p.required ? ' <span class="param-required">required</span>' : "";
      return `<div class="param-row">
        <span class="param-name">${esc(name)}${req}</span>
        <span class="param-type">${esc(p.type ?? "")}</span>
        <span class="param-desc">${esc(p.description ?? "")}</span>
      </div>`;
    })
    .join("\n");

  return `<div class="param-table">
    <div class="param-table-title">${esc(title)}</div>
    ${rows}
  </div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

routes.get("/", (c) => c.json({ services: documentAll() }));

routes.get("/ui", (c) => c.html(renderHTML(documentAll())));

routes.get("/_panel", (c) => {
  const docs = documentAll();
  const totalRoutes = docs.reduce((sum, s) => sum + s.routes.length, 0);
  const documented = docs.reduce((sum, s) => sum + s.routes.filter((r) => r.summary).length, 0);

  const serviceList = docs
    .map((svc) => {
      const routeCount = svc.routes.length;
      const badges = [
        svc.capabilities.hasTools ? '<span style="color:#5af;font-size:10px">tools</span>' : "",
        svc.capabilities.hasStore ? '<span style="color:#5cc;font-size:10px">store</span>' : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1a1a1a">
        <span><span style="color:#4f9">/${esc(svc.name)}</span> ${badges}</span>
        <span style="color:#666">${routeCount} route${routeCount !== 1 ? "s" : ""}</span>
      </div>`;
    })
    .join("");

  return c.html(`
    <div style="font-family:monospace;font-size:13px;color:#ccc">
      <div style="margin-bottom:8px;color:#888">${docs.length} services · ${totalRoutes} routes · ${documented} documented</div>
      ${serviceList}
      <div style="margin-top:12px">
        <a href="/docs/ui" target="_blank" style="color:#5af;text-decoration:none;font-size:12px">Open full API docs →</a>
      </div>
    </div>
  `);
});

routes.get("/:service", (c) => {
  const name = c.req.param("service");
  const mod = ctx.getModule(name);
  if (!mod) return c.json({ error: `Service "${name}" not found` }, 404);
  return c.json(documentService(mod));
});

// =============================================================================
// Module
// =============================================================================

const docs: ServiceModule = {
  name: "docs",
  description: "Auto-generated API documentation",
  routes,
  requiresAuth: false,

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
  },
};

export default docs;

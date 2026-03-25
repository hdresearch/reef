/**
 * GitHub service — token minting and credential management for Vers orgs.
 *
 * Uses the Vers API key (already injected into all VMs) to mint short-lived
 * GitHub App installation tokens via vers-landing. Supports scoped tokens
 * for fine-grained repo access.
 *
 * Two layers:
 *   1. Credential helper (git-credential-vers) — full-org token for clone/create
 *   2. This service — scoped tokens for in-repo work (branches, PRs, issues)
 *
 * Tools (1):
 *   reef_github_token — Mint a scoped GitHub token for repo operations
 *
 * Behavioral rules enforced via tool descriptions:
 *   - Never delete repositories
 *   - Never merge or push directly to main
 *   - Always create pull requests
 *   - Keep PR descriptions updated
 *   - Use credential helper only for clone/create
 *   - Use reef_github_token with scoped permissions for all in-repo work
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceModule } from "../../src/core/types.js";

// =============================================================================
// Token cache — keyed by scope, auto-expires
// =============================================================================

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
  permissions: Record<string, string>;
  repositories?: string[];
  installationId?: number;
}

const tokenCache = new Map<string, CachedToken>();

const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh when <10 min left

function cacheKey(repositories?: string[], permissions?: Record<string, string>): string {
  const repos = repositories ? [...repositories].sort().join(",") : "*";
  const perms = permissions
    ? Object.entries(permissions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(",")
    : "*";
  return `${repos}|${perms}`;
}

function getCachedToken(key: string): CachedToken | null {
  const entry = tokenCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt - REFRESH_MARGIN_MS) {
    tokenCache.delete(key);
    return null;
  }
  return entry;
}

// =============================================================================
// Token profiles — preset permission sets for common operations
// =============================================================================

type TokenProfile = "read" | "develop" | "clone" | "ci";

const TOKEN_PROFILES: Record<TokenProfile, { permissions: Record<string, string>; description: string }> = {
  read: {
    permissions: {
      administration: "read",
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      statuses: "read",
      actions: "read",
      metadata: "read",
    },
    description: "Read-only access to contents, PRs, issues, CI status, and repo settings",
  },
  develop: {
    permissions: {
      administration: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
      actions: "read",
      metadata: "read",
    },
    description: "Push to feature branches, create/update PRs and issues, monitor CI, read repo settings",
  },
  clone: {
    permissions: { contents: "read" },
    description: "Clone repositories",
  },
  ci: {
    permissions: {
      actions: "write",
      checks: "read",
      statuses: "read",
      contents: "read",
      metadata: "read",
    },
    description: "Trigger and monitor CI workflows, check results",
  },
};

// =============================================================================
// Vers API integration
// =============================================================================

function resolveVersBaseUrl(): string {
  return process.env.VERS_BASE_URL || "https://vers.sh";
}

function resolveApiKey(): string | null {
  return process.env.VERS_API_KEY || null;
}

interface VersTokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repositories?: Array<{ name: string; full_name: string; private: boolean }>;
  repository_selection?: string;
  installation_id?: number;
  org_id?: string;
}

async function mintToken(options?: {
  repositories?: string[];
  permissions?: Record<string, string>;
}): Promise<VersTokenResponse> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("VERS_API_KEY not configured");

  const baseUrl = resolveVersBaseUrl();
  const body: Record<string, unknown> = {};
  if (options?.repositories?.length) body.repositories = options.repositories;
  if (options?.permissions && Object.keys(options.permissions).length) body.permissions = options.permissions;

  const res = await fetch(`${baseUrl}/api/github/installation-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vers token mint failed (${res.status}): ${text}`);
  }

  return (await res.json()) as VersTokenResponse;
}

async function getToken(options?: {
  repositories?: string[];
  permissions?: Record<string, string>;
}): Promise<CachedToken> {
  const key = cacheKey(options?.repositories, options?.permissions);

  const cached = getCachedToken(key);
  if (cached) return cached;

  const response = await mintToken(options);
  const entry: CachedToken = {
    token: response.token,
    expiresAt: new Date(response.expires_at).getTime(),
    permissions: response.permissions,
    repositories: response.repositories?.map((r) => r.full_name),
    installationId: response.installation_id,
  };

  tokenCache.set(key, entry);
  return entry;
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// POST /github/token — mint a scoped token
routes.post("/token", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { repositories, permissions, profile } = body as {
      repositories?: string[];
      permissions?: Record<string, string>;
      profile?: TokenProfile;
    };

    let resolvedPermissions = permissions;
    if (profile && TOKEN_PROFILES[profile]) {
      resolvedPermissions = TOKEN_PROFILES[profile].permissions;
    }

    const token = await getToken({ repositories, permissions: resolvedPermissions });
    return c.json({
      token: token.token,
      expires_at: new Date(token.expiresAt).toISOString(),
      permissions: token.permissions,
      repositories: token.repositories,
      installation_id: token.installationId,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /github/profiles — list available token profiles
routes.get("/profiles", (c) => {
  return c.json({
    profiles: Object.entries(TOKEN_PROFILES).map(([name, profile]) => ({
      name,
      permissions: profile.permissions,
      description: profile.description,
    })),
  });
});

// GET /github/status — check if GitHub integration is configured
routes.get("/status", (c) => {
  const apiKey = resolveApiKey();
  return c.json({
    configured: !!apiKey,
    apiKeyPresent: !!apiKey,
    baseUrl: resolveVersBaseUrl(),
    cachedTokens: tokenCache.size,
  });
});

// GET /github/_panel — HTML debug view
routes.get("/_panel", (c) => {
  const apiKey = resolveApiKey();
  const cached = Array.from(tokenCache.entries()).map(([key, entry]) => ({
    scope: key,
    expiresIn: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000 / 60)),
    permissions: Object.keys(entry.permissions).join(", "),
  }));

  return c.html(`
    <div style="font-family:monospace;font-size:13px;color:#ccc">
      <div style="margin-bottom:8px;color:#888">GitHub Integration</div>
      <div style="margin-bottom:4px">API Key: ${apiKey ? '<span style="color:#4f9">configured</span>' : '<span style="color:#f44">not set</span>'}</div>
      <div style="margin-bottom:4px">Base URL: ${esc(resolveVersBaseUrl())}</div>
      <div style="margin-bottom:8px">Cached tokens: ${cached.length}</div>
      ${
        cached.length > 0
          ? `<table style="width:100%;border-collapse:collapse">
              <thead><tr style="color:#666;font-size:11px;text-align:left;border-bottom:1px solid #333">
                <th style="padding:4px 8px">Scope</th><th style="padding:4px 8px">Permissions</th><th style="padding:4px 8px">Expires in</th>
              </tr></thead>
              <tbody>${cached.map((t) => `<tr><td style="color:#4f9;padding:4px 8px">${esc(t.scope)}</td><td style="color:#888;padding:4px 8px">${esc(t.permissions)}</td><td style="color:#666;padding:4px 8px">${t.expiresIn}m</td></tr>`).join("")}</tbody>
            </table>`
          : '<div style="color:#666;font-style:italic">No cached tokens</div>'
      }
    </div>
  `);
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// =============================================================================
// Tools
// =============================================================================

const GITHUB_RULES = `

IMPORTANT — GitHub operational rules:
- NEVER delete repositories
- NEVER merge or push directly to main (force or otherwise)
- ALWAYS create pull requests for changes and keep PR descriptions updated
- Use the credential helper (git clone) only for cloning or creating repos
- Use this tool (reef_github_token) with appropriate scope for ALL in-repo work
- Prefer the most restrictive profile/permissions that accomplish your task`;

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_github_token",
    label: "GitHub: Get Token",
    description: `Mint a scoped GitHub installation token for repository operations.

Profiles:
  - "read"    → Read contents, PRs, issues, and CI status
  - "develop" → Push to feature branches, create/update PRs and issues, monitor CI
  - "clone"   → Clone repositories (prefer git credential helper instead)
  - "ci"      → Trigger and monitor CI workflows, check results

You can use a profile OR specify custom repositories/permissions for fine-grained control.
The token expires in ~1 hour and is cached until near-expiry.
${GITHUB_RULES}`,
    parameters: Type.Object({
      profile: Type.Optional(
        Type.Union([Type.Literal("read"), Type.Literal("develop"), Type.Literal("clone"), Type.Literal("ci")], {
          description: "Preset permission profile. Use this OR repositories/permissions, not both.",
        }),
      ),
      repositories: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Scope token to specific repositories (e.g. ["reef", "pi-vers"])',
        }),
      ),
      permissions: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: 'Custom permissions map (e.g. { "contents": "read", "pull_requests": "write" })',
        }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();

      try {
        let permissions = params.permissions;
        if (params.profile && TOKEN_PROFILES[params.profile as TokenProfile]) {
          permissions = TOKEN_PROFILES[params.profile as TokenProfile].permissions;
        }

        const result = await client.api<{
          token: string;
          expires_at: string;
          permissions: Record<string, string>;
          repositories?: string[];
        }>("POST", "/github/token", {
          repositories: params.repositories,
          permissions,
          profile: params.profile,
        });

        const lines = [
          `Token: ${result.token}`,
          `Expires: ${result.expires_at}`,
          `Permissions: ${Object.entries(result.permissions)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")}`,
        ];
        if (result.repositories?.length) {
          lines.push(`Repositories: ${result.repositories.join(", ")}`);
        }

        return client.ok(lines.join("\n"), {
          token: result.token,
          expires_at: result.expires_at,
          permissions: result.permissions,
          repositories: result.repositories,
        });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

// =============================================================================
// Module
// =============================================================================

const routeDocs: Record<string, RouteDocs> = {
  "POST /token": {
    summary: "Mint a scoped GitHub installation token",
    body: {
      profile: { type: "string", description: 'Token profile: "read", "develop", "clone", "ci"' },
      repositories: { type: "string[]", description: "Scope to specific repos" },
      permissions: { type: "object", description: 'Custom permissions (e.g. { "contents": "write" })' },
    },
    response: "{ token, expires_at, permissions, repositories, installation_id }",
  },
  "GET /profiles": {
    summary: "List available token profiles and their permissions",
    response: "{ profiles: [{ name, permissions, description }] }",
  },
  "GET /status": {
    summary: "Check GitHub integration status",
    response: "{ configured, apiKeyPresent, baseUrl, cachedTokens }",
  },
  "GET /_panel": {
    summary: "HTML debug view of GitHub integration status and cached tokens",
    response: "text/html",
  },
};

const github: ServiceModule = {
  name: "github",
  description: "GitHub token minting and credential management for Vers orgs",
  routes,
  routeDocs,
  registerTools,

  dependencies: ["vers-config"],
  capabilities: ["github.token", "github.credential"],
};

export default github;

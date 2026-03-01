/**
 * Updater service module — auto-update the reef server.
 *
 * Checks npm for new versions of @versdotsh/reef and applies updates.
 * Can run on a schedule (poll interval) or be triggered manually via API.
 *
 * Routes:
 *   GET  /updater/status  — current version, latest available, update history
 *   POST /updater/check   — check for updates now
 *   POST /updater/apply   — download and apply the latest version, then restart
 *
 * Env vars:
 *   UPDATE_POLL_INTERVAL — check interval in minutes (default: 0 = disabled)
 *   UPDATE_AUTO_APPLY    — automatically apply updates when found (default: false)
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ServiceContext, ServiceModule } from "../src/core/types.js";

interface UpdateRecord {
  from: string;
  to: string;
  timestamp: string;
  status: "applied" | "failed";
  error?: string;
}

const PACKAGE_NAME = "@versdotsh/reef";

let currentVersion: string = "unknown";
let latestVersion: string | null = null;
let lastChecked: string | null = null;
let updateAvailable = false;
let checking = false;
let applying = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const history: UpdateRecord[] = [];

function loadCurrentVersion(): string {
  try {
    // Walk up from services/updater to find package.json
    const paths = [join(import.meta.dir, "..", "..", "package.json"), join(process.cwd(), "package.json")];
    for (const p of paths) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.name === PACKAGE_NAME || pkg.name === "reef") {
          return pkg.version;
        }
      } catch {}
    }
    // Fallback: ask bun
    const out = execSync("bun pm ls 2>/dev/null | grep reef || true", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const match = out.match(/@[\d.]+/);
    return match ? match[0].slice(1) : "unknown";
  } catch {
    return "unknown";
  }
}

async function checkForUpdate(): Promise<{
  current: string;
  latest: string;
  updateAvailable: boolean;
}> {
  checking = true;
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status}`);
    }

    const data = (await res.json()) as { version: string };
    latestVersion = data.version;
    lastChecked = new Date().toISOString();
    updateAvailable = latestVersion !== currentVersion;

    return {
      current: currentVersion,
      latest: latestVersion,
      updateAvailable,
    };
  } finally {
    checking = false;
  }
}

async function applyUpdate(): Promise<UpdateRecord> {
  if (!latestVersion || !updateAvailable) {
    throw new Error("No update available — run check first");
  }

  applying = true;
  const from = currentVersion;
  const to = latestVersion;

  try {
    // Update the package
    execSync(`bun update ${PACKAGE_NAME}`, {
      encoding: "utf-8",
      timeout: 60000,
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const record: UpdateRecord = {
      from,
      to,
      timestamp: new Date().toISOString(),
      status: "applied",
    };
    history.push(record);

    // Schedule restart — give time for the response to be sent
    setTimeout(() => {
      console.log(`  [updater] restarting after update ${from} → ${to}`);

      // Spawn a new process with the same args, then exit
      const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
        detached: true,
      });
      child.unref();

      // Give the child a moment to start, then exit
      setTimeout(() => process.exit(0), 500);
    }, 1000);

    return record;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const record: UpdateRecord = {
      from,
      to,
      timestamp: new Date().toISOString(),
      status: "failed",
      error: msg,
    };
    history.push(record);
    throw new Error(`Update failed: ${msg}`);
  } finally {
    applying = false;
  }
}

// Routes
const routes = new Hono();

routes.get("/status", (c) =>
  c.json({
    package: PACKAGE_NAME,
    current: currentVersion,
    latest: latestVersion,
    updateAvailable,
    lastChecked,
    checking,
    applying,
    pollInterval: parseInt(process.env.UPDATE_POLL_INTERVAL || "0", 10),
    autoApply: process.env.UPDATE_AUTO_APPLY === "true",
    history,
  }),
);

routes.post("/check", async (c) => {
  if (checking) {
    return c.json({ error: "Already checking" }, 409);
  }

  try {
    const result = await checkForUpdate();
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 502);
  }
});

routes.get("/_panel", (c) => {
  const statusColor = updateAvailable ? "#f90" : "#4f9";
  const statusText = updateAvailable ? `Update available: ${latestVersion}` : "Up to date";
  return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
    <h3 style="margin:0 0 8px;color:#4f9">Updater</h3>
    <div>Version: <strong>${currentVersion}</strong></div>
    <div>Status: <span style="color:${statusColor}">${statusText}</span></div>
    <div style="color:#666">Last checked: ${lastChecked || "never"}</div>
    ${history.length ? `<div style="margin-top:8px;color:#888">History: ${history.length} updates</div>` : ""}
  </div>`);
});

routes.post("/apply", async (c) => {
  if (applying) {
    return c.json({ error: "Already applying an update" }, 409);
  }

  if (!updateAvailable) {
    // Check first
    try {
      await checkForUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Check failed: ${msg}` }, 502);
    }

    if (!updateAvailable) {
      return c.json({
        message: "Already up to date",
        current: currentVersion,
      });
    }
  }

  try {
    const record = await applyUpdate();
    return c.json({
      message: `Updated ${record.from} → ${record.to} — restarting...`,
      ...record,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// Module definition
const updater: ServiceModule = {
  name: "updater",
  description: "Auto-update reef from npm",
  routes,

  routeDocs: {
    "GET /status": {
      description: "Current version, latest available, update history",
      response:
        "{ package, current, latest, updateAvailable, lastChecked, checking, applying, pollInterval, autoApply, history }",
    },
    "POST /check": {
      description: "Check npm for a newer version",
      response: "{ current, latest, updateAvailable }",
    },
    "POST /apply": {
      description: "Apply the latest update and restart the server",
      response: "{ message, from, to, timestamp, status }",
    },
  },

  init(_ctx: ServiceContext) {
    currentVersion = loadCurrentVersion();

    const pollMinutes = parseInt(process.env.UPDATE_POLL_INTERVAL || "0", 10);
    const autoApply = process.env.UPDATE_AUTO_APPLY === "true";

    if (pollMinutes > 0) {
      console.log(`  [updater] polling every ${pollMinutes}m${autoApply ? " (auto-apply)" : ""}`);

      pollTimer = setInterval(
        async () => {
          try {
            const result = await checkForUpdate();
            if (result.updateAvailable) {
              console.log(`  [updater] new version available: ${result.current} → ${result.latest}`);
              if (autoApply) {
                console.log(`  [updater] auto-applying update...`);
                await applyUpdate();
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  [updater] check failed: ${msg}`);
          }
        },
        pollMinutes * 60 * 1000,
      );
    }
  },

  store: {
    close() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return Promise.resolve();
    },
  },
};

export default updater;

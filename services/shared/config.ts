/**
 * Shared configuration helpers for reef services.
 *
 * Provides cached access to vers-config overrides and generic
 * config resolution (env var → vers-config → null).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERS_CONFIG_PATH = join(process.cwd(), "data", "vers-config.json");

let configCache: { data: Record<string, string>; ts: number } | null = null;
const CONFIG_TTL = 30_000;

/**
 * Read a key from the vers-config override file (data/vers-config.json).
 * Cached with a 30-second TTL to avoid repeated disk reads.
 */
export function loadVersConfigOverride(key: string): string | null {
  const now = Date.now();
  if (configCache && now - configCache.ts < CONFIG_TTL) {
    return configCache.data[key] ?? null;
  }
  try {
    if (!existsSync(VERS_CONFIG_PATH)) {
      configCache = { data: {}, ts: now };
      return null;
    }
    const data = JSON.parse(readFileSync(VERS_CONFIG_PATH, "utf-8"));
    configCache = { data, ts: now };
    return typeof data[key] === "string" ? data[key] : null;
  } catch {
    return null;
  }
}

/**
 * Invalidate the config cache. Call after writing to vers-config.
 */
export function invalidateConfigCache(): void {
  configCache = null;
}

/**
 * Resolve a config value from env var first, then vers-config override.
 */
export function resolveConfig(envKey: string, configKey?: string): string | null {
  const envVal = process.env[envKey];
  if (envVal) return envVal;
  return loadVersConfigOverride(configKey || envKey);
}

/**
 * HTML-escape a string for use in _panel routes.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

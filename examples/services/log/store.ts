/**
 * Log store — append-only work log. Carmack .plan style.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

export interface LogEntry {
  id: string;
  timestamp: string;
  text: string;
  agent?: string;
}

export interface AppendInput {
  text: string;
  agent?: string;
}

export interface QueryOptions {
  since?: string;
  until?: string;
  last?: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return value * 3600_000;
  if (unit === "d") return value * 86400_000;
  return null;
}

export class LogStore {
  private entries: LogEntry[] = [];
  private filePath: string;

  constructor(filePath = "data/log.jsonl") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.entries.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }

  append(input: AppendInput): LogEntry {
    if (!input.text?.trim()) throw new ValidationError("text is required");

    const entry: LogEntry = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      text: input.text.trim(),
    };
    if (input.agent?.trim()) entry.agent = input.agent.trim();

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    return entry;
  }

  query(opts: QueryOptions = {}): LogEntry[] {
    let sinceTime: number | undefined;
    let untilTime: number | undefined;

    if (opts.last) {
      const ms = parseDuration(opts.last);
      if (ms !== null) sinceTime = Date.now() - ms;
    }
    if (opts.since) sinceTime = new Date(opts.since).getTime();
    if (opts.until) untilTime = new Date(opts.until).getTime();

    if (sinceTime === undefined && untilTime === undefined) {
      sinceTime = Date.now() - 86400_000; // default: last 24h
    }

    let result = this.entries;
    if (sinceTime !== undefined) result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceTime!);
    if (untilTime !== undefined) result = result.filter((e) => new Date(e.timestamp).getTime() <= untilTime!);
    return result;
  }

  formatRaw(entries: LogEntry[]): string {
    return entries.map((e) => `[${e.timestamp}]${e.agent ? ` (${e.agent})` : ""} ${e.text}`).join("\n");
  }

  get size(): number {
    return this.entries.length;
  }
}

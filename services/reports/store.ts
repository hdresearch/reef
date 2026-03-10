/**
 * Reports store — markdown reports with tagging.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

export interface Report {
  id: string;
  title: string;
  author: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateReportInput {
  title: string;
  author: string;
  content: string;
  tags?: string[];
}

export interface ReportFilters {
  author?: string;
  tag?: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ReportsStore {
  private reports = new Map<string, Report>();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/reports.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.reports)) {
          for (const r of data.reports) this.reports.set(r.id, r);
        }
      }
    } catch {
      this.reports = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ reports: Array.from(this.reports.values()) }, null, 2));
  }

  create(input: CreateReportInput): Report {
    if (!input.title?.trim()) throw new ValidationError("title is required");
    if (!input.author?.trim()) throw new ValidationError("author is required");
    if (!input.content?.trim()) throw new ValidationError("content is required");

    const now = new Date().toISOString();
    const report: Report = {
      id: ulid(),
      title: input.title.trim(),
      author: input.author.trim(),
      content: input.content,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    this.reports.set(report.id, report);
    this.scheduleSave();
    return report;
  }

  get(id: string): Report | undefined {
    return this.reports.get(id);
  }

  list(filters?: ReportFilters): Report[] {
    let results = Array.from(this.reports.values());
    if (filters?.author) results = results.filter((r) => r.author === filters.author);
    if (filters?.tag) results = results.filter((r) => r.tags.includes(filters.tag!));
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  delete(id: string): boolean {
    const existed = this.reports.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }
}

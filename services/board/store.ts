/**
 * Board store — task tracking with notes and artifacts.
 *
 * Uses Bun's file APIs for persistence. JSON file with debounced writes.
 */

import { ulid } from "ulid";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

export type TaskStatus = "open" | "in_progress" | "in_review" | "blocked" | "done";
export type NoteType = "finding" | "blocker" | "question" | "update";
export type ArtifactType = "branch" | "report" | "deploy" | "diff" | "file" | "url";

export interface Note {
  id: string;
  author: string;
  content: string;
  type: NoteType;
  createdAt: string;
}

export interface Artifact {
  type: ArtifactType;
  url: string;
  label: string;
  addedAt: string;
  addedBy?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  tags: string[];
  dependencies: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: Note[];
  artifacts: Artifact[];
  score: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  dependencies?: string[];
  createdBy: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string | null;
  tags?: string[];
  dependencies?: string[];
}

export interface AddNoteInput {
  author: string;
  content: string;
  type: NoteType;
}

export interface AddArtifactInput {
  type: ArtifactType;
  url: string;
  label: string;
  addedBy?: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  assignee?: string;
  tag?: string;
}

// =============================================================================
// Validation
// =============================================================================

const VALID_STATUSES = new Set<string>(["open", "in_progress", "in_review", "blocked", "done"]);
const VALID_NOTE_TYPES = new Set<string>(["finding", "blocker", "question", "update"]);
const VALID_ARTIFACT_TYPES = new Set<string>(["branch", "report", "deploy", "diff", "file", "url"]);

// =============================================================================
// Errors
// =============================================================================

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// =============================================================================
// Store
// =============================================================================

export class BoardStore {
  private tasks = new Map<string, Task>();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/board.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const file = Bun.file(this.filePath);
      if (existsSync(this.filePath)) {
        // Synchronous read at startup — Bun.file().text() is async,
        // so we use the fs import path for the initial load
        const raw = require("node:fs").readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.tasks)) {
          for (const t of data.tasks) {
            if (!t.artifacts) t.artifacts = [];
            if (t.score === undefined) t.score = 0;
            this.tasks.set(t.id, t);
          }
        }
      }
    } catch {
      this.tasks = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushAsync();
    }, 100);
  }

  private async flushAsync(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ tasks: Array.from(this.tasks.values()) }, null, 2);
    await Bun.write(this.filePath, data);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ tasks: Array.from(this.tasks.values()) }, null, 2);
    require("node:fs").writeFileSync(this.filePath, data, "utf-8");
  }

  // --- CRUD ---

  createTask(input: CreateTaskInput): Task {
    if (!input.title?.trim()) throw new ValidationError("title is required");
    if (!input.createdBy?.trim()) throw new ValidationError("createdBy is required");
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: ulid(),
      title: input.title.trim(),
      description: input.description?.trim(),
      status: input.status || "open",
      assignee: input.assignee?.trim(),
      tags: input.tags || [],
      dependencies: input.dependencies || [],
      createdBy: input.createdBy.trim(),
      createdAt: now,
      updatedAt: now,
      notes: [],
      artifacts: [],
      score: 0,
    };

    this.tasks.set(task.id, task);
    this.scheduleSave();
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(filters?: TaskFilters): Task[] {
    let results = Array.from(this.tasks.values());

    if (filters?.status) results = results.filter((t) => t.status === filters.status);
    if (filters?.assignee) results = results.filter((t) => t.assignee === filters.assignee);
    if (filters?.tag) results = results.filter((t) => t.tags.includes(filters.tag!));

    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError("task not found");

    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }
    if (input.title !== undefined) {
      if (!input.title.trim()) throw new ValidationError("title cannot be empty");
      task.title = input.title.trim();
    }
    if (input.description !== undefined) task.description = input.description?.trim();
    if (input.status !== undefined) task.status = input.status;
    if (input.assignee !== undefined) {
      task.assignee = input.assignee === null ? undefined : input.assignee?.trim();
    }
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.dependencies !== undefined) task.dependencies = input.dependencies;

    task.updatedAt = new Date().toISOString();
    this.tasks.set(id, task);
    this.scheduleSave();
    return task;
  }

  deleteTask(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  bumpTask(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError("task not found");

    task.score = (task.score || 0) + 1;
    task.updatedAt = new Date().toISOString();
    this.tasks.set(id, task);
    this.scheduleSave();
    return task;
  }

  // --- Notes ---

  addNote(taskId: string, input: AddNoteInput): Note {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFoundError("task not found");

    if (!input.author?.trim()) throw new ValidationError("author is required");
    if (!input.content?.trim()) throw new ValidationError("content is required");
    if (!VALID_NOTE_TYPES.has(input.type)) throw new ValidationError(`invalid note type: ${input.type}`);

    const note: Note = {
      id: ulid(),
      author: input.author.trim(),
      content: input.content.trim(),
      type: input.type,
      createdAt: new Date().toISOString(),
    };

    task.notes.push(note);
    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    this.scheduleSave();
    return note;
  }

  getNotes(taskId: string): Note[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFoundError("task not found");
    return task.notes;
  }

  // --- Artifacts ---

  addArtifacts(taskId: string, artifacts: AddArtifactInput[]): Artifact[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFoundError("task not found");

    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      throw new ValidationError("artifacts array is required and must not be empty");
    }

    const now = new Date().toISOString();
    const added: Artifact[] = [];

    for (const a of artifacts) {
      if (!VALID_ARTIFACT_TYPES.has(a.type)) throw new ValidationError(`invalid artifact type: ${a.type}`);
      if (!a.url?.trim()) throw new ValidationError("artifact url is required");
      if (!a.label?.trim()) throw new ValidationError("artifact label is required");

      const artifact: Artifact = {
        type: a.type,
        url: a.url.trim(),
        label: a.label.trim(),
        addedAt: now,
        addedBy: a.addedBy?.trim(),
      };
      task.artifacts.push(artifact);
      added.push(artifact);
    }

    task.updatedAt = now;
    this.tasks.set(taskId, task);
    this.scheduleSave();
    return added;
  }
}

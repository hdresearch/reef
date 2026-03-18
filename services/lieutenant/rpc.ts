/**
 * RPC agent management — spawns and manages pi processes for lieutenants.
 *
 * Two modes:
 *   - Local: pi child process on the same machine (no VM required)
 *   - Remote: pi on a Vers VM via SSH + RPC (FIFOs + tmux)
 *
 * Each lieutenant gets its own long-lived pi process that persists across tasks.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Types
// =============================================================================

export interface RpcHandle {
  send: (cmd: object) => void;
  onEvent: (handler: (event: any) => void) => void;
  kill: () => Promise<void>;
  vmId: string;
  isAlive: () => boolean;
}

export interface LocalRpcOptions {
  systemPrompt?: string;
  model?: string;
  cwd?: string;
}

// =============================================================================
// Local RPC — pi subprocess on the same machine
// =============================================================================

export async function startLocalRpcAgent(name: string, opts: LocalRpcOptions): Promise<RpcHandle> {
  const ltDir = join(homedir(), ".reef", "lieutenants", name);
  const workDir = opts.cwd || join(ltDir, "workspace");
  const sessionDir = join(ltDir, "sessions");

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

  // Write system prompt file if provided
  if (opts.systemPrompt) {
    const promptPath = join(ltDir, "system-prompt.md");
    await Bun.write(promptPath, opts.systemPrompt);
  }

  const piPath = process.env.PI_PATH ?? "pi";
  const args = ["--mode", "rpc", "--no-session"];

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.model) {
    env.PI_MODEL = opts.model;
  }

  const child: ChildProcess = spawn(piPath, args, {
    cwd: workDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(`Failed to spawn pi process for lieutenant "${name}"`);
  }

  let eventHandler: ((event: any) => void) | undefined;
  let killed = false;
  let lineBuf = "";

  child.stdout.on("data", (data: Buffer) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (eventHandler) eventHandler(event);
      } catch {
        /* not JSON */
      }
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`  [lt:${name}] ${msg}`);
  });

  child.on("exit", (code) => {
    if (!killed) {
      console.error(`  [lt:${name}] pi exited with code ${code}`);
    }
  });

  // Wait briefly for process to start
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  if (child.exitCode !== null) {
    throw new Error(`Pi process for "${name}" exited immediately (code ${child.exitCode})`);
  }

  function send(cmd: object) {
    if (killed || !child.stdin || child.exitCode !== null) return;
    try {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    } catch (err) {
      console.error(`  [lt:${name}] send failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function kill() {
    killed = true;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 3000);
        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  return {
    send,
    onEvent: (h) => {
      eventHandler = h;
    },
    kill,
    vmId: `local-${name}`,
    isAlive: () => !killed && child.exitCode === null,
  };
}

// =============================================================================
// RPC readiness check — poll for pi to be ready to accept prompts
// =============================================================================

export function waitForRpcReady(handle: RpcHandle, timeoutMs = 30000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, timeoutMs);

    const originalHandler = handle.onEvent;
    handle.onEvent((event) => {
      if (!resolved && event.type === "response" && event.command === "get_state") {
        resolved = true;
        clearTimeout(timeout);
        resolve(true);
      }
    });

    let attempts = 0;
    const trySend = () => {
      if (resolved || attempts > 10) return;
      attempts++;
      handle.send({ id: "startup-check", type: "get_state" });
      setTimeout(trySend, 2000);
    };
    setTimeout(trySend, 1000);
  });
}

// =============================================================================
// Build system prompt for a lieutenant
// =============================================================================

export function buildSystemPrompt(name: string, role: string): string {
  return [
    `You are a lieutenant agent named "${name}".`,
    `Your role: ${role}`,
    "",
    "You are a persistent, long-lived agent session managed by a coordinator.",
    "You accumulate context across multiple tasks. When given a new task,",
    "you have full memory of previous work in this session.",
    "",
    "You have access to all available tools including file operations, bash, and",
    "any extensions loaded on this machine.",
    "",
    "When you complete a task, end with a clear summary of what was done",
    "and any open questions or next steps.",
  ].join("\n");
}

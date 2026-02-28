/**
 * Branch Executor
 *
 * Handles the lifecycle of a conversation branch:
 *   1. Fork a Vers VM from a commit (isolated environment)
 *   2. Write context to the VM (main's history + task)
 *   3. Run pi on the VM with the task
 *   4. Wait for completion
 *   5. Capture artifacts (what changed, what was built)
 *   6. Return structured results for merge
 *
 * The executor is decoupled from the conversation tree — it takes a context
 * string and a task, returns MergeArtifacts. The tree manages the data model,
 * the executor manages the infrastructure.
 */

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeArtifacts } from "./tree.js";

// =============================================================================
// Vers API Client (minimal — just what branch execution needs)
// =============================================================================

const DEFAULT_BASE_URL = "https://api.vers.sh/api/v1";

export interface VersConfig {
  apiKey: string;
  baseUrl?: string;
}

function resolveVersConfig(override?: Partial<VersConfig>): VersConfig {
  return {
    apiKey: override?.apiKey ?? process.env.VERS_API_KEY ?? "",
    baseUrl: (override?.baseUrl ?? process.env.VERS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

async function versApi<T>(config: VersConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vers API ${method} ${path} (${res.status}): ${text}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return undefined as T;
}

// =============================================================================
// SSH Primitives
// =============================================================================

interface SSHKeyInfo {
  ssh_port: number;
  ssh_private_key: string;
}

const keyCache = new Map<string, string>(); // vmId → keyPath

async function ensureKeyFile(config: VersConfig, vmId: string): Promise<string> {
  const existing = keyCache.get(vmId);
  if (existing) return existing;

  const info = await versApi<SSHKeyInfo>(config, "GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
  const keyDir = join(tmpdir(), "reef-ssh-keys");
  await mkdir(keyDir, { recursive: true });
  const keyPath = join(keyDir, `reef-${vmId.slice(0, 12)}.pem`);
  await writeFile(keyPath, info.ssh_private_key, { mode: 0o600 });
  keyCache.set(vmId, keyPath);
  return keyPath;
}

function sshArgs(keyPath: string, vmId: string): string[] {
  return [
    "-i", keyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=30",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
    `root@${vmId}.vm.vers.sh`,
  ];
}

/** Run a command on a VM via SSH. */
export function sshExec(
  keyPath: string,
  vmId: string,
  command: string,
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = sshArgs(keyPath, vmId);
    const child = spawn("ssh", [...args, command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = opts?.timeoutMs
      ? setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`SSH timeout after ${opts.timeoutMs}ms`)); }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => { if (timeout) clearTimeout(timeout); reject(e); });
    child.on("close", (code) => { if (timeout) clearTimeout(timeout); resolve({ stdout, stderr, exitCode: code ?? 0 }); });
  });
}

/** Copy a file to a VM via SCP. */
export function scpToVm(
  keyPath: string,
  vmId: string,
  localPath: string,
  remotePath: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=30",
      "-o", `ProxyCommand=openssl s_client -connect ${vmId}.vm.vers.sh:443 -servername ${vmId}.vm.vers.sh -quiet 2>/dev/null`,
      localPath,
      `root@${vmId}.vm.vers.sh:${remotePath}`,
    ];
    const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 0, stderr }));
  });
}

/** Copy a file from a VM via SCP. */
export function scpFromVm(
  keyPath: string,
  vmId: string,
  remotePath: string,
  localPath: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=30",
      "-o", `ProxyCommand=openssl s_client -connect ${vmId}.vm.vers.sh:443 -servername ${vmId}.vm.vers.sh -quiet 2>/dev/null`,
      `root@${vmId}.vm.vers.sh:${remotePath}`,
      localPath,
    ];
    const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 0, stderr }));
  });
}

// =============================================================================
// Branch Executor
// =============================================================================

export interface BranchConfig {
  /** Vers VM commit ID to fork from. */
  commitId: string;

  /** Anthropic API key for the pi agent. */
  anthropicApiKey: string;

  /** Optional model override (default: claude-sonnet-4-20250514). */
  model?: string;

  /** Optional Vers API config override. */
  vers?: Partial<VersConfig>;

  /** Max time (ms) to wait for the branch agent. Default: 10 minutes. */
  timeoutMs?: number;

  /** Working directory on the VM. Default: /root/workspace */
  workDir?: string;
}

export interface BranchHandle {
  /** The VM ID this branch is running on. */
  vmId: string;

  /** Wait for the branch to complete and return artifacts. */
  wait(): Promise<MergeArtifacts>;

  /** Abort the branch (kill the agent, keep the VM for inspection). */
  abort(): Promise<void>;

  /** Clean up — delete the VM. Call after merge or abort. */
  cleanup(): Promise<void>;
}

/**
 * Execute a branch: fork VM → write context → run pi → capture artifacts.
 *
 * Returns a BranchHandle that lets you wait for completion, abort, or cleanup.
 * The handle is non-blocking — the agent starts immediately and runs in the background.
 */
export async function executeBranch(
  context: string,
  task: string,
  config: BranchConfig,
): Promise<BranchHandle> {
  const vers = resolveVersConfig(config.vers);
  const workDir = config.workDir ?? "/root/workspace";
  const timeoutMs = config.timeoutMs ?? 10 * 60 * 1000;
  const model = config.model ?? process.env.PI_MODEL ?? "claude-sonnet-4-20250514";

  // 1. Fork VM from commit
  const vm = await versApi<{ vm_id: string }>(vers, "POST", "/vm/from_commit", { commit_id: config.commitId });
  const vmId = vm.vm_id;

  // 2. Wait for VM to be SSH-reachable
  const keyPath = await ensureKeyFile(vers, vmId);
  await waitForBoot(keyPath, vmId);

  // 3. Fix DNS (known Vers issue after restore)
  await sshExec(keyPath, vmId, 'echo "nameserver 8.8.8.8" > /etc/resolv.conf');

  // 4. Write context file to VM
  const contextPath = "/tmp/branch-context.md";
  const contextLocal = join(tmpdir(), `reef-ctx-${vmId.slice(0, 12)}.md`);
  await writeFile(contextLocal, context);
  await scpToVm(keyPath, vmId, contextLocal, contextPath);

  // 5. Start pi as a fire-and-forget task in tmux (survives SSH disconnect)
  const escapedTask = task.replace(/'/g, "'\\''");
  const startScript = `
    set -e
    mkdir -p ${workDir}
    cd ${workDir}

    # Initialize git repo for tracking changes
    if [ ! -d .git ]; then
      git init -q
      git add -A 2>/dev/null || true
      git commit -q -m "branch baseline" --allow-empty 2>/dev/null || true
    else
      git add -A 2>/dev/null || true
      git commit -q -m "branch baseline" --allow-empty 2>/dev/null || true
    fi

    # Start pi in tmux
    export ANTHROPIC_API_KEY='${config.anthropicApiKey}'
    export PI_MODEL='${model}'
    export GIT_EDITOR=true

    tmux new-session -d -s pi-branch "cd ${workDir} && pi -p '${escapedTask}' --append-system-prompt '$(cat ${contextPath})' > /tmp/pi-stdout.log 2> /tmp/pi-stderr.log; echo \\$? > /tmp/pi-exit-code"
    echo "started"
  `;

  const startResult = await sshExec(keyPath, vmId, startScript);
  if (!startResult.stdout.includes("started")) {
    throw new Error(`Failed to start agent on ${vmId}: ${startResult.stderr || startResult.stdout}`);
  }

  // 6. Return handle
  let aborted = false;

  async function wait(): Promise<MergeArtifacts> {
    const start = Date.now();

    // Poll until pi exits (tmux session disappears)
    while (Date.now() - start < timeoutMs) {
      if (aborted) return { summary: "Aborted.", filesChanged: [], error: "aborted" };

      const check = await sshExec(keyPath, vmId, "tmux has-session -t pi-branch 2>/dev/null && echo running || echo done");
      if (check.stdout.trim() === "done") break;

      await sleep(5000);
    }

    // Check if we timed out
    const timedOut = await sshExec(keyPath, vmId, "tmux has-session -t pi-branch 2>/dev/null && echo running || echo done");
    if (timedOut.stdout.trim() === "running") {
      await sshExec(keyPath, vmId, "tmux kill-session -t pi-branch 2>/dev/null || true");
      return { summary: "Timed out.", filesChanged: [], error: `Timed out after ${timeoutMs}ms` };
    }

    // Capture results
    return captureArtifacts(keyPath, vmId, workDir);
  }

  async function abort(): Promise<void> {
    aborted = true;
    await sshExec(keyPath, vmId, "tmux kill-session -t pi-branch 2>/dev/null || true").catch(() => {});
  }

  async function cleanup(): Promise<void> {
    keyCache.delete(vmId);
    await versApi(vers, "DELETE", `/vm/${encodeURIComponent(vmId)}`).catch(() => {});
  }

  return { vmId, wait, abort, cleanup };
}

// =============================================================================
// Artifact Capture
// =============================================================================

/**
 * After pi completes, figure out what happened:
 *   - What files changed (git diff from baseline)
 *   - Exit code
 *   - pi's stdout (the agent's response text)
 *   - Test results if available
 */
async function captureArtifacts(
  keyPath: string,
  vmId: string,
  workDir: string,
): Promise<MergeArtifacts> {
  // Exit code
  const exitResult = await sshExec(keyPath, vmId, "cat /tmp/pi-exit-code 2>/dev/null || echo unknown");
  const exitCode = exitResult.stdout.trim();

  // Pi's stdout (the agent's final output)
  const stdoutResult = await sshExec(keyPath, vmId, "cat /tmp/pi-stdout.log 2>/dev/null || echo ''");
  const agentOutput = stdoutResult.stdout.trim();

  // Changed files (git diff from baseline)
  const diffResult = await sshExec(keyPath, vmId, `cd ${workDir} && git add -A 2>/dev/null && git diff --cached --name-only 2>/dev/null || echo ""`);
  const filesChanged = diffResult.stdout.trim().split("\n").filter(Boolean);

  // Check for test results
  let testsRun: { passed: number; failed: number } | undefined;
  const testResult = await sshExec(keyPath, vmId, `cd ${workDir} && cat /tmp/test-results.json 2>/dev/null || echo ""`);
  if (testResult.stdout.trim()) {
    try {
      testsRun = JSON.parse(testResult.stdout.trim());
    } catch { /* not valid JSON */ }
  }

  // Build summary from agent output (take last meaningful chunk)
  const lines = agentOutput.split("\n").filter(Boolean);
  const summary = lines.length > 0
    ? lines.slice(-10).join("\n")
    : exitCode === "0" ? "Completed successfully." : `Failed (exit code ${exitCode}).`;

  const artifacts: MergeArtifacts = {
    summary,
    filesChanged,
    ...(testsRun ? { testsRun } : {}),
    ...(exitCode !== "0" ? { error: `Exit code: ${exitCode}` } : {}),
  };

  return artifacts;
}

// =============================================================================
// Helpers
// =============================================================================

async function waitForBoot(keyPath: string, vmId: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const check = await sshExec(keyPath, vmId, "echo ready", { timeoutMs: 10000 });
      if (check.stdout.trim() === "ready") return;
    } catch { /* not ready yet */ }
    await sleep(2000);
  }
  throw new Error(`VM ${vmId} failed to become SSH-reachable after ${maxRetries * 2}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

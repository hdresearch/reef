/**
 * RPC agent management — spawns and manages pi processes for lieutenants.
 *
 * Two modes:
 *   - Local: pi child process on the same machine (no VM required)
 *   - Remote: pi on a Vers VM via SSH + RPC (FIFOs + tmux)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;
const RPC_OUT = `${RPC_DIR}/out`;
const RPC_ERR = `${RPC_DIR}/err`;
const DEFAULT_VERS_BASE_URL = "https://api.vers.sh/api/v1";

type EventHandler = (event: any) => void;

export interface RpcHandle {
  send: (cmd: object) => void;
  onEvent: (handler: EventHandler) => () => void;
  kill: () => Promise<void>;
  vmId: string;
  isAlive: () => boolean;
  reconnectTail?: () => void;
  suspendTail?: () => void;
}

export interface LocalRpcOptions {
  anthropicApiKey?: string;
  systemPrompt?: string;
  model?: string;
  cwd?: string;
}

export interface RemoteRpcOptions {
  anthropicApiKey: string;
  systemPrompt?: string;
  model?: string;
}

interface SSHKeyInfo {
  ssh_port: number;
  ssh_private_key: string;
}

const keyCache = new Map<string, string>();

function createHandlerSet() {
  const handlers = new Set<EventHandler>();
  return {
    emit(event: any) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[lieutenant-rpc] handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    subscribe(handler: EventHandler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

function loadVersApiKey(): string {
  if (process.env.VERS_API_KEY) return process.env.VERS_API_KEY;
  try {
    const data = readFileSync(join(homedir(), ".vers", "keys.json"), "utf-8");
    return JSON.parse(data)?.keys?.VERS_API_KEY || "";
  } catch {
    return "";
  }
}

function getVersBaseUrl(): string {
  return process.env.VERS_BASE_URL || DEFAULT_VERS_BASE_URL;
}

async function versApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = loadVersApiKey();
  if (!apiKey) throw new Error("VERS_API_KEY is not configured");

  const res = await fetch(`${getVersBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vers API ${method} ${path} failed (${res.status}): ${text}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return (await res.json()) as T;
  return undefined as T;
}

async function ensureKeyFile(vmId: string): Promise<string> {
  const cached = keyCache.get(vmId);
  if (cached && existsSync(cached)) return cached;

  const info = await versApi<SSHKeyInfo>("GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
  const keyDir = join(tmpdir(), "vers-ssh-keys");
  mkdirSync(keyDir, { recursive: true });
  const keyPath = join(keyDir, `vers-${vmId.slice(0, 16)}.pem`);
  writeFileSync(keyPath, info.ssh_private_key, { mode: 0o600 });
  keyCache.set(vmId, keyPath);
  return keyPath;
}

function sshArgs(keyPath: string, vmId: string): string[] {
  return [
    "-i",
    keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=30",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null",
    `root@${vmId}.vm.vers.sh`,
  ];
}

async function sshExec(
  keyPath: string,
  vmId: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(keyPath, vmId), command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function buildRemoteEnv(opts: RemoteRpcOptions): string {
  const exports = [
    `export ANTHROPIC_API_KEY='${opts.anthropicApiKey.replace(/'/g, "'\\''")}'`,
    process.env.VERS_API_KEY ? `export VERS_API_KEY='${loadVersApiKey().replace(/'/g, "'\\''")}'` : "",
    process.env.VERS_BASE_URL ? `export VERS_BASE_URL='${process.env.VERS_BASE_URL.replace(/'/g, "'\\''")}'` : "",
    process.env.VERS_INFRA_URL ? `export VERS_INFRA_URL='${process.env.VERS_INFRA_URL.replace(/'/g, "'\\''")}'` : "",
    process.env.VERS_AUTH_TOKEN ? `export VERS_AUTH_TOKEN='${process.env.VERS_AUTH_TOKEN.replace(/'/g, "'\\''")}'` : "",
    process.env.VERS_AGENT_NAME
      ? `export VERS_PARENT_AGENT='${process.env.VERS_AGENT_NAME.replace(/'/g, "'\\''")}'`
      : "export VERS_PARENT_AGENT='reef'",
    "export GIT_EDITOR=true",
  ]
    .filter(Boolean)
    .join("; ");

  return exports;
}

export async function createVersVmFromCommit(commitId: string): Promise<{ vmId: string }> {
  const vm = await versApi<{ vm_id: string }>("POST", "/vm/from_commit", { commit_id: commitId });
  await ensureKeyFile(vm.vm_id);
  return { vmId: vm.vm_id };
}

export async function deleteVersVm(vmId: string): Promise<void> {
  await versApi("DELETE", `/vm/${encodeURIComponent(vmId)}`);
  const keyPath = keyCache.get(vmId);
  if (keyPath) {
    keyCache.delete(vmId);
  }
}

export async function setVersVmState(vmId: string, state: "Paused" | "Running"): Promise<void> {
  await versApi("PATCH", `/vm/${encodeURIComponent(vmId)}/state`, { state });
}

export async function getVersVmState(vmId: string): Promise<string> {
  const result = await versApi<{ state: string }>("GET", `/vm/${encodeURIComponent(vmId)}/status`);
  return result.state;
}

export async function waitForSshReady(vmId: string, attempts = 30, delayMs = 2000): Promise<string> {
  const keyPath = await ensureKeyFile(vmId);

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await sshExec(keyPath, vmId, "echo ready");
      if (result.stdout.trim() === "ready") return keyPath;
    } catch {
      // VM still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`VM ${vmId} failed to boot within ${(attempts * delayMs) / 1000}s`);
}

export async function waitForRemoteRpcSession(vmId: string, attempts = 15, delayMs = 2000): Promise<void> {
  const keyPath = await ensureKeyFile(vmId);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await sshExec(keyPath, vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok");
      if (result.stdout.includes("ok")) return;
    } catch {
      // Session not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Lieutenant VM ${vmId} resumed but pi-rpc session was not found`);
}

function createRemoteHandle(vmId: string, keyPath: string, skipExistingOutput: boolean): RpcHandle {
  const handlers = createHandlerSet();
  let tailChild: ReturnType<typeof spawn> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;
  let lineBuffer = "";
  let linesProcessed = skipExistingOutput ? -1 : 0;

  const startTail = () => {
    if (killed) return;

    const tailArg = linesProcessed < 0 ? "-n 0" : `-n +${Math.max(linesProcessed + 1, 1)}`;
    tailChild = spawn("ssh", [...sshArgs(keyPath, vmId), `tail -f ${tailArg} ${RPC_OUT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (linesProcessed < 0) linesProcessed = 0;

    tailChild.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        linesProcessed++;
        if (!line.trim()) continue;
        try {
          handlers.emit(JSON.parse(line));
        } catch {
          // Ignore non-JSON output from the RPC stream.
        }
      }
    });

    tailChild.on("close", () => {
      if (killed) return;
      lineBuffer = "";
      reconnectTimer = setTimeout(() => {
        startTail();
      }, 3000);
    });
  };

  const suspendTail = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (tailChild) {
      try {
        tailChild.kill("SIGTERM");
      } catch {
        // Ignore shutdown races.
      }
      tailChild = null;
    }
  };

  startTail();

  return {
    send(cmd: object) {
      if (killed) return;
      const writer = spawn("ssh", [...sshArgs(keyPath, vmId), `cat > ${RPC_IN}`], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      writer.stdin.write(`${JSON.stringify(cmd)}\n`);
      writer.stdin.end();
    },
    onEvent(handler: EventHandler) {
      return handlers.subscribe(handler);
    },
    async kill() {
      killed = true;
      suspendTail();
      try {
        await sshExec(
          keyPath,
          vmId,
          `tmux kill-session -t pi-rpc 2>/dev/null || true
tmux kill-session -t pi-keeper 2>/dev/null || true
rm -rf ${RPC_DIR}`,
        );
      } catch {
        // VM may already be gone.
      }
    },
    vmId,
    isAlive() {
      return !killed;
    },
    reconnectTail() {
      suspendTail();
      startTail();
    },
    suspendTail,
  };
}

export async function startRemoteRpcAgent(vmId: string, opts: RemoteRpcOptions): Promise<RpcHandle> {
  const keyPath = await ensureKeyFile(vmId);
  const envExports = buildRemoteEnv(opts);

  let piCommand = "pi --mode rpc";
  if (opts.systemPrompt) {
    const escapedPrompt = opts.systemPrompt.replace(/'/g, "'\\''");
    await sshExec(
      keyPath,
      vmId,
      `mkdir -p /root/.pi/agent && cat > /root/.pi/agent/system-prompt.md << 'SYSPROMPT_EOF'
${escapedPrompt}
SYSPROMPT_EOF`,
    );
    piCommand += " --system-prompt /root/.pi/agent/system-prompt.md";
  }

  const startScript = `
set -e
mkdir -p ${RPC_DIR}
rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR}
mkfifo ${RPC_IN}
touch ${RPC_OUT} ${RPC_ERR}
tmux kill-session -t pi-keeper 2>/dev/null || true
tmux kill-session -t pi-rpc 2>/dev/null || true
tmux new-session -d -s pi-keeper "sleep infinity > ${RPC_IN}"
tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; ${piCommand} < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"
sleep 1
tmux has-session -t pi-rpc 2>/dev/null && echo daemon_started || echo daemon_failed
`;

  const result = await sshExec(keyPath, vmId, startScript);
  if (!result.stdout.includes("daemon_started")) {
    throw new Error(`Failed to start pi RPC on ${vmId}: ${result.stderr || result.stdout}`);
  }

  const handle = createRemoteHandle(vmId, keyPath, false);
  if (opts.model) {
    handle.send({ type: "set_model", provider: "anthropic", modelId: opts.model });
  }
  return handle;
}

export async function reconnectRemoteRpcAgent(vmId: string): Promise<RpcHandle> {
  const keyPath = await ensureKeyFile(vmId);
  const result = await sshExec(keyPath, vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok || echo gone");
  if (!result.stdout.includes("ok")) {
    throw new Error(`Pi RPC session not found on VM ${vmId}`);
  }
  return createRemoteHandle(vmId, keyPath, true);
}

export async function startLocalRpcAgent(name: string, opts: LocalRpcOptions): Promise<RpcHandle> {
  const ltDir = join(process.cwd(), "data", "lieutenants", name);
  const workDir = opts.cwd || join(ltDir, "workspace");
  const homeDir = join(ltDir, "home");

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });

  const piPath = process.env.PI_PATH ?? "pi";
  const args = ["--mode", "rpc", "--no-session"];

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.model) env.PI_MODEL = opts.model;
  if (opts.anthropicApiKey) env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
  if (!env.VERS_PARENT_AGENT) env.VERS_PARENT_AGENT = process.env.VERS_AGENT_NAME || "reef";
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;

  const child: ChildProcess = spawn(piPath, args, {
    cwd: workDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(`Failed to spawn pi process for lieutenant "${name}"`);
  }

  const handlers = createHandlerSet();
  let killed = false;
  let lineBuffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handlers.emit(JSON.parse(line));
      } catch {
        // Ignore non-JSON output from pi.
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`  [lt:${name}] ${msg}`);
  });

  child.on("exit", (code) => {
    if (!killed) {
      console.error(`  [lt:${name}] pi exited with code ${code}`);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode !== null) {
    throw new Error(`Pi process for "${name}" exited immediately (code ${child.exitCode})`);
  }

  return {
    send(cmd: object) {
      if (killed || child.exitCode !== null) return;
      child.stdin?.write(`${JSON.stringify(cmd)}\n`);
    },
    onEvent(handler: EventHandler) {
      return handlers.subscribe(handler);
    },
    async kill() {
      killed = true;
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore forced shutdown race.
          }
          resolve();
        }, 3000);
        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    vmId: `local-${name}`,
    isAlive() {
      return !killed && child.exitCode === null;
    },
  };
}

export function waitForRpcReady(handle: RpcHandle, timeoutMs = 30000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      resolve(false);
    }, timeoutMs);

    const unsubscribe = handle.onEvent((event) => {
      if (resolved) return;
      if (event.type === "response" && event.command === "get_state") {
        resolved = true;
        clearTimeout(timeout);
        unsubscribe();
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

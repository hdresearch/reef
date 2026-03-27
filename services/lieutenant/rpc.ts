/**
 * RPC agent management — spawns and manages pi processes for lieutenants.
 *
 * Lieutenants run on Vers VMs via SSH + RPC (FIFOs + tmux).
 */

import { spawn } from "node:child_process";
import { loadVersKeyFromDisk, resolveAgentBinary, VersClient } from "@hdresearch/pi-v/core";

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;
const RPC_OUT = `${RPC_DIR}/out`;
const RPC_ERR = `${RPC_DIR}/err`;

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

export interface RemoteRpcOptions {
  name?: string;
  llmProxyKey?: string;
  systemPrompt?: string;
  model?: string;
  agentsMd?: string; // v2: full AGENTS.md content to write to child VM
  directive?: string; // v2: hard guardrails (VERS_AGENT_DIRECTIVE)
  effort?: string; // v2: thinking effort level (low, medium, high)
}
const versClient = new VersClient();

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

function escapeEnvValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function buildPersistVmIdScript(vmId: string): string {
  const escapedVmId = escapeEnvValue(vmId);
  return `mkdir -p /etc/profile.d
touch /etc/profile.d/reef-agent.sh
if grep -q '^export VERS_VM_ID=' /etc/profile.d/reef-agent.sh 2>/dev/null; then
  sed -i "s|^export VERS_VM_ID=.*$|export VERS_VM_ID='${escapedVmId}'|" /etc/profile.d/reef-agent.sh
else
  printf "\\nexport VERS_VM_ID='${escapedVmId}'\\n" >> /etc/profile.d/reef-agent.sh
fi`;
}

/**
 * Persist runtime config (LLM_PROXY_KEY, VERS_API_KEY, VERS_INFRA_URL,
 * VERS_GOLDEN_COMMIT_ID) into /etc/profile.d/reef-agent.sh so they survive
 * process crashes and VM reboots. These are NOT baked into the golden image —
 * they're injected post-spawn and cascade to all children.
 * Uses upsert logic: replace existing lines or append if missing.
 */
export function buildPersistKeysScript(opts: RemoteRpcOptions): string {
  const llmKey = opts.llmProxyKey || process.env.LLM_PROXY_KEY || "";
  const versKey = process.env.VERS_API_KEY || loadVersKeyFromDisk();
  const infraUrl = process.env.VERS_INFRA_URL || "";
  const goldenCommitId = process.env.VERS_GOLDEN_COMMIT_ID || "";
  const lines: string[] = ["mkdir -p /etc/profile.d", "touch /etc/profile.d/reef-agent.sh"];

  for (const [envName, value] of [
    ["LLM_PROXY_KEY", llmKey],
    ["VERS_API_KEY", versKey],
    ["VERS_INFRA_URL", infraUrl],
    ["VERS_GOLDEN_COMMIT_ID", goldenCommitId],
  ] as const) {
    if (!value) continue;
    const escaped = escapeEnvValue(value);
    lines.push(
      `if grep -q '^export ${envName}=' /etc/profile.d/reef-agent.sh 2>/dev/null; then`,
      `  sed -i "s|^export ${envName}=.*$|export ${envName}='${escaped}'|" /etc/profile.d/reef-agent.sh`,
      `else`,
      `  printf "\\nexport ${envName}='${escaped}'\\n" >> /etc/profile.d/reef-agent.sh`,
      `fi`,
    );
  }

  return lines.join("\n");
}

export function buildRemoteEnv(vmId: string, opts: RemoteRpcOptions): string {
  const versApiKey = process.env.VERS_API_KEY || loadVersKeyFromDisk();
  const exports = [
    opts.llmProxyKey
      ? `export LLM_PROXY_KEY='${escapeEnvValue(opts.llmProxyKey)}'`
      : process.env.LLM_PROXY_KEY
        ? `export LLM_PROXY_KEY='${escapeEnvValue(process.env.LLM_PROXY_KEY)}'`
        : "",
    // Alias ANTHROPIC_API_KEY to LLM_PROXY_KEY so punkin's AI package initializes
    opts.llmProxyKey
      ? `export ANTHROPIC_API_KEY='${escapeEnvValue(opts.llmProxyKey)}'`
      : process.env.LLM_PROXY_KEY
        ? `export ANTHROPIC_API_KEY='${escapeEnvValue(process.env.LLM_PROXY_KEY)}'`
        : "",
    versApiKey ? `export VERS_API_KEY='${escapeEnvValue(versApiKey)}'` : "",
    process.env.GITHUB_TOKEN ? `export GITHUB_TOKEN='${escapeEnvValue(process.env.GITHUB_TOKEN)}'` : "",
    process.env.VERS_BASE_URL ? `export VERS_BASE_URL='${escapeEnvValue(process.env.VERS_BASE_URL)}'` : "",
    process.env.VERS_INFRA_URL ? `export VERS_INFRA_URL='${escapeEnvValue(process.env.VERS_INFRA_URL)}'` : "",
    process.env.VERS_AUTH_TOKEN ? `export VERS_AUTH_TOKEN='${escapeEnvValue(process.env.VERS_AUTH_TOKEN)}'` : "",
    process.env.VERS_GOLDEN_COMMIT_ID
      ? `export VERS_GOLDEN_COMMIT_ID='${escapeEnvValue(process.env.VERS_GOLDEN_COMMIT_ID)}'`
      : "",
    `export VERS_VM_ID='${escapeEnvValue(vmId)}'`,
    process.env.PI_PATH ? `export PI_PATH='${escapeEnvValue(process.env.PI_PATH)}'` : "",
    process.env.PUNKIN_BIN ? `export PUNKIN_BIN='${escapeEnvValue(process.env.PUNKIN_BIN)}'` : "",
    `export PI_VERS_HOME='${escapeEnvValue(process.env.PI_VERS_HOME || "/root/pi-vers")}'`,
    `export SERVICES_DIR='${escapeEnvValue(process.env.SERVICES_DIR || "/root/reef/services-active")}'`,
    // v2: category-based identity
    "export REEF_CATEGORY='lieutenant'",
    opts.name ? `export VERS_AGENT_NAME='${escapeEnvValue(opts.name)}'` : "",
    process.env.VERS_VM_ID ? `export REEF_PARENT_VM_ID='${escapeEnvValue(process.env.VERS_VM_ID)}'` : "",
    process.env.VERS_VM_ID
      ? `export REEF_ROOT_VM_ID='${escapeEnvValue(process.env.REEF_ROOT_VM_ID || process.env.VERS_VM_ID)}'`
      : "",
    opts.directive ? `export VERS_AGENT_DIRECTIVE='${escapeEnvValue(opts.directive)}'` : "",
    process.env.VERS_AGENT_NAME
      ? `export VERS_PARENT_AGENT='${escapeEnvValue(process.env.VERS_AGENT_NAME)}'`
      : "export VERS_PARENT_AGENT='reef'",
    "export GIT_EDITOR=true",
  ]
    .filter(Boolean)
    .join("; ");

  return exports;
}

function resolveModelProvider(): "vers" {
  return "vers";
}

export async function createVersVmFromCommit(commitId: string): Promise<{ vmId: string }> {
  const vm = await versClient.restoreFromCommit(commitId);
  await versClient.ensureKeyFile(vm.vm_id);
  return { vmId: vm.vm_id };
}

export async function deleteVersVm(vmId: string): Promise<void> {
  await versClient.delete(vmId);
}

export async function setVersVmState(vmId: string, state: "Paused" | "Running"): Promise<void> {
  await versClient.updateState(vmId, state);
}

export async function getVersVmState(vmId: string): Promise<string> {
  return await versClient.getState(vmId);
}

export async function waitForSshReady(vmId: string, attempts = 30, delayMs = 2000): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await versClient.exec(vmId, "echo ready");
      if (result.stdout.trim() === "ready") return await versClient.ensureKeyFile(vmId);
    } catch {
      // VM still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`VM ${vmId} failed to boot within ${(attempts * delayMs) / 1000}s`);
}

export async function waitForRemoteRpcSession(vmId: string, attempts = 15, delayMs = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await versClient.exec(vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok");
      if (result.stdout.includes("ok")) return;
    } catch {
      // Session not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Lieutenant VM ${vmId} resumed but pi-rpc session was not found`);
}

function createRemoteHandle(vmId: string, sshBaseArgs: string[], skipExistingOutput: boolean): RpcHandle {
  const handlers = createHandlerSet();
  let tailChild: ReturnType<typeof spawn> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;
  let lineBuffer = "";
  let linesProcessed = skipExistingOutput ? -1 : 0;

  const startTail = () => {
    if (killed) return;

    const tailArg = linesProcessed < 0 ? "-n 0" : `-n +${Math.max(linesProcessed + 1, 1)}`;
    tailChild = spawn("ssh", [...sshBaseArgs, `tail -f ${tailArg} ${RPC_OUT}`], {
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
      const writer = spawn("ssh", [...sshBaseArgs, `cat > ${RPC_IN}`], {
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
        await versClient.exec(
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
  const sshBaseArgs = await versClient.sshArgs(vmId);
  const envExports = buildRemoteEnv(vmId, opts);

  await versClient.exec(vmId, buildPersistVmIdScript(vmId));
  await versClient.exec(vmId, buildPersistKeysScript(opts));

  // v2: Write inherited AGENTS.md to child VM
  if (opts.agentsMd) {
    const safeContent = opts.agentsMd.replace(/AGENTS_MD_EOF/g, "AGENTS_MD_E0F");
    await versClient.exec(
      vmId,
      `mkdir -p /root/.pi/agent && cat > /root/.pi/agent/AGENTS.md << 'AGENTS_MD_EOF'\n${safeContent}\nAGENTS_MD_EOF`,
    );
  }

  let piCommand = `${resolveAgentBinary()} --mode rpc`;
  if (opts.agentsMd) {
    // v2: Use AGENTS.md as the system prompt (it includes inherited context)
    piCommand += " --system-prompt /root/.pi/agent/AGENTS.md";
  } else if (opts.systemPrompt) {
    // v1 fallback: use the old system prompt
    const escapedPrompt = escapeEnvValue(opts.systemPrompt);
    await versClient.exec(
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

  const result = await versClient.exec(vmId, startScript);
  if (!result.stdout.includes("daemon_started")) {
    throw new Error(`Failed to start pi RPC on ${vmId}: ${result.stderr || result.stdout}`);
  }

  const handle = createRemoteHandle(vmId, sshBaseArgs, false);
  if (opts.model) {
    const setModelMsg: any = { type: "set_model", provider: resolveModelProvider(), modelId: opts.model };
    if (opts.effort) setModelMsg.thinkingLevel = opts.effort;
    handle.send(setModelMsg);
  }
  return handle;
}

export async function reconnectRemoteRpcAgent(vmId: string): Promise<RpcHandle> {
  const sshBaseArgs = await versClient.sshArgs(vmId);
  const result = await versClient.exec(vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok || echo gone");
  if (!result.stdout.includes("ok")) {
    throw new Error(`Pi RPC session not found on VM ${vmId}`);
  }
  return createRemoteHandle(vmId, sshBaseArgs, true);
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

export function buildSystemPrompt(name: string, role: string, profileCtx?: string): string {
  const lines = [
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
  ];

  if (profileCtx) {
    lines.push("", profileCtx);
  }

  return lines.join("\n");
}

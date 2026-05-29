import type { CanUseTool, PermissionResult, HookCallback, HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { sendCard, updateCard } from "./feishu.js";

type RiskLevel = "safe" | "warn" | "dangerous";
type PermissionPolicy = "bypass" | "cautious" | "strict";

const BASE_SAFE_TOOLS = ["Read", "Glob", "Grep"];

function parseSafeTools(): string[] {
  const env = process.env.CLAUDE_SAFE_TOOLS;
  if (!env) return BASE_SAFE_TOOLS;
  const extra = env.split(",").map((t) => t.trim()).filter(Boolean);
  return [...new Set([...BASE_SAFE_TOOLS, ...extra])];
}

const DEFAULT_DANGEROUS_PATTERNS = [
  // git 不可逆操作
  "git push",
  "git reset --hard",
  "git clean",
  "git checkout -- .",
  "git rebase",
  "git merge",
  "git branch -d",
  "git branch -D",
  "git stash drop",
  "git tag -d",
  // 文件删除
  "rm ",
  "rm -",
  "rmdir",
  "del ",
  "del /",
  "rd ",
  "rd /",
  "remove-item",
  "unlink",
  // 数据库
  "DROP TABLE",
  "DROP DATABASE",
  "TRUNCATE",
  "DELETE FROM",
  // 系统危险操作
  "shutdown",
  "reboot",
  "format",
  "mkfs",
  "chmod",
  "chown",
  // 包管理（全局安装、发布）
  "npm publish",
  "npm install -g",
  "npx ",
  // 进程与网络
  "kill ",
  "taskkill",
  "curl ",
];

function getPolicy(): PermissionPolicy {
  const val = process.env.CLAUDE_PERMISSION_POLICY;
  if (val === "cautious" || val === "strict") return val;
  return "bypass";
}

function getDangerousPatterns(): string[] {
  const env = process.env.CLAUDE_DANGEROUS_PATTERNS;
  if (!env) return DEFAULT_DANGEROUS_PATTERNS;
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

function getApprovalTimeout(): number {
  const val = parseInt(process.env.CLAUDE_APPROVAL_TIMEOUT_MS || "", 10);
  return val > 0 ? val : 60_000;
}

function classifyRisk(toolName: string, input: Record<string, unknown>): RiskLevel {
  const safeTools = parseSafeTools();
  if (safeTools.includes(toolName)) return "safe";

  if (toolName === "Bash") {
    const command = String(input.command || "").toLowerCase();
    const patterns = getDangerousPatterns();
    for (const pattern of patterns) {
      if (command.includes(pattern.toLowerCase())) return "dangerous";
    }
    return "warn";
  }

  return "warn";
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return String(input.command || "").slice(0, 500);
  if (toolName === "Write") return `Write → ${input.file_path}`;
  if (toolName === "Edit") return `Edit → ${input.file_path}`;
  return `${toolName}: ${JSON.stringify(input).slice(0, 300)}`;
}

// --- Pending approval state ---

interface PendingApproval {
  resolve: (result: PermissionResult) => void;
  toolName: string;
  summary: string;
  cardMessageId?: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

export function hasPendingApproval(chatId: string): boolean {
  return pendingApprovals.has(chatId);
}

export function resolveApproval(chatId: string, approved: boolean): void {
  const pending = pendingApprovals.get(chatId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingApprovals.delete(chatId);

  const label = approved ? "✅ 已批准" : "❌ 已拒绝";
  const color = approved ? "green" : "red";

  if (pending.cardMessageId) {
    updateCard(pending.cardMessageId, {
      header: { template: color, title: { tag: "plain_text", content: label } },
      elements: [
        { tag: "markdown", content: `**${pending.toolName}**: ${pending.summary.slice(0, 200)}` },
      ],
    }).catch(() => {});
  }

  if (approved) {
    console.log(`[权限] 用户批准: ${pending.toolName}`);
    pending.resolve({ behavior: "allow" });
  } else {
    console.log(`[权限] 用户拒绝: ${pending.toolName}`);
    pending.resolve({ behavior: "deny", message: "用户拒绝了该操作" });
  }
}

function timeoutApproval(chatId: string): void {
  const pending = pendingApprovals.get(chatId);
  if (!pending) return;

  pendingApprovals.delete(chatId);

  if (pending.cardMessageId) {
    updateCard(pending.cardMessageId, {
      header: { template: "orange", title: { tag: "plain_text", content: "⏰ 审批超时" } },
      elements: [
        { tag: "markdown", content: `**${pending.toolName}**: ${pending.summary.slice(0, 200)}\n\n已自动拒绝` },
      ],
    }).catch(() => {});
  }

  console.log(`[权限] 审批超时，自动拒绝: ${pending.toolName}`);
  pending.resolve({ behavior: "deny", message: "审批超时，操作已被自动拒绝" });
}

async function requestApproval(
  chatId: string,
  toolName: string,
  input: Record<string, unknown>,
  sdkTitle: string | undefined,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const summary = summarizeToolCall(toolName, input);
  const timeout = getApprovalTimeout();
  const timeoutSec = Math.round(timeout / 1000);

  const title = sdkTitle || `Claude 请求执行: ${toolName}`;

  console.log(`[requestApproval] 发送审批卡片 tool=${toolName} summary="${summary.slice(0, 60)}"`);

  let cardMessageId: string | undefined;
  try {
    cardMessageId = await sendCard(chatId, {
      header: { template: "red", title: { tag: "plain_text", content: "🔐 权限审批" } },
      elements: [
        { tag: "markdown", content: `**操作**: ${title}` },
        { tag: "markdown", content: `\`\`\`\n${summary}\n\`\`\`` },
        { tag: "hr" },
        { tag: "markdown", content: `回复 **y** 批准 / **n** 拒绝（${timeoutSec}s 内未回复将自动拒绝）` },
      ],
    });
    console.log(`[requestApproval] 审批卡片已发送 msgId=${cardMessageId}`);
  } catch (err) {
    console.error(`[requestApproval] 发送审批卡片失败`, err);
    return { behavior: "deny", message: "审批卡片发送失败，操作被拒绝" };
  }

  console.log(`[requestApproval] 开始等待用户回复...`);

  return new Promise<PermissionResult>((resolve) => {
    const timer = setTimeout(() => timeoutApproval(chatId), timeout);

    const onAbort = () => {
      if (pendingApprovals.has(chatId)) {
        clearTimeout(timer);
        pendingApprovals.delete(chatId);
        console.log(`[requestApproval] 任务取消，自动拒绝: ${toolName}`);
        resolve({ behavior: "deny", message: "任务已取消" });
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    pendingApprovals.set(chatId, {
      resolve: (result) => {
        console.log(`[requestApproval] 收到审批结果 tool=${toolName} behavior=${result.behavior}`);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      toolName,
      summary,
      cardMessageId,
      timer,
    });
  });
}

// --- Factory ---

export type ToolLogCallback = (toolName: string, summary: string) => void;

export function createCanUseTool(_chatId: string): CanUseTool {
  const policy = getPolicy();

  return async (toolName, input) => {
    const risk = classifyRisk(toolName, input);
    console.log(`[canUseTool] tool=${toolName} risk=${risk} policy=${policy}`);

    // 非 safe 的工具决策已全部由 PreToolUse hook 处理，canUseTool 仅兜底 safe
    if (policy === "strict" && risk !== "safe") {
      return { behavior: "deny", message: `严格模式：${toolName} 未被预批准` };
    }
    return { behavior: "allow" };
  };
}

// --- PreToolUse hook（危险操作审批的真正阻断点）---

export function createPreToolUseHook(
  chatId: string,
  onToolLog?: ToolLogCallback,
): HookCallback {
  const policy = getPolicy();

  return async (input, _toolUseId, { signal }): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const toolName = hookInput.tool_name;
    const toolInput = (hookInput.tool_input || {}) as Record<string, unknown>;
    const risk = classifyRisk(toolName, toolInput);
    console.log(`[preToolUseHook] tool=${toolName} risk=${risk} policy=${policy}`);

    // bypass：全部不决策，交给 SDK 默认（已 allowDangerouslySkipPermissions）
    if (policy === "bypass") {
      return {};
    }

    // safe：交给 canUseTool（safe 工具已在 allowedTools，canUseTool 会被有效调用并放行）
    if (risk === "safe") {
      return {};
    }

    // strict：非 safe 一律拒绝
    if (policy === "strict") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `严格模式：${toolName} 未被预批准`,
        },
      };
    }

    // cautious + warn：通知 + 放行（hook 必须显式 allow，否则不在 allowedTools 的 Bash 会被阻止）
    if (risk === "warn") {
      const summary = summarizeToolCall(toolName, toolInput);
      if (onToolLog) onToolLog(toolName, summary);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "普通操作自动放行",
        },
      };
    }

    // cautious + dangerous：发飞书审批，等用户回复
    console.log(`[preToolUseHook] 进入审批流程 tool=${toolName}`);
    const result = await requestApproval(chatId, toolName, toolInput, undefined, signal);

    if (result.behavior === "allow") {
      // 批准 → hook 直接放行（落到 canUseTool 无法放行不在 allowedTools 的 Bash）
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "用户已批准该操作",
        },
      };
    }

    const reason = result.behavior === "deny" && result.message
      ? result.message
      : "用户拒绝了该操作";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

export function isCustomPolicyActive(): boolean {
  const policy = getPolicy();
  return policy !== "bypass";
}

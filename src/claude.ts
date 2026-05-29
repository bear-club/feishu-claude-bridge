import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { isCustomPolicyActive } from "./permission.js";

export interface ClaudeResult {
  sessionId: string;
  result: string;
  costUsd: number;
  isError: boolean;
}

export type ProgressCallback = (text: string) => void;

const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
const BASE_SAFE_TOOLS = ["Read", "Glob", "Grep"];

function parseSafeTools(): string[] {
  const env = process.env.CLAUDE_SAFE_TOOLS;
  if (!env) return BASE_SAFE_TOOLS;
  const extra = env.split(",").map((t) => t.trim()).filter(Boolean);
  return [...new Set([...BASE_SAFE_TOOLS, ...extra])];
}

function parseAllowedTools(): string[] {
  const env = process.env.CLAUDE_ALLOWED_TOOLS;
  if (!env) return DEFAULT_ALLOWED_TOOLS;
  return env.split(",").map((t) => t.trim()).filter(Boolean);
}

export async function callClaude(
  prompt: string,
  options: {
    cwd?: string;
    resume?: string;
    abortController?: AbortController;
    onProgress?: ProgressCallback;
    canUseTool?: CanUseTool;
    hooks?: Options["hooks"];
  }
): Promise<ClaudeResult> {
  const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";
  const allowedTools = parseAllowedTools();
  const customPolicy = isCustomPolicyActive();
  const safeTools = parseSafeTools();

  const effectiveTools = customPolicy ? allowedTools : undefined;
  const effectiveAllowedTools = customPolicy
    ? allowedTools.filter((t) => safeTools.includes(t))
    : allowedTools;
  const effectivePermissionMode = customPolicy ? undefined : "bypassPermissions" as const;
  const effectiveSkipPerms = !customPolicy;

  console.log(`[callClaude] model=${model} resume=${options.resume ? "yes" : "no"} customPolicy=${customPolicy} tools=${effectiveTools} allowedTools=${effectiveAllowedTools} skipPerms=${effectiveSkipPerms}`);

  let sessionId = "";
  let result = "";
  let costUsd = 0;
  let isError = false;

  for await (const message of query({
    prompt,
    options: {
      model,
      cwd: options.cwd,
      resume: options.resume,
      tools: effectiveTools,
      allowedTools: effectiveAllowedTools,
      permissionMode: effectivePermissionMode,
      allowDangerouslySkipPermissions: effectiveSkipPerms,
      canUseTool: options.canUseTool,
      hooks: options.hooks,
      abortController: options.abortController,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
      console.log(`[callClaude] init sessionId=${sessionId}`);
    }
    if (message.type === "assistant" && "content" in message) {
      const textBlocks = (message.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!);
      if (textBlocks.length > 0 && options.onProgress) {
        options.onProgress(textBlocks.join(""));
      }
    }
    if (message.type === "result") {
      sessionId = message.session_id;
      isError = message.is_error;
      console.log(`[callClaude] result subtype=${message.subtype} isError=${isError}`);
      if (message.subtype === "success") {
        result = message.result;
        costUsd = message.total_cost_usd;
      } else {
        result = `执行出错: ${message.subtype}`;
        if ("errors" in message && message.errors?.length) {
          result += `\n${message.errors.join("\n")}`;
        }
      }
    }
  }

  console.log(`[callClaude] 流结束 sessionId=${sessionId} resultLen=${result.length}`);
  return { sessionId, result, costUsd, isError };
}

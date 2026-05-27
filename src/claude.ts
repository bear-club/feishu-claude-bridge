import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeResult {
  sessionId: string;
  result: string;
  costUsd: number;
  isError: boolean;
}

export type ProgressCallback = (text: string) => void;

export async function callClaude(
  prompt: string,
  options: {
    cwd?: string;
    resume?: string;
    abortController?: AbortController;
    onProgress?: ProgressCallback;
  }
): Promise<ClaudeResult> {
  const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";

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
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      abortController: options.abortController,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
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

  return { sessionId, result, costUsd, isError };
}

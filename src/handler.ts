import { sendText, sendCard, updateCard } from "./feishu.js";
import {
  getSession,
  setSession,
  createSession,
  listSessionsForChat,
  switchSession,
  getRecentDirs,
  type SessionData,
  type SessionEntry,
} from "./session-store.js";
import { callClaude } from "./claude.js";
import { validateCwd, getDefaultCwd, getShortcutDirs } from "./path-guard.js";
import { parseInput } from "./command-parser.js";
import { enqueue, cancelQueue } from "./task-queue.js";
import { splitByBytes } from "./split-message.js";
import { hasPendingApproval, resolveApproval, createCanUseTool, createPreToolUseHook, type ToolLogCallback } from "./permission.js";
import fs from "fs/promises";

const TASK_TIMEOUT = 5 * 60 * 1000;
const THROTTLE_MS = 3000;

export const activeControllers = new Map<string, AbortController>();

export async function handleMessage(chatId: string, text: string): Promise<void> {
  const cid = chatId.slice(-8);
  console.log(`[handleMessage] 入口 cid=${cid} text="${text.slice(0, 50)}" pending=${hasPendingApproval(chatId)} active=${activeControllers.has(chatId)}`);

  // 审批拦截：优先处理 pending approval 的回复
  if (hasPendingApproval(chatId)) {
    const lower = text.toLowerCase().trim();

    // /cancel 需要同时拒绝审批并取消任务
    if (lower === "/cancel") {
      resolveApproval(chatId, false);
      return handleCancel(chatId);
    }

    if (["y", "yes", "ok", "allow"].includes(lower)) {
      resolveApproval(chatId, true);
      return;
    }
    if (["n", "no", "deny", "reject"].includes(lower)) {
      resolveApproval(chatId, false);
      return;
    }

    await sendText(chatId, "当前有待审批的操作，请回复 y 批准或 n 拒绝");
    return;
  }

  const input = parseInput(text);

  if (input.type === "command") {
    console.log(`[handleMessage] 指令 cid=${cid} cmd=${input.name}`);
    switch (input.name) {
      case "new":
        return handleNew(chatId, input.args);
      case "switch":
        return handleSwitch(chatId, input.args);
      case "status":
        return handleStatus(chatId);
      case "cancel":
        return handleCancel(chatId);
      default:
        await sendCard(chatId, card("orange", "未知指令", [
          md(`未知指令: /${input.name}\n\n可用指令: /new /switch /status /cancel`),
        ]));
        return;
    }
  }

  console.log(`[handleMessage] 进入 handleClaude cid=${cid}`);
  await handleClaude(chatId, input.text);
  console.log(`[handleMessage] handleClaude 结束 cid=${cid}`);
}

// --- Card helpers ---

function card(color: string, title: string, elements: object[]) {
  return {
    header: {
      template: color,
      title: { tag: "plain_text", content: title },
    },
    elements,
  };
}

function md(content: string) {
  return { tag: "markdown", content };
}

function hr() {
  return { tag: "hr" };
}

// --- Claude call ---

async function handleClaude(chatId: string, prompt: string): Promise<void> {
  const cid = chatId.slice(-8);
  console.log(`[handleClaude] 入队前 cid=${cid} prompt="${prompt.slice(0, 40)}"`);
  const queued = enqueue(chatId, () => executeClaude(chatId, prompt));
  if (queued === null) {
    console.log(`[handleClaude] 队列已满 cid=${cid}`);
    await sendCard(chatId, card("orange", "⚠️ 队列已满", [
      md("当前有多个任务排队中，请稍后再试\n\n发送 /cancel 可取消所有任务"),
    ]));
    return;
  }

  console.log(`[handleClaude] 已入队 cid=${cid} hasActive=${activeControllers.has(chatId)}`);
  if (activeControllers.has(chatId)) {
    await sendText(chatId, "⏳ 上一个任务还在执行，已排队等待...");
  }

  console.log(`[handleClaude] 等待 queued promise cid=${cid}`);
  await queued;
  console.log(`[handleClaude] queued promise 完成 cid=${cid}`);
}

async function executeClaude(chatId: string, prompt: string): Promise<void> {
  console.log(`[executeClaude] 开始 chatId=${chatId.slice(-8)} prompt="${prompt.slice(0, 40)}"`);
  const session = await getSession(chatId);
  const cwd = session?.cwd || getDefaultCwd();

  const controller = new AbortController();
  activeControllers.set(chatId, controller);

  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT);

  const progressMsgId = await sendCard(chatId, card("blue", "⏳ 执行中", [
    md("正在处理..."),
  ]));
  console.log(`[executeClaude] 进度卡片已发送 msgId=${progressMsgId}`);

  const toolLog: string[] = [];
  let lastUpdate = 0;

  const onToolLog: ToolLogCallback = (toolName, summary) => {
    toolLog.push(`▸ ${toolName}: ${summary.slice(0, 80)}`);
    const now = Date.now();
    if (now - lastUpdate < THROTTLE_MS || !progressMsgId) return;
    lastUpdate = now;
    updateCard(progressMsgId, card("blue", "⏳ 执行中", [
      md(toolLog.join("\n")),
    ])).catch(() => {});
  };

  const canUseTool = createCanUseTool(chatId);
  const preToolUseHook = createPreToolUseHook(chatId, onToolLog);
  const hooks = { PreToolUse: [{ hooks: [preToolUseHook] }] };

  const onProgress = (text: string) => {
    const now = Date.now();
    if (now - lastUpdate < THROTTLE_MS || !progressMsgId) return;
    lastUpdate = now;
    const preview = text.length > 500 ? text.slice(-500) : text;
    const elements: object[] = [];
    if (toolLog.length > 0) {
      elements.push(md(toolLog.join("\n")), hr());
    }
    elements.push(md(`\`\`\`\n${preview}\n\`\`\``));
    updateCard(progressMsgId, card("blue", "⏳ 执行中", elements)).catch(() => {});
  };

  try {
    let result = await tryCallClaude(prompt, cwd, session?.sessionId, controller, onProgress, canUseTool, hooks);
    console.log(`[executeClaude] Claude 返回 sessionId=${result.sessionId} isError=${result.isError}`);

    await setSession(chatId, {
      sessionId: result.sessionId,
      cwd,
      createdAt: session?.createdAt || new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastPrompt: prompt.slice(0, 100),
    });

    const output = result.result || "（无输出）";
    const color = result.isError ? "red" : "green";
    const title = result.isError ? "⚠️ 执行结果" : "✅ 执行完成";

    const chunks = splitByBytes(output);
    const resultElements: object[] = [md(chunks[0])];
    if (toolLog.length > 0) {
      resultElements.push(hr(), md(toolLog.map((l) => l.replace("▸", "✓")).join("\n")));
    }

    if (progressMsgId) {
      await updateCard(progressMsgId, card(color, title, resultElements)).catch(() => {});
    }

    for (let i = 1; i < chunks.length; i++) {
      await sendCard(chatId, card(color, `${title} (${i + 1}/${chunks.length})`, [
        md(chunks[i]),
      ]));
    }
  } catch (err) {
    if (controller.signal.aborted) {
      console.log(`[executeClaude] 任务被取消 chatId=${chatId.slice(-8)}`);
      if (progressMsgId) {
        await updateCard(progressMsgId, card("orange", "⛔ 任务已取消", [
          md("当前任务已被中断"),
        ])).catch(() => {});
      } else {
        await sendCard(chatId, card("orange", "⛔ 任务已取消", [
          md("当前任务已被中断"),
        ]));
      }
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Claude 调用失败]", errMsg);
    if (progressMsgId) {
      await updateCard(progressMsgId, card("red", "❌ 执行失败", [
        md(`\`\`\`\n${errMsg}\n\`\`\``),
      ])).catch(() => {});
    } else {
      await sendCard(chatId, card("red", "❌ 执行失败", [
        md(`\`\`\`\n${errMsg}\n\`\`\``),
      ]));
    }
  } finally {
    clearTimeout(timer);
    if (activeControllers.get(chatId) === controller) {
      activeControllers.delete(chatId);
    }
  }
}

async function tryCallClaude(
  prompt: string,
  cwd: string,
  resumeId: string | undefined,
  controller: AbortController,
  onProgress?: (text: string) => void,
  canUseTool?: Parameters<typeof callClaude>[1]["canUseTool"],
  hooks?: Parameters<typeof callClaude>[1]["hooks"],
) {
  if (resumeId) {
    console.log(`[tryCallClaude] 尝试恢复会话 resumeId=${resumeId.slice(0, 20)}...`);
    try {
      const result = await callClaude(prompt, { cwd, resume: resumeId, abortController: controller, onProgress, canUseTool, hooks });
      console.log(`[tryCallClaude] 会话恢复成功`);
      return result;
    } catch (err) {
      console.warn(`[tryCallClaude] 会话恢复失败，新建会话: ${(err as Error).message}`);
    }
  }
  console.log(`[tryCallClaude] 新建会话 cwd=${cwd}`);
  return await callClaude(prompt, { cwd, abortController: controller, onProgress, canUseTool, hooks });
}

// --- /new ---

async function handleNew(chatId: string, args: string): Promise<void> {
  const dirList = await buildDirList();

  if (!args) {
    const elements: object[] = [];

    if (dirList.length === 0) {
      elements.push(md("发送 **/new 目录路径** 创建新会话"));
    } else {
      let idx = 1;
      const shortcuts = dirList.filter((d) => d.source === "shortcut");
      const recents = dirList.filter((d) => d.source === "recent");

      if (shortcuts.length > 0) {
        elements.push(md("**快捷目录**"));
        for (const item of shortcuts) {
          elements.push(md(`${idx}. ${item.dir}`));
          idx++;
        }
      }

      if (recents.length > 0) {
        if (elements.length > 0) elements.push(hr());
        elements.push(md("**最近使用**"));
        for (const item of recents) {
          elements.push(md(`${idx}. ${item.dir}`));
          idx++;
        }
      }

      elements.push(hr(), md("发送 **/new 编号** 或 **/new 完整路径**"));
    }

    await sendCard(chatId, card("blue", "📂 新建会话", elements));
    return;
  }

  let resolvedDir: string;

  const num = parseInt(args, 10);
  if (!isNaN(num) && num >= 1 && num <= dirList.length) {
    resolvedDir = dirList[num - 1].dir;
    try {
      validateCwd(resolvedDir);
    } catch {
      await sendCard(chatId, card("red", "❌ 路径不在白名单中", [
        md(`路径: ${resolvedDir}\n\n请检查 ALLOWED_DIRS 配置`),
      ]));
      return;
    }
  } else if (!isNaN(num)) {
    await sendCard(chatId, card("red", "❌ 无效编号", [
      md(`编号 ${num} 不存在，发送 /new 查看可用目录`),
    ]));
    return;
  } else {
    try {
      resolvedDir = validateCwd(args);
    } catch {
      await sendCard(chatId, card("red", "❌ 路径不在白名单中", [
        md(`路径: ${args}\n\n请检查 ALLOWED_DIRS 配置`),
      ]));
      return;
    }
  }

  try {
    const stat = await fs.stat(resolvedDir);
    if (!stat.isDirectory()) {
      await sendCard(chatId, card("red", "❌ 路径错误", [
        md(`路径不是目录: ${resolvedDir}`),
      ]));
      return;
    }
  } catch {
    await sendCard(chatId, card("red", "❌ 路径错误", [
      md(`目录不存在: ${resolvedDir}`),
    ]));
    return;
  }

  await createSession(chatId, {
    sessionId: "",
    cwd: resolvedDir,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    lastPrompt: "",
  });

  await sendCard(chatId, card("green", "✅ 已创建新会话", [
    md(`**工作目录**: ${resolvedDir}\n\n发送消息开始对话`),
  ]));
}

// --- /switch ---

async function handleSwitch(chatId: string, args: string): Promise<void> {
  const sessions = await listSessionsForChat(chatId);

  if (sessions.length === 0) {
    await sendCard(chatId, card("blue", "📋 会话列表", [
      md("暂无会话记录\n\n使用 **/new 目录路径** 创建"),
    ]));
    return;
  }

  const activeSession = await getSession(chatId);
  const elements: object[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const isCurrent = activeSession && s.sessionId === activeSession.sessionId && s.cwd === activeSession.cwd && s.createdAt === activeSession.createdAt;
    const active = isCurrent ? "  ← 当前" : "";
    const time = formatRelativeTime(s.lastActiveAt);
    const preview = s.lastPrompt || "(空)";
    elements.push(md(`${i + 1}. 📂 ${s.cwd}\n${time} — "${preview}"${active}\n/switch ${i + 1}`));
  }

  elements.push(hr(), md("复制指令发送即可切换"));

  if (!args) {
    await sendCard(chatId, card("blue", "📋 会话列表", elements));
    return;
  }

  const num = parseInt(args, 10);
  if (isNaN(num) || num < 1 || num > sessions.length) {
    await sendCard(chatId, card("red", "❌ 无效编号", [
      md(`编号 ${args} 不存在`),
      hr(),
      ...elements,
    ]));
    return;
  }

  const target = sessions[num - 1];
  await switchSession(chatId, target.id);

  await sendCard(chatId, card("green", "✅ 已切换会话", [
    md(`**工作目录**: ${target.cwd}\n**最后消息**: "${target.lastPrompt || "(空)"}"`),
  ]));
}

// --- /status ---

async function handleStatus(chatId: string): Promise<void> {
  const session = await getSession(chatId);
  if (!session) {
    await sendCard(chatId, card("blue", "📊 会话状态", [
      md("当前无活跃会话\n\n使用 **/new 目录路径** 创建"),
    ]));
    return;
  }

  const isRunning = activeControllers.has(chatId);
  const status = isRunning ? "🔄 执行中" : "💤 空闲";
  const time = formatRelativeTime(session.lastActiveAt);

  await sendCard(chatId, card("blue", "📊 会话状态", [
    md([
      `**状态**: ${status}`,
      `**工作目录**: ${session.cwd}`,
      `**最后活跃**: ${time}`,
      `**最后消息**: "${session.lastPrompt || "(空)"}"`,
    ].join("\n")),
  ]));
}

// --- /cancel ---

async function handleCancel(chatId: string): Promise<void> {
  const cid = chatId.slice(-8);
  const controller = activeControllers.get(chatId);
  console.log(`[handleCancel] cid=${cid} hasController=${!!controller} pending=${hasPendingApproval(chatId)}`);
  if (!controller) {
    await sendCard(chatId, card("blue", "⛔ 取消任务", [
      md("当前没有正在执行的任务"),
    ]));
    return;
  }
  cancelQueue(chatId);
  controller.abort();
  activeControllers.delete(chatId);
  console.log(`[handleCancel] 已取消 cid=${cid}`);
  await sendCard(chatId, card("orange", "⛔ 任务已取消", [
    md("当前任务及排队任务已全部取消"),
  ]));
}

// --- util ---

function formatRelativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

type DirEntry = { dir: string; source: "shortcut" | "recent" };

async function buildDirList(): Promise<DirEntry[]> {
  const list: DirEntry[] = [];
  for (const dir of getShortcutDirs()) {
    list.push({ dir, source: "shortcut" });
  }
  const recents = await getRecentDirs();
  const shortcutSet = new Set(list.map((d) => d.dir));
  for (const dir of recents.slice(0, 5)) {
    if (!shortcutSet.has(dir)) {
      list.push({ dir, source: "recent" });
    }
  }
  return list;
}

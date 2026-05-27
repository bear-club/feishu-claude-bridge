import { sendText, sendCard, updateCard } from "./feishu.js";
import {
  getSession,
  setSession,
  deleteSession,
  listSessionsByCwd,
  getRecentDirs,
  type SessionData,
} from "./session-store.js";
import { callClaude } from "./claude.js";
import { validateCwd, getDefaultCwd, getShortcutDirs } from "./path-guard.js";
import { parseInput } from "./command-parser.js";
import { enqueue, cancelQueue } from "./task-queue.js";
import { splitByBytes } from "./split-message.js";
import fs from "fs/promises";

const TASK_TIMEOUT = 5 * 60 * 1000;
const THROTTLE_MS = 3000;

export const activeControllers = new Map<string, AbortController>();

export async function handleMessage(chatId: string, text: string): Promise<void> {
  const input = parseInput(text);

  if (input.type === "command") {
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

  await handleClaude(chatId, input.text);
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
  const queued = enqueue(chatId, () => executeClaude(chatId, prompt));
  if (queued === null) {
    await sendCard(chatId, card("orange", "⚠️ 队列已满", [
      md("当前有多个任务排队中，请稍后再试\n\n发送 /cancel 可取消所有任务"),
    ]));
    return;
  }

  if (activeControllers.has(chatId)) {
    await sendText(chatId, "⏳ 上一个任务还在执行，已排队等待...");
  }

  await queued;
}

async function executeClaude(chatId: string, prompt: string): Promise<void> {
  const session = await getSession(chatId);
  const cwd = session?.cwd || getDefaultCwd();

  const controller = new AbortController();
  activeControllers.set(chatId, controller);

  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT);

  const progressMsgId = await sendCard(chatId, card("blue", "⏳ 执行中", [
    md("正在处理..."),
  ]));

  let lastUpdate = 0;
  let latestProgress = "";

  const onProgress = (text: string) => {
    latestProgress = text;
    const now = Date.now();
    if (now - lastUpdate < THROTTLE_MS || !progressMsgId) return;
    lastUpdate = now;
    const preview = text.length > 500 ? text.slice(-500) : text;
    updateCard(progressMsgId, card("blue", "⏳ 执行中", [
      md(`\`\`\`\n${preview}\n\`\`\``),
    ])).catch(() => {});
  };

  try {
    let result = await tryCallClaude(prompt, cwd, session?.sessionId, controller, onProgress);

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

    if (progressMsgId) {
      await updateCard(progressMsgId, card(color, title, [
        md(chunks[0]),
      ])).catch(() => {});
    }

    for (let i = 1; i < chunks.length; i++) {
      await sendCard(chatId, card(color, `${title} (${i + 1}/${chunks.length})`, [
        md(chunks[i]),
      ]));
    }
  } catch (err) {
    if (controller.signal.aborted) {
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
    activeControllers.delete(chatId);
  }
}

async function tryCallClaude(
  prompt: string,
  cwd: string,
  resumeId: string | undefined,
  controller: AbortController,
  onProgress?: (text: string) => void
) {
  if (resumeId) {
    try {
      return await callClaude(prompt, { cwd, resume: resumeId, abortController: controller, onProgress });
    } catch (err) {
      console.warn("[Session 恢复失败，新建会话]", (err as Error).message);
    }
  }
  return await callClaude(prompt, { cwd, abortController: controller, onProgress });
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

  await deleteSession(chatId);
  await setSession(chatId, {
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
  const grouped = await listSessionsByCwd();

  if (grouped.size === 0) {
    await sendCard(chatId, card("blue", "📋 会话列表", [
      md("暂无会话记录\n\n使用 **/new 目录路径** 创建"),
    ]));
    return;
  }

  const entries = [...grouped.entries()];
  const sessionList: { index: number; chatId: string; session: SessionData }[] = [];
  const elements: object[] = [];
  let idx = 1;

  for (const [cwd, sessions] of entries) {
    if (elements.length > 0) elements.push(hr());
    elements.push(md(`**📂 ${cwd}**`));
    for (const { chatId: sChatId, session } of sessions) {
      const active = sChatId === chatId ? "  ← 当前" : "";
      const time = formatRelativeTime(session.lastActiveAt);
      const preview = session.lastPrompt || "(空)";
      elements.push(md(`${idx}. ${time} — "${preview}"${active}\n/switch ${idx}`));
      sessionList.push({ index: idx, chatId: sChatId, session });
      idx++;
    }
  }

  elements.push(hr(), md("复制指令发送即可切换"));

  if (!args) {
    await sendCard(chatId, card("blue", "📋 会话列表", elements));
    return;
  }

  const num = parseInt(args, 10);
  const target = sessionList.find((s) => s.index === num);
  if (!target) {
    await sendCard(chatId, card("red", "❌ 无效编号", [
      md(`编号 ${args} 不存在`),
      hr(),
      ...elements,
    ]));
    return;
  }

  await setSession(chatId, {
    ...target.session,
    lastActiveAt: new Date().toISOString(),
  });

  await sendCard(chatId, card("green", "✅ 已切换会话", [
    md(`**工作目录**: ${target.session.cwd}\n**最后消息**: "${target.session.lastPrompt || "(空)"}"`),
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
  const controller = activeControllers.get(chatId);
  if (!controller) {
    await sendCard(chatId, card("blue", "⛔ 取消任务", [
      md("当前没有正在执行的任务"),
    ]));
    return;
  }
  cancelQueue(chatId);
  controller.abort();
  activeControllers.delete(chatId);
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

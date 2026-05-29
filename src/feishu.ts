import * as lark from "@larksuiteoapi/node-sdk";

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

// #4 消息去重：防止 WebSocket 网络波动推送重复事件
const processedMessages = new Set<string>();
const MAX_DEDUP_SIZE = 1000;

function isDuplicate(messageId: string): boolean {
  if (processedMessages.has(messageId)) return true;
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_DEDUP_SIZE) {
    const first = processedMessages.values().next().value!;
    processedMessages.delete(first);
  }
  return false;
}

// 消息年龄检测：超过此时间的消息视为飞书重放，直接丢弃
const MESSAGE_MAX_AGE_MS = 60_000; // 60 秒

// 命令内容去重：防止飞书用新 message_id 重放旧命令（兜底）
const recentCommands = new Map<string, number>();
const COMMAND_DEDUP_WINDOW_MS = 5 * 60_000; // 5 分钟

function isStaleMessage(createTimeMs: number): boolean {
  return Date.now() - createTimeMs > MESSAGE_MAX_AGE_MS;
}

function isCommandDuplicate(chatId: string, text: string): boolean {
  if (!text.startsWith("/")) return false; // 只对命令去重
  const key = `${chatId}:${text}`;
  const now = Date.now();
  const lastSeen = recentCommands.get(key);
  if (lastSeen && now - lastSeen < COMMAND_DEDUP_WINDOW_MS) return true;
  recentCommands.set(key, now);
  // 清理过期条目
  if (recentCommands.size > 500) {
    for (const [k, ts] of recentCommands) {
      if (now - ts > COMMAND_DEDUP_WINDOW_MS) recentCommands.delete(k);
    }
  }
  return false;
}

export async function sendText(chatId: string, text: string): Promise<string | undefined> {
  const resp = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
  return resp.data?.message_id;
}

export async function sendCard(chatId: string, card: object): Promise<string | undefined> {
  const resp = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
  return resp.data?.message_id;
}

export type MessageHandler = (chatId: string, text: string) => Promise<void>;

let onMessage: MessageHandler = async (chatId, text) => {
  await sendText(chatId, `收到: ${text}`);
};

export function setMessageHandler(handler: MessageHandler) {
  onMessage = handler;
}

const dispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data.message;
    if (!message) return;

    const messageId = message.message_id!;
    const chatId = message.chat_id!;
    const createTime = message.create_time!;
    const createTimeMs = Number(createTime) * 1000;
    const ageSeconds = Math.round((Date.now() - createTimeMs) / 1000);

    // 打印原始时间戳用于调试
    console.log(`[消息时间] mid=${messageId.slice(-8)} create_time=${createTime} age=${ageSeconds}s`);

    if (isDuplicate(messageId)) {
      console.log(`[去重] 跳过重复消息 ${messageId}`);
      return;
    }

    // 消息年龄检测：丢弃飞书重放的过期消息
    if (isStaleMessage(createTimeMs)) {
      console.log(`[过期消息] 跳过 age=${ageSeconds}s chat=${chatId}`);
      return;
    }

    // 命令内容去重：兜底防止重放命令
    if (message.message_type === "text") {
      const content = JSON.parse(message.content!);
      const text = (content.text as string).trim();
      if (isCommandDuplicate(chatId, text)) {
        console.log(`[命令去重] 跳过重放命令 chat=${chatId} text="${text}"`);
        return;
      }
    }

    // #12 非文本消息反馈
    if (message.message_type !== "text") {
      console.log(`[非文本] chat=${chatId} type=${message.message_type}`);
      try {
        await sendText(chatId, "暂时只支持文本消息");
      } catch (err) {
        console.error("[发送失败]", err);
      }
      return;
    }

    const content = JSON.parse(message.content!);
    const text = (content.text as string).trim();

    console.log(`[收到消息] chat=${chatId} text="${text}"`);

    try {
      await onMessage(chatId, text);
    } catch (err) {
      console.error("[处理失败]", err);
      try {
        await sendText(chatId, "处理消息时出错，请稍后重试");
      } catch (_) {}
    }
  },
});

const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

export async function updateCard(messageId: string, card: object): Promise<void> {
  await client.im.message.patch({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify(card),
    },
  });
}

export { client, dispatcher, wsClient };

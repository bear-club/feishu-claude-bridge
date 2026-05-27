# 实现计划

> 进度标记：✅ 已完成 | 🔲 待实现

## 前置准备

### 飞书开放平台配置

1. 进入 [飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用
2. 开启「机器人」能力
3. 记录 `App ID` 和 `App Secret`
4. 事件订阅：
   - 添加 `im.message.receive_v1`（接收消息）
   - 选择 **WebSocket 模式**（非 HTTP 回调）
5. 权限申请：
   - `im:message`（发送消息）
   - `im:message:send_as_bot`（以机器人身份发消息）
   - `im:resource`（上传文件/图片）
6. 可见范围：仅对自己可见（开发阶段）
7. 发布应用版本

**验证**：飞书客户端搜索机器人名称，能找到并打开对话窗口。

### 本地环境

```bash
node -v   # >= 18
npm -v
claude --version  # 确认 Claude Code CLI 已安装
```

## 第一阶段：消息收发通路 ✅

目标：飞书发消息 → 本机收到 → 原样回复。打通最小通路。

### 1.1 初始化项目 ✅

```bash
npm init -y
npm install typescript tsx @types/node -D
```

`tsconfig.json` 关键配置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

### 1.2 安装依赖 ✅

第一阶段只安装飞书 SDK，Claude Agent SDK 在第二阶段引入：

```bash
npm install @larksuiteoapi/node-sdk dotenv
```

### 1.3 环境变量 ✅

`.env.example`（复制为 `.env` 并填入实际值）：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

### 1.4 飞书 WebSocket 消息收发 ✅

`src/feishu.ts` — 飞书客户端封装：

```typescript
import * as lark from "@larksuiteoapi/node-sdk";

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

export async function sendText(chatId: string, text: string) {
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

const dispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data.message;
    if (!message || message.message_type !== "text") return;
    const chatId = message.chat_id!;
    const content = JSON.parse(message.content!);
    const text = (content.text as string).trim();
    await sendText(chatId, `收到: ${text}`);
  },
});

// 注意：eventDispatcher 在 start() 中传入，不在构造函数中
const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

export { client, dispatcher, wsClient };
```

`src/index.ts` — 入口：

```typescript
import "dotenv/config";
import { wsClient, dispatcher } from "./feishu.js";

// WSClient.start() 接受 { eventDispatcher } 参数
wsClient.start({ eventDispatcher: dispatcher });
```

> **实现备注**：飞书 SDK `WSClient` 的 `eventDispatcher` 和 `cardActionHandler` 不在构造函数中传入，而是通过 `start({ eventDispatcher })` 传入。这与部分文档示例不同，以实际 SDK 类型定义���准。

### 1.5 运行与验证 ✅

```bash
npm start        # 或 npx tsx src/index.ts
npm run dev      # 热重载模式
```

**验证**：飞书给机器人发 "hello" → 收到 "收到: hello"。**需配置好 .env 后测试。**

**调试**：
- WebSocket 连接失败 → 检查 App ID/Secret、应用是否已发布、事件订阅是否选了 WebSocket 模式
- 消息发送 403 → 检查权限是否申请并通过审批
- 收不到事件 → 检查 `im.message.receive_v1` 是否已订阅

## 第二阶段：接入 Claude Agent SDK ✅

目标：飞书消息 → Claude 执行 → 结果返回飞书。单会话，无上下文。

> 同步完成 REVIEW 审查项：#1 路径白名单、#3 错误兜底、#11 CLI 前置检查

### 2.1 Claude 调用封装 ✅

`src/claude.ts`：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeResult {
  sessionId: string;
  result: string;
  costUsd: number;
  isError: boolean;
}

export async function callClaude(
  prompt: string,
  options: { cwd?: string; resume?: string; abortController?: AbortController }
): Promise<ClaudeResult> {
  // SDK 使用 abortController（非 signal）
  // result 消息通过 message.type === "result" 判断，有 subtype 区分成功/失败
  for await (const message of query({ prompt, options: { ... } })) {
    if (message.type === "system" && message.subtype === "init")
      sessionId = message.session_id;
    if (message.type === "result") { /* 提取 result, cost, errors */ }
  }
}
```

> **实现备注**：SDK 的取消机制使用 `abortController` 选项（传入 AbortController 实例），而非 `signal`。result 消息有 `subtype: "success"` 和 `subtype: "error_*"` 两类。

### 2.2 路径白名单 ✅（REVIEW #1）

`src/path-guard.ts`：从 `.env` 读取 `ALLOWED_DIRS`（逗号分隔）和 `DEFAULT_CWD`，所有路径通过 `path.resolve()` 规范化后比较。

`.env` 需新增：

```env
DEFAULT_CWD=D:\play\feishu-claude-bridge
ALLOWED_DIRS=D:\play,D:\projects
```

### 2.3 CLI 前置检查 ✅（REVIEW #11）

`src/preflight.ts`：启动时执行 `claude --version`，失败则打印错误并 `process.exit(1)`。

### 2.4 消息处理串联 ✅（含 REVIEW #3 错误兜底）

`src/index.ts`：通过 `setMessageHandler` 注册处理器，流程：

1. 立即回复"⏳ 正在执行..."
2. try 块中调用 `callClaude(text, { cwd: defaultCwd })`
3. 发送结果消息
4. catch 块中发送 `❌ 执行失败: ${errMsg}`（保证用户不会卡在等待状态）

> **实现备注**：项目已从 CommonJS 切换为 ESM（`"type": "module"`），因为 `@anthropic-ai/claude-agent-sdk` 是纯 ESM 包。

### 2.5 验证

**验证**：`.env` 中填入 `DEFAULT_CWD` 和 `ALLOWED_DIRS` 后，飞书发 "列出当前目录的文件" → 收到 Claude 返回的文件列表。

**调试**：
- 启动即退出 → 检查 `claude --version` 是否可用（CLI 未安装/未登录）
- `DEFAULT_CWD 未配置` → `.env` 中添加 `DEFAULT_CWD`
- SDK 报 `require` 错误 → 确认 `package.json` 中 `"type": "module"`
- 超时无响应 → 打印消息流 `console.log(JSON.stringify(message))` 排查
- 结果为空 → 确认 result 消息类型判断是否正确（`message.type === "result"`）

## 第三阶段：会话管理与持续对话 ✅

目标：实现 session 持久化，同一飞书会话内持续对话。

> 同步完成 REVIEW 审查项：#2 Session 降级、#10 JSON 并发安全、#14 路径规范化
>
> **设计变更**：飞书 WSClient 长连接不支持卡片按钮回调（仅 HTTP Webhook 支持），`/new` 和 `/switch` 改为纯文本指令交互，无需额外 HTTP 服务或公网 IP。

### 3.1 会话存储 ✅

`src/session-store.ts`：JSON 文件持久化 `data/sessions.json`，包含异步写锁（REVIEW #10），路径 `path.resolve()` 规范化（REVIEW #14）。

提供 `getSession` / `setSession` / `deleteSession` / `listSessionsByCwd` / `getRecentDirs` 方法。

### 3.2 指令解析 ✅

`src/command-parser.ts`：解析 `/command args` 格式，返回 `{ type, name, args }` 或 `{ type, text }`。

### 3.3 消息处理中心 ✅

`src/handler.ts`：统一消息入口，分发指令和普通消息。

**核心流程**：
- 普通消息 → 查 session → 有则 `resume`，无则新建 → 保存 sessionId
- `/new <路径>` → 白名单校验 → 目录存在检查 → 创建新 session → 提示历史目录
- `/switch` → 按目录分组列出所有会话（含编号）
- `/switch <编号>` → 切换到指定会话
- `/status` → 显示当前会话状态、工作目录、最后活跃时间
- `/cancel` → abort 当前执行中的任务

**REVIEW #2 Session 降级**：`resume` 调用 try-catch，失败自动新建 session，日志记录。

### 3.4 验证

1. 发消息 "分析 README" → 收到结果
2. 发消息 "总结刚才的分析" → Claude 能引用上文（session 恢复成功）
3. 发 `/new` → 列出历史目录和用法提示
4. 发 `/new D:\play\feishu-claude-bridge` → 新会话创建
5. 发 `/switch` → 列出所有会话（按目录分组，含编号）
6. 发 `/switch 1` → 切换到指定会话
7. 发 `/status` → 显示当前会话信息

**调试**：
- session 恢复失败 → 日志中会打印 `[Session 恢复失败，新建会话]`，自动降级
- 路径校验失败 → 检查 `.env` 中 `ALLOWED_DIRS` 配置
- `data/sessions.json` 损坏 → 删除文件，会自动重建空映射

## 第四阶段：并发控制与任务管理 🔲

### 4.1 串行任务队列

`src/task-queue.ts`：

```typescript
// 每个 sessionId 一个队列实例
// 核心：Promise 链式串行
class TaskQueue {
  private queue: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, () => fn());
    return this.queue;
  }
}
```

### 4.2 `/cancel` 指令

```typescript
// 每个活跃任务绑定一个 AbortController
const activeControllers = new Map<string, AbortController>();

// /cancel 时
const controller = activeControllers.get(chatId);
controller?.abort();
```

### 4.3 超时处理

```typescript
const TIMEOUT = 5 * 60 * 1000; // 5 分钟
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT);
// 执行完成后 clearTimeout(timer)
```

### 4.4 验证

1. 快速连续发两条消息 → 第一条执行完后才执行第二条
2. 发长任务后立刻 `/cancel` → 任务中断，收到取消提示
3. 发一个必然超时的任务 → 5 分钟后收到超时提示

## 第五阶段：输出优化 🔲

### 5.1 飞书卡片消息替代纯文本

使用 `interactive` 类型卡片消息展示结果：
- 代码块用 `column_set` + `markdown` 元素
- 长文本分段
- 支持通过 `PATCH` 更新已发送的卡片内容

### 5.2 智能截断

```typescript
function truncateOutput(text: string, maxLen: number = 28000): string {
  if (text.length <= maxLen) return text;
  const head = text.slice(0, maxLen * 0.6);
  const tail = text.slice(-maxLen * 0.3);
  return `${head}\n\n... 省略 ${text.length - head.length - tail.length} 字符 ...\n\n${tail}`;
}
```

### 5.3 消息更新（实时进度）

```typescript
// 用 message_id 更新已发送的卡片
await client.im.message.patch({
  path: { message_id: messageId },
  data: {
    msg_type: "interactive",
    content: JSON.stringify(updatedCard),
  },
});
```

### 5.4 验证

1. 发一个会产生长输出的指令 → 输出被正确截断
2. 执行过程中卡片消息有进度更新

## 目录结构

```
feishu-claude-bridge/
├── src/
│   ├── index.ts            # 入口：前置检查、注册 handler、启动 WebSocket
│   ├── feishu.ts           # 飞书客户端、事件分发、消息去重、sendText
│   ├── claude.ts           # Claude Agent SDK 调用封装
│   ├── handler.ts          # 消息处理中心：指令分发、Claude 调用、session 管理
│   ├── session-store.ts    # 会话映射持久化（JSON + 异步写锁）
│   ├── command-parser.ts   # 指令解析 (/new, /switch, /cancel, /status)
│   ├── path-guard.ts       # 工作目录白名单校验
│   └── preflight.ts        # Claude CLI 可用性检查
├── data/
│   └── sessions.json       # 会话存储（运行时生成）
├── .env
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## 本地调试技巧

| 场景 | 方法 |
|------|------|
| 飞书卡片预览 | [卡片搭建工具](https://open.feishu.cn/tool/cardbuilder) 粘贴 JSON 预览 |
| SDK 消息流调试 | `for await (const msg of query(...)) console.log(msg)` 打印全部消息 |
| 飞书事件原始数据 | `dispatcher.register` 中 `console.log(JSON.stringify(data, null, 2))` |
| 会话状态检查 | 直接读 `data/sessions.json` |
| Claude 执行超时 | 先用 `claude -p "简单指令"` 确认 CLI 可用 |
| 热重载开发 | `npx tsx watch src/index.ts` |

## 里程碑检查点

| 阶段 | 完成标志 | 状态 |
|------|----------|------|
| 第一阶段 | 飞书发消息，机器人原样回复 | ✅ 已验证 |
| 第二阶段 | 飞书发指令，Claude 执行并返回结果 | ✅ 代码完成，待 .env 配置后验证 |
| 第三阶段 | 连续对话有上下文；`/new` `/switch` 指令交互正常 | ✅ 代码完成，待验证 |
| 第四阶段 | 连续消息串行执行；`/cancel` 能中断任务 | 🔲 |
| 第五阶段 | 卡片消息展示结果；长输出正确���断 | 🔲 |

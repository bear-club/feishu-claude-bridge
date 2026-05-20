# Feishu Claude Bridge

通过飞书机器人远程操控本机 Claude Code 的桥接服务。

## 项目目标

- 通过飞书机器人向本机 Claude Code 发送指令
- 接收 Claude Code 的执行结果并返回到飞书
- 支持多对话管理（新建、切换、列出对话）

## 架构设计

```
飞书用户 → 飞书服务器 → 本机桥接服务 → Claude Agent SDK → 返回结果 → 飞书消息
                     (WebSocket 长连接)
```

### 核心组件

| 组件 | 说明 |
|------|------|
| 飞书机器人 | 飞书开放平台自建应用，接收/发送消息 |
| 桥接服务 | 本机运行的 Node.js 服务，处理消息转发和对话管理 |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk`，程序化调用 Claude Code |
| 对话管理 | 维护飞书会话与 Claude Agent SDK session ID 的映射 |
| 任务队列 | 每个 session 维护一个串行任务队列，防止并发调用冲突 |

### 数据流

1. 用户在飞书中发送消息给机器人
2. 飞书服务器通过 WebSocket 长连接推送事件到本机桥接服务
3. 桥接服务解析消息，根据飞书会话查找或创建对应的 Claude session
4. 将任务加入该 session 的串行队列
5. 立即回复用户"正在执行..."
6. 调用 Claude Agent SDK 执行指令（支持流式输出）
7. 执行完成后主动推送结果消息给用户

## 技术选型

| 技术 | 选择 | 理由 |
|------|------|------|
| 运行时 | Node.js | Claude Agent SDK 原生支持 TypeScript |
| Claude Code 调用 | `@anthropic-ai/claude-agent-sdk` | 支持流式输出、session 恢复、hooks、子代理等完整能力 |
| 飞书通信 | `@larksuiteoapi/node-sdk` WebSocket 长连接 | 无需公网 IP，无需 ngrok/frp 内网穿透，SDK 内置事件分发 |
| 对话存储 | 本地 JSON 文件 | 轻量持久化，存储会话映射关系 |

> **注意**：飞书 SDK 自带 WebSocket 事件分发机制，不需要额外的 HTTP 框架（Express/Fastify）来接收消息。仅在需要健康检查或管理面板时才引入 HTTP 服务。

## Claude Agent SDK 调用方式

### 关于持续对话（核心机制）

`claude -p` 是单次调用，不包含上下文，无法持续对话。要实现和在终端中使用 Claude Code 一样的连续对话体验，需要使用 **Claude Agent SDK 的 session 机制**：

1. **首次调用**：SDK 返回的消息流中包含 `session_id`，从 `init` 类型的 system 消息中提取
2. **后续调用**：通过 `resume: sessionId` 参数恢复会话，Claude 会拥有之前所有的上下文（读过的文件、做过的分析、对话历史）

这等价于你在终端中持续和 Claude Code 对话——Claude 记得之前所有的交互。

### SDK 代码示例

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// === 首次调用：创建新会话 ===
let sessionId: string | undefined;

for await (const message of query({
  prompt: "读取 src/index.ts 并分析代码结构",
  options: {
    cwd: "/your/project/path",
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
  }
})) {
  // 从 init 消息中提取 session ID
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }
  // 提取最终结果
  if ("result" in message) {
    console.log(message.result);
  }
}

// === 后续调用：恢复会话，拥有完整上下文 ===
for await (const message of query({
  prompt: "基于刚才的分析，重构那个函数",  // "那个函数" — Claude 知道你指的是什么
  options: {
    resume: sessionId,  // 关键：传入 session ID 恢复上下文
  }
})) {
  if ("result" in message) {
    console.log(message.result);
  }
}
```

### CLI 模式（备选，无连续对话能力）

```bash
# 单次调用，无上下文
claude -p "你的指令"

# 注意：-p 模式每次都是全新会话，无法实现连续对话
```

## 飞书机器人指令设计

| 指令 | 说明 |
|------|------|
| 直接发消息 | 在当前会话中向 Claude Code 发送指令（保持上下文） |
| `/new` | 弹出目录选择卡片，创建新会话 |
| `/switch` | 弹出项目/会话选择卡片，切换上下文 |
| `/cancel` | 取消当前正在执行的任务 |
| `/status` | 查看当前会话状态 |

> 原来的 `/list`、`/cwd` 已合并到 `/switch` 的卡片交互中，减少用户手动输入。

### 交互式卡片设计

飞书卡片不支持二级嵌套选择，但支持**回调后更新卡片内容**，用两步卡片交互实现等效体验。

#### `/new` — 新建会话

```
用户：/new

┌──────────────────────────────────┐
│  📂 选择工作目录                  │
│                                  │
│  最近使用：                       │
│  [D:\projects\backend]           │ ◀── 按钮，点击直接创建
│  [D:\projects\mobile]            │
│  [D:\play\feishu-bridge]         │
│                                  │
│  手动输入路径：                    │
│  ┌──────────────────────┐        │
│  │                      │        │
│  └──────────────────────┘        │
│            [确认]                 │
└──────────────────────────────────┘
```

- 历史目录从会话存储中提取去重，按最近使用时间排序
- 按钮组件（`button`）展示历史路径，点击即创建
- 输入框组件（`input`）+ 按钮用于手动输入新路径
- 首次使用无历史记录时，只展示输入框

#### `/switch` — 切换项目/会话（两步卡片）

**第一步：选择项目目录**

```
用户：/switch

┌──────────────────────────────────┐
│  📂 选择项目                      │
│                                  │
│  [D:\projects\backend]  2个会话   │ ◀── 按钮，点击进入第二步
│  [D:\projects\mobile]   1个会话   │
│  [D:\play\feishu-bridge] 1个会话  │
└──────────────────────────────────┘
```

**第二步：卡片原地刷新，展示该项目下的会话列表**

```
用户点击了 D:\projects\backend → 卡片原地更新

┌──────────────────────────────────────┐
│  D:\projects\backend 的会话           │
│                                      │
│  [💬 10分钟前 — "加上分页功能..."]     │ ◀── 点击直接切换
│  [💬 2天前 — "修复登录bug..."]        │
│                                      │
│  [＋ 创建新会话]       [◀ 返回]       │
└──────────────────────────────────────┘
```

**技术实现**：

1. 用户点击按钮 → 飞书通过 `card.action.trigger` 回调推送事件
2. 服务端收到回调 → 返回新的卡片 JSON
3. 飞书原地替换卡片内容 → 用户看到第二步界面
4. 用户在第二步点击会话 → 回调切换 session，卡片更新为确认信息

> 飞书卡片按钮回调返回新卡片即可实现"原地刷新"效果，无需前端开发，对用户来说体验流畅。使用的组件均为飞书卡片基础组件：`button`（按钮）、`select_static`（下拉选择）、`input`（输入框），兼容性好。

## 关键设计

### 并发控制

Claude Agent SDK 同一个 session 不支持并发调用。如果用户连续发了两条消息，必须串行处理：

```
用户消息1 → 加入队列 → 立即执行
用户消息2 → 加入队列 → 等待消息1执行完毕后执行
```

实现方案：每个 session 维护一个 FIFO 任务队列，保证同一 session 内的请求串行执行。

### 任务取消

用户发送 `/cancel` 时，通过 `AbortController` 中断正在执行的 Claude Agent SDK 调用：

```typescript
const controller = new AbortController();

// 执行任务时传入 signal
for await (const message of query({
  prompt: "...",
  options: { resume: sessionId },
  signal: controller.signal,
})) {
  // ...
}

// 用户发送 /cancel 时
controller.abort();
```

### 异步执行与进度反馈

Claude Code 执行复杂任务可能耗时较长（几秒到几分钟），飞书事件回调有超时限制。处理策略：

1. 收到消息后立即回复"正在执行..."（飞书卡片消息）
2. 异步调用 Claude Agent SDK
3. 利用流式输出实时更新飞书卡片消息（通过卡片更新 API 展示执行进度）
4. 执行完成后更新卡片为最终结果
5. 超时（可配置，默认 5 分钟）后通知用户并中断执行

### 输出处理

Claude Code 的输出可能很长，飞书消息有大小限制：

| 消息类型 | 大小限制 |
|----------|----------|
| 普通文本消息 | ~4000 字符 |
| 卡片消息 (interactive card) | ~30KB |

处理策略：
- **优先使用飞书卡片消息**，承载更多内容且支持实时更新
- **智能截断**：超长输出保留开头 + 结尾 + 错误信息，中间折叠
- **分段发送**：单次输出超过卡片上限时，拆分为多条消息
- **文件附件**：极长输出（如完整代码文件）上传为飞书文件附件

### 消息类型解析

SDK 返回的消息流包含多种类型，需要提取用户可读的内容：

```typescript
for await (const message of query({ prompt, options })) {
  switch (true) {
    case message.type === "system" && message.subtype === "init":
      // 提取 session_id 用于后续恢复
      sessionId = message.session_id;
      break;
    case "result" in message:
      // 最终结果文本，发送给飞书用户
      sendToFeishu(message.result);
      break;
    // 其他消息类型可用于进度展示
  }
}
```

### 安全性

- **用户限制**：通过飞书应用可见范围配置，限制可调用机器人的用户
- **工作目录白名单**：`/new` 和 `/switch` 创建会话时校验路径是否在允许列表内，防止访问敏感目录
- **路径验证**：创建会话前验证目录是否存在
- **敏感操作确认**：对文件删除、git push 等操作，通过飞书卡片按钮让用户二次确认
- **权限模式**：SDK 支持 `permissionMode` 配置，可限制 Claude 能使用的工具

### 会话存储

使用本地 JSON 文件存储飞书会话与 Claude session 的映射关系：

```json
{
  "feishu_chat_id_1": {
    "sessionId": "claude-session-xxx",
    "cwd": "/path/to/project",
    "createdAt": "2026-05-20T10:00:00Z",
    "lastActiveAt": "2026-05-20T12:30:00Z"
  }
}
```

## 实现路线

### 第一阶段：基础功能

1. 搭建 Node.js + TypeScript 项目，集成 Claude Agent SDK
2. 实现飞书机器人消息收发（WebSocket 长连接）
3. 实现单会话的指令发送和结果返回
4. 异步执行 + "正在执行..."即时反馈

### 第二阶段：对话管理

5. 实现会话映射存储（飞书会话 ↔ Claude session ID）
6. 实现 session 恢复，支持同一飞书会话内的连续对话
7. 实现 `/new` 卡片交互（历史目录按钮 + 手动输入）
8. 实现 `/switch` 两步卡片交互（选目录 → 选会话，卡片原地刷新）

### 第三阶段：健壮性

9. 并发控制：每个 session 的串行任务队列
10. 任务取消：`/cancel` + AbortController
11. 超时处理：可配置的执行超时 + 用户通知
12. 长输出处理：智能截断 / 分段发送 / 文件附件

### 第四阶段：体验优化

13. 流式输出实时更新飞书卡片消息
14. 卡片消息美化（代码块、折叠区域、操作按钮）
15. 错误处理与友好提示

### 第五阶段：安全与运维

16. 工作目录白名单
17. 敏感操作确认机制
18. 用户权限控制
19. 日志记录与监控

## 飞书开放平台配置清单

- [ ] 创建企业自建应用
- [ ] 启用机器人能力
- [ ] 获取 App ID 和 App Secret
- [ ] 配置事件订阅（`im.message.receive_v1`）
- [ ] 选择 WebSocket 长连接模式
- [ ] 配置应用可见范围（限制可操控用户）
- [ ] 申请必要的 API 权限（发送消息、更新消息等）

## 依赖

```json
{
  "@anthropic-ai/claude-agent-sdk": "latest",
  "@larksuiteoapi/node-sdk": "latest"
}
```

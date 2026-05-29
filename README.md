# Feishu Claude Bridge

通过飞书机器人远程操控本机 Claude Code 的桥接服务。在飞书中发送消息，即可驱动本地 Claude Code 执行任务并返回结果，支持持续对话、多项目切换、并发控制和危险操作的飞书交互式审批。

## 功能特性

- **远程操控** — 飞书发消息即可调用本机 Claude Code，无需打开终端
- **持续对话** — 基于 Claude Agent SDK session 机制，同一会话内保持完整上下文
- **多会话管理** — 同一聊天可维护多个会话，通过 `/new` `/switch` 在不同工作目录间切换
- **分级权限审批** — 三档策略：全部放行 / 危险操作飞书审批 / 仅只读，审批通过才执行，拒绝即真正阻断
- **实时进度** — 执行过程中通过飞书卡片实时更新工具调用与输出
- **并发控制** — 每个会话串行任务队列（最多排队 3 个），防止 SDK 并发冲突
- **长输出处理** — 超过飞书限制时自动分片发送，内容完整不丢失
- **目录白名单** — 工作目录受 `ALLOWED_DIRS` 限制，防止访问敏感路径
- **无需公网 IP** — 飞书 WebSocket 长连接，本地即可运行

## 架构

```
飞书用户 ──→ 飞书服务器 ──WebSocket──→ 本机桥接服务 ──→ Claude Agent SDK ──→ 结果返回飞书
```

| 组件 | 技术 | 说明 |
|------|------|------|
| 消息通道 | `@larksuiteoapi/node-sdk` WebSocket | 无需公网 IP，SDK 内置事件分发 |
| AI 调用 | `@anthropic-ai/claude-agent-sdk` | 流式输出、session 恢复、任务取消、权限 hook |
| 会话存储 | 本地 JSON 文件 | 轻量持久化，映射飞书会话到 Claude session |

## 快速开始

### 前置条件

- Node.js >= 18
- Claude Code CLI 已安装并登录（`claude --version` 可用）
- 飞书开放平台自建应用（见下方配置说明）

### 安装

```bash
git clone https://github.com/bear-club/feishu-claude-bridge.git
cd feishu-claude-bridge
npm install
```

### 配置

复制环境变量模板并填入实际值：

```bash
cp .env.example .env
```

| 环境变量 | 必填 | 默认值 | 说明 |
|----------|:----:|--------|------|
| `FEISHU_APP_ID` | ✅ | — | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | — | 飞书应用 App Secret |
| `DEFAULT_CWD` | ✅ | — | Claude 执行的默认工作目录 |
| `ALLOWED_DIRS` | ✅ | — | 允许的工作目录白名单（逗号分隔） |
| `CLAUDE_MODEL` | | `claude-opus-4-6` | Claude 模型 |
| `CLAUDE_ALLOWED_TOOLS` | | `Read,Glob,Grep,Edit,Write,Bash` | Claude 可用工具（逗号分隔） |
| `CLAUDE_PERMISSION_POLICY` | | `bypass` | 权限策略：`bypass` / `cautious` / `strict` |
| `CLAUDE_SAFE_TOOLS` | | — | 额外自动放行工具（仅 cautious/strict 生效） |
| `CLAUDE_DANGEROUS_PATTERNS` | | 内置默认列表 | 危险命令模式（仅 cautious 生效） |
| `CLAUDE_APPROVAL_TIMEOUT_MS` | | `60000` | 审批超时毫秒数，超时自动拒绝 |
| `SHORTCUT_DIRS` | | — | `/new` 指令展示的快捷目录（逗号分隔） |

最小可运行配置示例：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
DEFAULT_CWD=D:\play\feishu-claude-bridge
ALLOWED_DIRS=D:\play,D:\projects
```

### 运行

```bash
npm start          # 启动服务
npm run dev        # 开发模式（热重载）
```

启动后在飞书中搜索机器人名称，发送消息即可开始使用。

## 指令说明

| 指令 | 必填字段 | 说明 |
|------|----------|------|
| 直接发消息 | — | 向当前会话的 Claude 发送指令，保持上下文 |
| `/new [编号\|路径]` | 路径需在 `ALLOWED_DIRS` 白名单内 | 创建新会话；无参数时列出快捷目录与最近使用目录供选编号 |
| `/switch [编号]` | 编号（无参数时仅列出会话） | 在同一聊天的多个会话间切换 |
| `/status` | — | 查看当前会话状态、工作目录、最后活跃时间 |
| `/cancel` | — | 取消正在执行的任务并清空排队队列 |

审批回复（仅当有待审批操作时生效）：

| 回复 | 含义 |
|------|------|
| `y` / `yes` / `ok` / `allow` | 批准执行该操作 |
| `n` / `no` / `deny` / `reject` | 拒绝该操作 |
| `/cancel` | 拒绝审批并取消整个任务 |

## 权限审批机制

通过 `CLAUDE_PERMISSION_POLICY` 选择策略，对每次工具调用做风险分级：

| 策略 | 只读工具（Read/Glob/Grep） | 普通操作（如普通 Bash） | 危险操作（rm / git push / DROP TABLE 等） |
|------|------|------|------|
| `bypass`（默认） | 放行 | 放行 | 放行 |
| `cautious` | 放行 | 通知后放行 | **发飞书卡片审批，等用户回复** |
| `strict` | 放行 | 拒绝 | 拒绝 |

- **危险操作识别**：`Bash` 命令匹配 `CLAUDE_DANGEROUS_PATTERNS`（留空时使用内置 30+ 默认模式，含 `rm`、`del`、`git push/reset --hard`、`DROP TABLE`、`shutdown` 等）即判为危险。
- **可靠阻断**：危险操作审批通过 `PreToolUse` hook 实现 —— 用户回复 `n` 或超时即真正阻止工具执行，不会出现"已拒绝但操作仍发生"。
- **审批超时**：`CLAUDE_APPROVAL_TIMEOUT_MS` 内（默认 60 秒）未回复自动拒绝。
- **自动放行**：`Read/Glob/Grep` 始终放行；通过 `CLAUDE_SAFE_TOOLS` 可追加额外免审批工具（如 `Edit,Write`）。

## 数据流转示例

以「在 cautious 模式下请求删除文件」为例：

```
1. 飞书用户发送        "删除 D:/play/tmp/old.txt"
       │
2. 桥接服务接收        feishu.ts WebSocket 收到 im.message.receive_v1，去重后交给 handler
       │
3. 入队执行            task-queue.ts 串行入队 → executeClaude 发送「⏳ 执行中」进度卡片
       │
4. 调用 Claude         claude.ts query() 流式执行，恢复上一轮 session 上下文
       │
5. 工具拦截            Claude 决定执行 `rm` → PreToolUse hook 判定为危险操作
       │
6. 飞书审批            发送「🔐 权限审批」红色卡片，提示回复 y/n（60s 内）
       │
   ┌───┴────────────────────────┐
   │ 用户回复 y                  │ 用户回复 n / 超时
   ▼                            ▼
7a. hook 放行 → 工具执行       7b. hook 拒绝 → 工具不执行
    文件被删除                     文件保留，卡片更新「❌ 已拒绝」
   │                            │
   └───┬────────────────────────┘
       │
8. 结果返回            executeClaude 收集结果 → 更新进度卡片为「✅ 执行完成」
       │              超长输出按 28KB 边界分片，多张卡片顺序发送
       │
9. 会话持久化          session-store.ts 写入新的 sessionId / lastActiveAt / lastPrompt
```

只读或普通操作（如「读取 README」）跳过第 6 步，进度卡片实时显示工具调用日志后直接返回结果。

## Claude Agent SDK 调用机制

本项目使用 `@anthropic-ai/claude-agent-sdk` 实现与 Claude Code 的程序化交互，核心能力：

- **Session 恢复**：首次调用获取 `session_id`，后续通过 `resume` 参数恢复上下文，实现连续对话
- **流式输出**：实时获取 Claude 执行进度，用于更新飞书卡片
- **权限 hook**：通过 `PreToolUse` hook 在工具执行前介入，实现可靠的危险操作审批与阻断
- **任务取消**：通过 `AbortController` 中断正在执行的调用
- **错误降级**：session 恢复失败时自动新建会话，保证服务可用

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// 首次调用 — 创建新会话，并挂载权限 hook
for await (const message of query({
  prompt: "分析代码结构",
  options: { cwd, hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] } },
})) {
  if (message.type === "system" && message.subtype === "init")
    sessionId = message.session_id;  // 保存用于后续恢复
  if (message.type === "result")
    return message.result;
}

// 后续调用 — 恢复上下文
for await (const message of query({ prompt: "重构那个函数", options: { resume: sessionId } })) {
  // Claude 记得之前所有交互
}
```

## 项目结构

```
src/
├── index.ts            # 入口：前置检查、注册 handler、启动 WebSocket
├── feishu.ts           # 飞书客户端封装：消息收发、卡片更新、消息去重
├── claude.ts           # Claude Agent SDK 调用封装：流式处理、session 管理、hook 透传
├── handler.ts          # 消息处理中心：指令分发、审批拦截、卡片构建、任务编排
├── permission.ts       # 权限分级与审批：风险分类、PreToolUse hook、飞书审批卡片
├── session-store.ts    # 会话存储：多会话 JSON 持久化 + 异步写锁 + 旧格式迁移
├── command-parser.ts   # 指令解析：/command 格式识别
├── path-guard.ts       # 路径白名单校验
├── preflight.ts        # Claude CLI 可用性前置检查
├── task-queue.ts       # 串行任务队列 + 取消支持
└── split-message.ts    # 消息分片：按字节拆分，保留换行边界
```

## 飞书开放平台配置

1. 进入 [飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用
2. 开启「机器人」能力
3. 记录 `App ID` 和 `App Secret`
4. 事件订阅：添加 `im.message.receive_v1`，选择 **WebSocket 模式**
5. 权限申请：`im:message`、`im:message:send_as_bot`、`im:resource`
6. 可见范围：按需配置（开发阶段建议仅对自己可见）
7. 发布应用版本

## 设计要点

### 多会话存储

每个飞书聊天（`chatId`）维护一组会话，记录 `activeId` 与 `sessions` 列表。`/new` 追加并激活新会话，`/switch` 切换激活会话，`getRecentDirs` 汇总最近工作目录用于 `/new` 编号选择。存储为单一 JSON 文件，写入经异步锁串行化，并兼容旧版单会话格式自动迁移。

### 并发控制

Claude Agent SDK 同一 session 不支持并发调用。本项目为每个会话维护 FIFO 任务队列（最多 3 个排队），保证串行执行。超出队列深度的请求会被拒绝并提示用户。

### 输出分片

飞书卡片消息限制约 30KB。超长输出按 28KB 字节边界拆分，优先在换行符处断开，分片标注序号顺序发送。

### 安全机制

- 工作目录白名单（`ALLOWED_DIRS`）：所有路径经 `path.resolve()` 规范化后校验
- 分级权限审批（`CLAUDE_PERMISSION_POLICY`）：危险操作经 `PreToolUse` hook 飞书审批，拒绝即真正阻断
- Claude CLI 前置检查：启动时验证 CLI 可用，不可用则退出
- 飞书应用可见范围：通过平台配置限制可调用用户

## 调试

| 场景 | 方法 |
|------|------|
| WebSocket 连接失败 | 检查 App ID/Secret、应用是否已发布、事件订阅模式 |
| 消息发送 403 | 检查权限是否申请并通过审批 |
| Claude 执行超时 | 终端运行 `claude -p "test"` 确认 CLI 可用 |
| 审批拒绝后操作仍发生 | 确认 `CLAUDE_PERMISSION_POLICY=cautious` 且危险命令命中模式 |
| Session 恢复失败 | 日志会打印降级信息，自动新建会话 |
| 会话数据损坏 | 删除 `data/sessions.json`，会自动重建 |

## License

ISC

# 类 Pi Agent 架构设计方案

> 基于 Pi (pi-mono) 源码深度分析，使用 Vercel AI SDK 替代 LLM 请求层，以 `@opentui/solid` + SolidJS 构建 TUI 层，其余自主实现。

---

## 目录

1. [Pi 架构分析](#1-pi-架构分析)
2. [技术栈映射](#2-技术栈映射)
3. [整体架构设计](#3-整体架构设计)
4. [各模块详细设计](#4-各模块详细设计)
5. [数据流与核心循环](#5-数据流与核心循环)
6. [目录结构建议](#6-目录结构建议)
7. [实现路线图](#7-实现路线图)

---

## 1. Pi 架构分析

### 1.1 包分层 (从底到顶)

```
┌─────────────────────────────────────────────────────────┐
│                    coding-agent (CLI)                     │  ← 应用层：交互/打印/RPC 三种模式
│  AgentSession · SessionManager · Extensions · Compaction  │
│  Tools(read/bash/edit/write) · SystemPrompt · Skills      │
├─────────────────────────────────────────────────────────┤
│              agent-core (Agent Runtime)                   │  ← 运行时：状态、队列、事件映射
│  Agent · AgentMessage · AgentTool · AgentEvent              │
│  Steering/FollowUp队列 · Hooks · Harness                  │
├──────────────────┬──────────────────────────────────────┤
│   tui (终端 UI)   │              ai (LLM SDK)              │  ← 基础设施层
│  TUI · Component  │  Provider · Model · Stream · Auth     │
│  KeyParser · Render│  OAuth · Models Store                │
├──────────────────┴──────────────────────────────────────┤
│              storage/sqlite-node · server                  │  ← 持久化 + RPC
│  Session持久化 · IPC · Supervisor                         │
└─────────────────────────────────────────────────────────┘
```

### 1.2 核心设计模式提取

#### 模式 A：AgentMessage 双层消息抽象

Pi 最关键的设计是 **AgentMessage ≠ LLM Message**：

```
AgentMessage = Message (user/assistant/toolResult) | CustomAgentMessages
```

- `AgentMessage[]` 是内部对话转录的统一格式，包含 LLM 不认识的自定义消息类型
- 在 LLM 调用边界，通过 `convertToLlm(messages)` 过滤/转换为 LLM 可理解的 `Message[]`
- 自定义消息（如 bash 执行记录、compaction 摘要）只存在于 UI 和 session 中，不发给 LLM
- 通过 TypeScript declaration merging 扩展 `CustomAgentMessages` 接口

```typescript
// Pi 的做法：声明合并扩展自定义消息
declare module "@my/agent-core" {
  interface CustomAgentMessages {
    artifact: ArtifactMessage;
    notification: NotificationMessage;
  }
}
```

#### 模式 B：Agent Loop 双层循环

```
外层循环 (while true):          ← 处理 follow-up 消息（agent 本应停止后追加）
  内层循环 (while hasToolCalls):  ← 处理 tool calls + steering 消息
    1. 注入 pending 消息 (steering)
    2. streamAssistantResponse()  ← 调 LLM，流式产出
    3. 检查 toolCalls → executeToolCalls()
    4. emit turn_end
    5. prepareNextTurn (可切换 model/context/thinking)
    6. shouldStopAfterTurn?
    7. 拉取 steering 消息
  拉取 follow-up 消息 → 如果有则继续外层循环
emit agent_end
```

关键设计点：

- **Steering**：在当前 assistant turn 执行完 tool calls 后、下一次 LLM 调用前注入，不跳过当前 tool calls
- **Follow-up**：在 agent 本应停止时注入，触发新一轮 turn
- **prepareNextTurn**：每轮结束后可动态切换 model、context、thinking level
- **截断处理**：`stopReason === "length"` 时所有 tool calls 标记为错误（参数可能被截断）

#### 模式 C：事件驱动的生命周期

```
AgentEvent =
  agent_start
  turn_start
  message_start     ← 每条消息（user/assistant/toolResult）
  message_update     ← 仅 assistant 流式更新
  message_end
  tool_execution_start
  tool_execution_update  ← 工具执行中的部分结果
  tool_execution_end
  turn_end           ← { message, toolResults }
  agent_end          ← { messages }
```

- 所有事件通过 `subscribe(listener)` 分发
- listener 是 async 的，按订阅顺序 await 执行
- session 持久化、extension hook、UI 更新都作为 listener 挂载

#### 模式 D：Tool 执行策略

```
sequential: 逐个执行，前一个完成后才准备下一个
parallel:   先顺序准备（验证参数 + beforeToolCall），
            再并发执行允许的工具，
            按 assistant 源顺序产出 toolResult 消息
```

每个 tool 可单独指定 `executionMode` 覆盖全局策略。

#### 模式 E：AgentSession = 共享会话核心

```
AgentSession 封装：
  ├── Agent (运行时状态机)
  ├── SessionManager (JSONL 持久化 + 分支/fork/resume)
  ├── SettingsManager (分层配置：global > project > CLI)
  ├── ExtensionRunner (插件系统)
  ├── ResourceLoader (extensions/skills/prompts/themes/context files)
  ├── ModelRuntime (model 发现 + auth + OAuth)
  ├── Compaction (上下文窗口管理)
  └── Tools 注册表 (built-in + extension + custom)

三种 Run Mode 共享同一个 AgentSession：
  ├── InteractiveMode → TUI 渲染 + 键盘交互
  ├── PrintMode → stdout 输出，无交互
  └── RpcMode → JSON-RPC over Unix socket
```

#### 模式 F：Compaction（上下文压缩）

```
触发条件: contextTokens > contextWindow × threshold
流程:
  1. 找到截断点 (turn 边界)
  2. 用 LLM 生成被截断部分的摘要
  3. 替换: [摘要消息] + [保留的近期消息]
  4. 持久化 CompactionEntry
  5. 重新加载 session
```

#### 模式 G：Extension 系统

```
Extension 可注册：
  ├── Tools (LLM 可调用)
  ├── Commands (/command)
  ├── Keyboard shortcuts
  ├── CLI flags
  └── Lifecycle hooks (agent_start/end, tool_call, tool_result, input, ...)

Extension 通过 ExtensionContext 访问：
  ├── session (AgentSession API)
  ├── ui (ExtensionUIContext: select/confirm/input/notify)
  ├── tools (getTools/setTools)
  └── commands
```

---

## 2. 技术栈映射

| Pi 原生包 | 功能 | 你的替代方案 | 需自己实现的部分 |
| ----------- | ------ | ------------- | ---------------- |
| `pi-ai` | 多 Provider LLM 请求 | Vercel AI SDK | Model 发现/注册、Auth 存储、OAuth 流程 |
| `pi-tui` | 终端 UI 渲染 | `@opentui/solid` + SolidJS | Markdown 渲染、Editor 组件、Autocomplete |
| `pi-agent-core` | Agent 运行时 | AI SDK `ToolLoopAgent` + 薄封装 | Steering、Follow-up、应用事件映射 |
| `pi-coding-agent` | 应用层 | **自己实现** | 全部 |
| `storage/sqlite-node` | 持久化 | **Bun 内置 `bun:sqlite` + `Bun.file()`** | 存储层逻辑 |
| `server` | RPC 服务 | **Bun.serve() / Bun IPC** | RPC 协议与 handler |

> **运行时选型**：项目使用 **Bun** 作为运行时和包管理器。服务端相关操作（文件 IO、SQLite、HTTP/RPC 服务、子进程管理）优先使用 Bun 内置 API 及 Bun 生态，而非 Node.js 生态。
>
> | 场景 | Node.js 做法 | Bun 做法 |
> | ------ | ------------ | ---------- |
> | 包管理 / monorepo | npm workspaces | `bun install` + workspaces（兼容 package.json workspaces 字段） |
> | 运行 TS 源码 | tsx / ts-node | `bun run` 原生执行 TypeScript |
> | 构建 / 打包 | esbuild | `bun build`（或仍用 esbuild 作为 devDep） |
> | SQLite | `node:sqlite`（实验性） | `bun:sqlite`（内置稳定） |
> | 文件读写 | `node:fs` | `Bun.file()` / `Bun.write()`（更简洁） |
> | HTTP/RPC 服务 | `node:http` / `net.Server` | `Bun.serve()`（内置高性能 HTTP/WS） |
> | Unix socket | `net.createServer` | `Bun.serve({ unix: path })` |
> | 子进程 | `child_process.spawn` | `Bun.spawn()` / `Bun.spawnSync()` |
> | 密码/哈希 | `node:crypto` | `Bun.crypto` / `Bun.hash` |
> | 环境变量 | `process.env` | `Bun.env`（同等） |
> | 测试 | vitest | `bun test`（内置，也可保留 vitest） |

### 2.1 Vercel AI SDK 提供的能力

本方案使用 `ai` 包的 `ToolLoopAgent` 管理内层 Tool Loop，并通过 `@ai-sdk/openai`、`@ai-sdk/anthropic` 等 Provider 包连接模型。

```typescript
import { ToolLoopAgent, isStepCount, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const agent = new ToolLoopAgent({
  model: openai("gpt-5.2"),
  instructions: "You are a coding agent.",
  tools: {
    read: tool({
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) => Bun.file(path).text(),
    }),
  },
  stopWhen: isStepCount(20),
  prepareStep: ({ messages }) => ({
    messages: [...messages, ...steeringQueue.splice(0)],
  }),
  onStepEnd: persistStep,
});

const result = await agent.stream({ messages });
for await (const part of result.fullStream) {
  // text/thinking/tool-call/tool-result/error 等细粒度事件
}
```

AI SDK 直接提供：

- 多 Provider 的统一 `LanguageModel` 接口
- `ToolLoopAgent` 内层 Tool Loop
- `prepareStep`：逐轮覆盖 model、messages、instructions、activeTools、providerOptions
- `stopWhen`：步数、指定 Tool Call 或自定义停止条件
- Tool schema 校验、并行执行、审批和 Tool Call 修复
- `fullStream`、`onStepStart`、`onStepEnd`、`onToolExecutionStart/End`
- `AbortSignal`、usage 和 finish reason

仍需自己实现：

- Steering 队列：在 `prepareStep` 中注入下一轮模型调用
- Follow-up 队列：一次 `ToolLoopAgent` 结束后，由 `AgentSession` 再发起一次调用
- `AgentMessage` 与 `ModelMessage` 的边界转换
- Session、Compaction、Extension、TUI

**关键决策**：不再把 SDK 包装成 Pi 风格 `StreamFn`，也不重复实现 Tool Loop。`agent-core` 只保留会话级状态、队列和事件映射。

---

### 2.2 `@opentui/solid` 提供的能力

```tsx
import { render, useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";

const App = () => {
  const [message, setMessage] = createSignal("Hello");

  useKeyboard((event) => {
    if (event.name === "return") setMessage("World");
  });

  return <text>{message()}</text>;
};

await render(App);
```

**关键差异**：

- Pi 的 TUI 是自研差分渲染引擎 + 自定义组件系统
- `@opentui/core` 继续提供原生 Zig 渲染核心
- `@opentui/solid` 提供 JSX reconciler，界面使用 SolidJS signals、组件和生命周期组织

---

## 3. 整体架构设计

### 3.1 包结构

```
tater/
├── packages/
│   ├── ai-adapter/          # Provider 解析、ModelRuntime、Auth/OAuth
│   ├── agent-core/          # ToolLoopAgent 薄封装、消息与队列
│   ├── agent-session/       # Session、Compaction、Extensions
│   ├── tools/               # read/bash/edit/write/grep/find/ls
│   ├── storage/             # JSONL + 可选 SQLite 索引
│   └── tui/                 # SolidJS + OpenTUI 交互/打印/RPC 模式
├── package.json
├── bunfig.toml
└── tsconfig.json
```

### 3.2 依赖关系

```
                    ┌──────────────┐
                    │     tui      │ ← @opentui/solid + SolidJS
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │agent-session │ ← 持久化、压缩、扩展
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │  agent-core  │ ← ToolLoopAgent + 队列
                    └──────┬───────┘
                     ┌─────┴─────┐
                     ▼           ▼
              ┌────────────┐ ┌────────┐
              │ ai-adapter │ │ tools  │
              └─────┬──────┘ └────────┘
                    ▼
       Vercel AI SDK + @ai-sdk/* providers
```

依赖方向保持单向：

- `ai-adapter` 提供 `LanguageModel`，不控制 Agent Loop
- `tools` 提供 AI SDK Tool 定义
- `agent-core` 创建并运行 `ToolLoopAgent`
- `agent-session` 处理跨调用能力
- `tui` 只消费 Session 事件

### 3.3 层级职责

| 层 | 职责 | 不负责 |
| --- | --- | --- |
| `ai-adapter` | Provider、模型解析、API key、OAuth | Tool Loop、事件状态机 |
| `agent-core` | `ToolLoopAgent` 配置、AgentMessage、Steering/Follow-up、事件映射 | Session 文件、TUI |
| `agent-session` | 持久化、Compaction、Retry、Extensions、System Prompt | Provider 流解析 |
| `tools` | Tool schema、执行、输出截断、文件写队列 | 循环控制 |
| `tui` | 输入与渲染 | Agent 业务逻辑 |

该结构刻意不建立 `StreamFn` 和第二套 Tool 执行器，避免与 AI SDK 重复。

---

## 4. 各模块详细设计

### 4.1 ai-adapter — Provider 与认证层

`ai-adapter` 只把应用的 `ModelConfig` 解析为 AI SDK `LanguageModel`，不包装 `streamText()`，也不拥有 Agent Loop。

```typescript
// ai-adapter/model-runtime.ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const providers = {
  openai,
  anthropic,
} as const;

export interface ModelConfig {
  provider: keyof typeof providers;
  modelId: string;
  contextWindow: number;
  reasoning?: boolean;
}

export function resolveModel(config: ModelConfig): LanguageModel {
  return providers[config.provider](config.modelId);
}
```

`ModelRuntime` 继续负责：

- Model catalog 与元数据
- `~/.config/tater/auth.json` 凭据（遵循 `$XDG_CONFIG_HOME/tater`）
- API key 环境变量/本地凭据解析
- 需要时的 OAuth 登录与刷新

Provider 官方包自行读取标准环境变量。只有 OAuth 或自定义凭据存储需要额外注入 Provider 配置。

### 4.2 agent-core — AI SDK Agent 薄封装

#### 4.2.1 AgentMessage 边界

内部消息仍与模型消息分离：

```typescript
import type { ModelMessage } from "ai";

interface CustomAgentMessages {}

type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomAgentMessages[keyof CustomAgentMessages];

type ConvertToModelMessages = (
  messages: AgentMessage[],
) => ModelMessage[] | Promise<ModelMessage[]>;
```

Session 可以保存 Compaction、Extension 和 UI 专用消息；调用模型前由 `convertToModelMessages` 过滤并转换。

#### 4.2.2 Tool 定义

直接采用 AI SDK 的 `tool()` 与 Zod，不再维护 `AgentTool → SDK Tool` 转换层：

```typescript
import { tool } from "ai";
import { z } from "zod";

export const readTool = tool({
  description: "Read a file",
  inputSchema: z.object({
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async ({ path, offset = 0, limit }) => {
    const lines = (await Bun.file(path).text()).split("\n");
    return lines.slice(offset, limit ? offset + limit : undefined).join("\n");
  },
});
```

AI SDK 默认并行执行同一 Step 的 Tool Calls。需要串行的文件修改在 `edit`/`write` 内共享一个 mutation queue，不为此重写循环。

#### 4.2.3 Agent 生命周期事件

`fullStream` 与回调映射为应用事件：

| AI SDK | AgentEvent |
| --- | --- |
| Agent 调用开始 | `agent_start` |
| `onStepStart` | `turn_start` |
| `fullStream` text/reasoning delta | `message_update` |
| `onToolExecutionStart` | `tool_execution_start` |
| Tool preliminary/result part | `tool_execution_update/end` |
| `onStepEnd` | `turn_end` |
| Stream 完成 | `agent_end` |

`AgentSession` 订阅这些应用事件，TUI 和存储层无需依赖 AI SDK 的原始类型。

#### 4.2.4 Steering

Steering 消息进入队列，并在当前 Tool 批次完成后的下一次模型调用前注入：

```typescript
const steeringQueue: ModelMessage[] = [];

const agent = new ToolLoopAgent({
  model,
  tools,
  prepareStep({ messages }) {
    const steering = steeringQueue.splice(0);
    return steering.length ? { messages: [...messages, ...steering] } : undefined;
  },
});
```

这与 Pi 的核心语义一致：不会取消已经产生的 Tool Calls，也不会跳过当前 Tool 执行。

#### 4.2.5 Follow-up

Follow-up 不属于内层 Tool Loop，只需在一次 Agent 调用自然结束后继续：

```typescript
async function run(messages: ModelMessage[]) {
  while (true) {
    await consume(await agent.stream({ messages }));

    const followUps = followUpQueue.splice(0);
    if (followUps.length === 0) return;
    messages.push(...followUps);
  }
}
```

该外层循环只处理跨调用消息，不执行 Tool，也不解析 Provider 流。

#### 4.2.6 动态调整与停止

- `prepareStep` 替代 `prepareNextTurn` 和 `transformContext`
- `stopWhen` 替代 `shouldStopAfterTurn` 的常见情况
- `AbortController` 负责立即中止
- `repairToolCall` 负责参数解析失败后的修复
- `toolApproval` 负责高风险 Tool 的人工审批
- `isStepCount(20)` 是默认安全上限，可由 Settings 覆盖

仅当出现 AI SDK 无法表达的真实需求时，才增加自定义控制，不预先复制 Pi 的完整状态机。

---

### 4.3 agent-session — 会话层

#### 4.3.1 AgentSession

```typescript
// agent-session/agent-session.ts
class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  // 事件订阅 (封装 Agent 事件 + session 特有事件)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // 核心操作
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // 状态访问
  get state(): AgentState;
  get model(): ModelConfig | undefined;
  get isStreaming(): boolean;
  get isIdle(): boolean;

  // Model 管理
  setModel(model: ModelConfig): void;
  cycleModel(): ModelCycleResult;
  setThinkingLevel(level: ThinkingLevel): void;

  // Tool 管理
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  getAllTools(): ToolInfo[];

  // Compaction
  compact(reason?: "manual" | "threshold"): Promise<CompactionResult>;
  get isCompacting(): boolean;

  // Session 操作
  newSession(): Promise<void>;
  forkSession(sourcePath: string): Promise<void>;
  switchSession(path: string): Promise<void>;

  // 生命周期
  dispose(): void;
}
```

`AgentSessionEvent` 扩展 `AgentEvent`：

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }                    // agent 完全空闲
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: ... }
  | { type: "compaction_end"; result: ...; aborted: boolean }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "auto_retry_start"; attempt: number; ... }
  | { type: "auto_retry_end"; success: boolean; ... };
```

#### 4.3.2 SessionManager (JSONL 持久化)

```typescript
// agent-session/session-manager.ts
class SessionManager {
  static create(cwd: string, sessionDir?: string): SessionManager;
  static open(path: string, sessionDir?: string): SessionManager;
  static continueRecent(cwd: string, sessionDir?: string): SessionManager;
  static forkFrom(sourcePath: string, cwd: string, sessionDir?: string): SessionManager;
  static list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;

  // Session 文件格式：JSONL，每行一个 entry
  // 第一行：SessionHeader { type: "session", id, timestamp, cwd, parentSession? }
  // 后续行：SessionEntry (message/thinkingLevelChange/modelChange/compaction/branchSummary/custom)
  // 追加写入用 Bun.write(path, line + "\n", { append: true })
  // 读取用 Bun.file(path).text() 然后按行 split

  appendMessage(message: AgentMessage): void;
  appendModelChange(provider: string, modelId: string): void;
  appendThinkingLevelChange(level: ThinkingLevel): void;
  appendCustomMessageEntry(type: string, content: any, display: any, details: any): void;
  appendCompactionEntry(entry: CompactionEntry): void;

  buildSessionContext(): SessionContext;  // 从 JSONL 重建 messages + model + thinking
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
}
```

**JSONL 格式设计**：

```jsonl
{"type":"session","id":"01J...","timestamp":"2025-01-15T10:00:00Z","cwd":"/project"}
{"type":"message","id":"01J...","parentId":null,"timestamp":"...","role":"user","content":[...]}
{"type":"modelChange","id":"01J...","parentId":"...","timestamp":"...","provider":"anthropic","modelId":"claude-sonnet-4-5"}
{"type":"thinkingLevelChange","id":"01J...","parentId":"...","timestamp":"...","level":"high"}
{"type":"message","id":"01J...","parentId":"...","timestamp":"...","role":"assistant","content":[...],"usage":{...},"stopReason":"stop"}
{"type":"compaction","id":"01J...","parentId":"...","timestamp":"...","details":{"readFiles":[...],"modifiedFiles":[...]}}
{"type":"branchSummary","id":"01J...","parentId":"...","timestamp":"..."}
```

**Bun 实现**：

```typescript
// 追加写入 (高性能)
await Bun.write(sessionFile, JSON.stringify(entry) + "\n", { append: true });

// 批量读取 (重建 session)
const text = await Bun.file(sessionFile).text();
const entries = text.trim().split("\n").map(l => JSON.parse(l));

// 可选: 用 bun:sqlite 建立 session 索引 (快速 list/search)
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, timestamp TEXT, parent TEXT)");
// session list 不再需要扫描所有 JSONL 文件
```

#### 4.3.3 Compaction（上下文压缩）

```typescript
// agent-session/compaction.ts

interface CompactionSettings {
  threshold: number;          // context window 使用比例触发阈值，默认 0.8
  overflowThreshold: number;  // 溢出阈值，默认 0.95
  preserveRecentTurns: number; // 保留最近 N 轮不压缩
}

// 流程：
// 1. shouldCompact(contextTokens, contextWindow, settings) → boolean
// 2. prepareCompaction(messages, settings)
//    → 找到截断点（turn 边界），分为 [待压缩部分] + [保留部分]
// 3. compact(toCompress, model, streamFn)
//    → 用 LLM 生成 [待压缩部分] 的摘要
//    → 返回 [摘要消息] + [保留部分]
// 4. 持久化 CompactionEntry，重新加载 session
```

#### 4.3.4 SettingsManager（分层配置）

```typescript
// agent-session/settings-manager.ts
class SettingsManager {
  static create(cwd: string, agentDir: string): SettingsManager;

  // 配置文件层级（优先级从高到低）：
  // 1. CLI 参数 (--model, --thinking, ...)
  // 2. Project settings (.tater/settings.json)
  // 3. Global settings (~/.config/tater/settings.json，遵循 $XDG_CONFIG_HOME)

  getDefaultProvider(): string | undefined;
  getDefaultModel(): string | undefined;
  getDefaultThinkingLevel(): ThinkingLevel | undefined;
  getTheme(): string;
  getSteeringMode(): "all" | "one-at-a-time";
  getRetrySettings(): RetrySettings;
  // ... 其他配置
}
```

```typescript
// Bun 实现: 配置文件读写
async function loadSettings(path: string): Promise<Settings> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  return await file.json();
}

async function saveSettings(path: string, settings: Settings): Promise<void> {
  await Bun.write(path, JSON.stringify(settings, null, 2));
}
```

#### 4.3.5 SystemPrompt 构建

```typescript
// agent-session/system-prompt.ts
function buildSystemPrompt(options: {
  cwd: string;
  customPrompt?: string;           // 替换默认 prompt
  appendSystemPrompt?: string;      // 追加到默认 prompt
  selectedTools: string[];
  toolSnippets: Record<string, string>;
  promptGuidelines: string[];
  skills: Skill[];
  contextFiles: Array<{ path: string; content: string }>;
}): string;
```

### 4.4 tools — 内置工具

```typescript
// tools/index.ts
// 每个工具是一个工厂函数，接收 cwd 和 options，返回 AgentTool

interface ToolOptions {
  cwd: string;
  // 可注入 mock 实现用于测试
  readOps?: ReadOperations;
  bashOps?: BashOperations;
  editOps?: EditOperations;
  writeOps?: WriteOperations;
}

function createReadTool(options: ToolOptions): AgentTool;
function createBashTool(options: ToolOptions): AgentTool;
function createEditTool(options: ToolOptions): AgentTool;
function createWriteTool(options: ToolOptions): AgentTool;
function createGrepTool(options: ToolOptions): AgentTool;
function createFindTool(options: ToolOptions): AgentTool;
function createLsTool(options: ToolOptions): AgentTool;
```

每个工具的结构：

```typescript
const readTool: AgentTool = {
  name: "read",
  label: "Read",
  description: "Read the contents of a file...",
  parameters: z.object({
    path: z.string().describe("Path to the file"),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async (toolCallId, params, signal, onUpdate) => {
    // 使用 Bun.file() 替代 fs.readFile
    const file = Bun.file(params.path);
    const fullContent = await file.text();
    const lines = fullContent.split("\n");
    const start = params.offset ?? 0;
    const end = params.limit ? start + params.limit : lines.length;
    const content = lines.slice(start, end).join("\n");
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, lines: content.split("\n").length },
    };
  },
};
```

```typescript
// bash 工具使用 Bun.spawn() 替代 child_process.spawn
const bashTool: AgentTool = {
  name: "bash",
  label: "Bash",
  description: "Execute a bash command...",
  parameters: z.object({
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional(),
  }),
  execute: async (toolCallId, params, signal, onUpdate) => {
    const proc = Bun.spawn(["bash", "-c", params.command], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return {
      content: [{ type: "text", text: stdout || stderr }],
      details: { command: params.command, exitCode, stdout, stderr },
      isError: exitCode !== 0,
    };
  },
};
```

```typescript
// write 工具使用 Bun.write() 替代 fs.writeFile
const writeTool: AgentTool = {
  name: "write",
  label: "Write",
  description: "Write content to a file...",
  parameters: z.object({
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write"),
  }),
  execute: async (toolCallId, params, signal) => {
    await Bun.write(params.path, params.content);
    return {
      content: [{ type: "text", text: `Written to ${params.path}` }],
      details: { path: params.path, bytes: params.content.length },
    };
  },
};
```

### 4.5 extensions — 扩展系统

```typescript
// extensions/types.ts

interface ExtensionContext {
  // Session API
  session: {
    prompt(text: string): Promise<void>;
    steer(text: string): Promise<void>;
    getModel(): ModelConfig | undefined;
    setModel(model: ModelConfig): void;
    getActiveToolNames(): string[];
    setActiveToolsByName(names: string[]): void;
    // ... 其他 session 操作
  };

  // UI API (由当前 run mode 提供实现)
  ui: ExtensionUIContext;

  // 工具注册
  tools: {
    register(tool: AgentTool): void;
    get(name: string): AgentTool | undefined;
  };

  // 命令注册
  commands: {
    register(name: string, handler: (args: string, ctx: CommandContext) => Promise<void>): void;
  };
}

interface ExtensionFactory {
  (ctx: ExtensionContext): void | Promise<void>;
}

interface Extension {
  name: string;
  factory: ExtensionFactory;
  // 声明的 CLI flags
  flags?: Map<string, FlagDefinition>;
}
```

Extension 生命周期事件：

```typescript
type ExtensionEvent =
  | { type: "session_start"; reason: "startup" | "resume" | "fork" }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "agent_settled" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_call"; toolName: string; toolCallId: string; input: any }
  | { type: "tool_result"; toolName: string; toolCallId: string; content: any; isError: boolean }
  | { type: "input"; text: string; images?: ImageContent[] }
  | { type: "before_provider_request"; payload: any }
  | { type: "after_provider_response"; status: number; headers: any }
  | { type: "session_shutdown" };
```

### 4.6 tui — TUI 层

#### 4.6.1 三种 Run Mode

```typescript
// tui/main.tsx
async function main(args: string[]) {
  // 1. 解析 CLI 参数
  const parsed = parseArgs(args);

  // 2. 创建 SessionManager (新建/打开/继续/fork)
  const sessionManager = await createSessionManager(parsed);

  // 3. 创建 AgentSession (内部创建 Agent + services)
  const { session } = await createAgentSession({ sessionManager, ...parsed });

  // 4. 根据模式分发
  const mode = resolveAppMode(parsed);
  if (mode === "interactive") {
    await runInteractiveMode(session, { initialMessage, ... });
  } else if (mode === "rpc") {
    await runRpcMode(session);
  } else {
    await runPrintMode(session, { initialMessage, ... });
  }
}
```

#### 4.6.2 InteractiveMode（基于 @opentui/solid + SolidJS）

```tsx
// tui/modes/interactive.tsx
import { render, useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup, onMount } from "solid-js";

const InteractiveMode = (props: { session: AgentSession }) => {
  const [messages, setMessages] = createSignal<AgentMessage[]>([]);

  onMount(() => {
    const unsubscribe = props.session.subscribe((event) => {
      // 将 AgentSession 事件映射为 signals，SolidJS 只更新受影响的组件。
    });
    onCleanup(unsubscribe);
  });

  useKeyboard((event) => {
    // Enter 提交，Ctrl+C 中断或退出。
  });

  return (
    <box flexDirection="column">
      <MessageList messages={messages()} />
      <Editor />
      <Footer />
    </box>
  );
};

export const runInteractiveMode = async (session: AgentSession) =>
  render(() => <InteractiveMode session={session} />);

```

Solid JSX 组件树：

```text
┌────────────────────────────────────┐
│ MessageList（滚动区域）              │
│   UserMessage                      │
│   AssistantMessage（Markdown）      │
│   ToolResultBlock                  │
├────────────────────────────────────┤
│ StreamingIndicator                 │
├────────────────────────────────────┤
│ Editor                             │
├────────────────────────────────────┤
│ Footer（model、tokens、cost）        │
└────────────────────────────────────┘
```

需要使用 `@opentui/solid` JSX 实现 Markdown、滚动消息列表、行编辑器、自动补全和状态栏。Session 事件只负责更新 signals，不再手动调用 renderer 重绘。

#### 4.6.3 PrintMode（无 TUI）

```typescript
// tui/modes/print.ts
async function runPrintMode(session: AgentSession, options: PrintOptions) {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.message.role === "assistant") {
      // 增量输出到 stdout
      process.stdout.write(getDelta(event.message));
    }
    if (event.type === "tool_execution_end") {
      // 输出工具执行结果
      console.error(formatToolResult(event));
    }
  });

  if (options.initialMessage) {
    await session.prompt(options.initialMessage);
  }
}
```

#### 4.6.4 RpcMode（JSON-RPC over Unix socket）

使用 Bun 原生能力实现 RPC 服务端。

```typescript
// tui/modes/rpc.ts
import type { AgentSession } from "@my/agent-session";

async function runRpcMode(session: AgentSession) {
  // 方案 A: Bun.serve + Unix socket (高性能 IPC)
  const server = Bun.serve({
    unix: getSocketPath(),          // Bun 原生 Unix socket 支持
    fetch(req) {
      const { method, params, id } = await req.json();
      const result = handleRpcMethod(session, method, params);
      return Response.json({ id, result });
    },
    // WebSocket 用于事件流推送
    websocket: {
      open(ws) { ws.subscribe("events"); },
      message() {},  // 客户端不需要发消息
    },
  });

  // 将 session 事件推送到所有 WebSocket 客户端
  session.subscribe((event) => {
    server.publish("events", JSON.stringify(event));
  });

  // RPC 方法注册:
  // - prompt(text, options) → void
  // - steer(text) → void
  // - abort() → void
  // - subscribe() → WebSocket 事件流 (server.publish)
  // - getActiveTools() → string[]
  // - setActiveTools(names) → void
  // - ...

  // 方案 B: stdin/stdout JSON-RPC (简单模式，无需 socket 文件)
  // 适合作为子进程被其他 agent 编排
  const stdinRpc = createStdinRpc(session);
  await stdinRpc.run();
}

function getSocketPath(): string {
  const dir = `${import.meta.dir}/.tmp`;
  return `${dir}/agent-${process.pid}.sock`;
}
```

---

## 5. 数据流与核心循环

### 5.1 一次完整交互

```
用户输入
  ▼
AgentSession.prompt()
  ├─ command / skill / extension input 处理
  ├─ Compaction 检查
  ├─ AgentMessage[] → ModelMessage[]
  ▼
agent-core.run()
  ├─ 创建或调用 ToolLoopAgent
  ├─ emit agent_start
  ▼
ToolLoopAgent.stream()
  ├─ prepareStep：注入 steering / 调整 model、messages、tools
  ├─ 调用 Provider
  ├─ fullStream → message_update
  ├─ Tool schema 校验与并行执行
  ├─ Tool hooks → tool_execution_*
  ├─ onStepEnd → turn_end + 持久化
  └─ stopWhen / 自然停止
  ▼
agent-core 外层检查 follow-up
  ├─ 有：追加消息并再次调用 ToolLoopAgent
  └─ 无：emit agent_end / agent_settled
  ▼
TUI 更新，SessionManager 追加 JSONL
```

### 5.2 消息边界

```
AgentMessage[]
  │ transform/compaction（应用层）
  ▼
AgentMessage[]
  │ convertToModelMessages()
  ▼
AI SDK ModelMessage[]
  │ ToolLoopAgent.stream()
  ▼
fullStream + onStepEnd
  │ mapAgentEvent()
  ▼
AgentEvent
  ├─ TUI
  ├─ Session JSONL
  └─ Extensions
```

只有 `ModelMessage[]` 进入 AI SDK。自定义 Session 消息永远停留在应用层。

---

## 6. 目录结构建议

```
tater/
├── package.json
├── bunfig.toml
├── tsconfig.base.json
├── tsconfig.json
└── packages/
    ├── ai-adapter/
    │   └── src/
    │       ├── index.ts
    │       ├── model-runtime.ts
    │       ├── adapters/
    │       │   ├── registry.ts
    │       │   ├── openai.ts
    │       │   └── anthropic.ts
    │       ├── auth/
    │       └── models/
    ├── agent-core/
    │   └── src/
    │       ├── index.ts
    │       ├── agent.ts             # ToolLoopAgent 薄封装
    │       ├── types.ts             # AgentMessage / AgentEvent
    │       └── queues.ts            # steering / follow-up
    ├── agent-session/
    │   └── src/
    │       ├── agent-session.ts
    │       ├── session-manager.ts
    │       ├── settings-manager.ts
    │       ├── system-prompt.ts
    │       ├── compaction/
    │       └── extensions/
    ├── tools/
    │   └── src/
    │       ├── read.ts
    │       ├── bash.ts
    │       ├── edit.ts
    │       ├── write.ts
    │       ├── grep.ts
    │       ├── find.ts
    │       ├── ls.ts
    │       ├── truncate.ts
    │       └── file-mutation-queue.ts
    ├── storage/
    │   └── src/
    │       ├── jsonl.ts
    │       └── sqlite.ts
    └── tui/
        └── src/
            ├── main.tsx
            ├── modes/
            │   ├── interactive/
            │   ├── print-mode.ts
            │   └── rpc-mode.ts
            └── config.ts
```

删除原设计中的 `agent-core/agent-loop.ts`、`agent-core/stream-fn.ts` 和 `ai-adapter/stream-fn.ts` 职责；相应能力由 AI SDK 提供。

---

## 7. 实现路线图

### Phase 1：最小可用 Agent

1. 安装 `ai`、`@ai-sdk/openai`，不引入第二套 LLM SDK
2. `ai-adapter` 实现 OpenAI `LanguageModel` 解析
3. `tools` 用 AI SDK `tool()` 实现 read/bash/edit/write
4. `agent-core` 用 `ToolLoopAgent` + `fullStream` 实现最小事件映射
5. `agent-session` 实现内存会话与 Steering/Follow-up 队列
6. `tui` 先实现 PrintMode

### Phase 2：交互式 TUI

1. 使用 `@opentui/solid` JSX 组件构建消息列表、Markdown、输入框、状态栏
2. 将 Session 事件映射到增量 UI
3. 加入 system prompt 与 context files

### Phase 3：持久化与上下文

1. JSONL Session create/open/continue/fork/list
2. SettingsManager 分层配置
3. Compaction 与 auto-retry
4. 可选 SQLite Session 索引

### Phase 4：扩展系统

1. ExtensionRunner 与 ExtensionContext
2. Skills、prompt templates、commands
3. 补充 grep/find/ls

### Phase 5：多 Provider 与 Auth

1. 增加 `@ai-sdk/anthropic` 等官方 Provider
2. API key 存储
3. 按实际需要实现 OAuth
4. Model catalog 与 model cycling

### Phase 6：高级模式

1. RPC 模式
2. Tool approval
3. Thinking level / providerOptions
4. 自动补全、HTML 导出和独立二进制

每个 Phase 只实现当前需要的能力，不提前复刻 Pi 内部抽象。

---

## 附录 A：关键设计决策

### A.1 为什么使用 ToolLoopAgent？

AI SDK 已提供内层循环最难且最通用的部分：Provider 流标准化、Tool Call 解析与校验、Tool 执行、Step 管理、停止条件、审批和错误传播。再次实现这些能力只会形成第二套状态机。

| 能力 | 实现位置 |
| --- | --- |
| Tool Loop | AI SDK `ToolLoopAgent` |
| 每轮 model/context/tools 调整 | `prepareStep` |
| 停止规则 | `stopWhen` |
| Tool 生命周期 | AI SDK callbacks / `fullStream` |
| Steering | `prepareStep` + Session 队列 |
| Follow-up | Agent 调用外层的小循环 |
| Session 自定义消息 | `AgentMessage` + 边界转换 |
| Compaction/持久化/扩展 | `agent-session` |

### A.2 为什么仍保留 AgentMessage？

- Session 需要保存 Compaction、Extension 和 UI 消息
- 这些消息不一定符合模型协议，也不应消耗上下文
- `convertToModelMessages` 是唯一模型调用边界
- AI SDK `ModelMessage` 不泄漏到 Session 文件格式和 TUI API

### A.3 为什么不提供 StreamFn？

`ToolLoopAgent.stream()` 已经返回标准化 `fullStream`。额外的 `StreamFn` 会重复 Provider 抽象，并迫使项目再次定义 text/thinking/tool-call 事件协议。应用只需把 `fullStream` 映射成稳定的 `AgentEvent`。

### A.4 Tool 执行策略

AI SDK 默认并行执行同一 Step 的 Tool Calls。文件写冲突由 `file-mutation-queue.ts` 在 Tool 边界串行化。这比复制完整 Tool 调度器更小，也能覆盖真实风险。只有未来出现跨 Tool 的严格事务语义时，才扩展调度。

---

## 附录 B：Bun 生态使用指南

本项目以 Bun 为运行时。以下场景优先使用 Bun 内置 API 而非 Node.js 生态：

| 模块 | Bun API | 说明 |
| ------ | --------- | ------ |
| **bash 工具** | `Bun.spawn()` / `Bun.spawnSync()` | 替代 `child_process.spawn`，支持流式 stdout/stderr |
| **read 工具** | `Bun.file(path).text()` | 替代 `fs.readFile`，更简洁 |
| **write 工具** | `Bun.write(path, data)` | 替代 `fs.writeFile`，支持 string/ArrayBuffer/Blob |
| **edit 工具** | `Bun.file()` + `Bun.write()` | 读取-修改-写入 |
| **JSONL 存储** | `Bun.write(path, line, { append: true })` | 追加写入 session 日志 |
| **SQLite 索引** | `import { Database } from "bun:sqlite"` | 内置 SQLite，无需额外依赖 |
| **配置文件** | `Bun.file(path).json()` | 读取/写入 JSON 配置 |
| **RPC 服务** | `Bun.serve({ unix, fetch, websocket })` | Unix socket + HTTP + WebSocket 一体 |
| **子进程** | `Bun.spawn()` | 替代 `child_process` |
| **密码学** | `Bun.hash()` / `Bun.CryptoHasher` | 替代 `node:crypto`（简单哈希场景） |
| **环境变量** | `Bun.env` | 替代 `process.env` |
| **运行 TS** | `bun run file.ts` | 无需 tsx/ts-node |
| **测试** | `bun test` | 内置测试框架（也可保留 vitest） |
| **打包** | `bun build --compile` | 生成独立可执行二进制 |

### 兼容性说明

- Vercel AI SDK、SolidJS 和 `@opentui/solid` 可在 Bun 中使用
- Bun 支持 Node.js API 兼容层，少量代码如果使用了 `node:fs`、`node:path` 等也能正常工作
- 建议新代码优先使用 Bun API，但不必强制重写已有的 Node.js 兼容代码
- `bun:sqlite` 的 API 与 `node:sqlite` 略有不同，但功能等价

---

## 附录 C：Vercel AI SDK → agent-core 类型映射

| Vercel AI SDK | agent-core | 说明 |
| --- | --- | --- |
| `ToolLoopAgent` | `Agent` 薄封装 | 内层 Tool Loop 由 SDK 管理 |
| `ModelMessage` | 模型调用边界格式 | 从 `AgentMessage` 转换 |
| `tool()` | 内置工具 | 直接使用，不做 schema 转换 |
| `prepareStep` | Steering / 动态配置 | 注入消息、切换 model/tools |
| `stopWhen` | 停止策略 | 步数和自定义条件 |
| `fullStream` | `AgentEvent` 来源 | 映射 text/reasoning/tool 事件 |
| `onStepStart/onStepEnd` | `turn_start/turn_end` | 生命周期映射 |
| `onToolExecutionStart/End` | `tool_execution_start/end` | Tool 生命周期映射 |
| `repairToolCall` | Tool 参数修复 | 使用 SDK 能力 |
| `toolApproval` | Tool 审批 | 使用 SDK 能力 |
| `LanguageModel` | `ModelRuntime.resolveModel()` 返回值 | Provider 官方实现 |

# 类 Pi Agent 架构设计方案

> 基于 Pi (pi-mono) 源码深度分析，使用 `@tanstack/ai` 替代 LLM 请求层，`@opentui/core` 替代 TUI 层，其余自主实现。

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
│              agent-core (Agent Runtime)                   │  ← 运行时：状态机 + 事件 + 循环
│  Agent · AgentLoop · AgentMessage · AgentTool · AgentEvent │
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
| `pi-ai` | 多 Provider LLM 请求 | `@tanstack/ai` | Model 发现/注册、Auth 存储、OAuth 流程 |
| `pi-tui` | 终端 UI 渲染 | `@opentui/core` | Markdown 渲染、Editor 组件、Autocomplete |
| `pi-agent-core` | Agent 运行时 | **自己实现** | 全部 |
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

### 2.1 `@tanstack/ai` 提供的能力

```typescript
// 核心活动函数
chat({
  adapter: openaiText("gpt-5.2"),    // 或 anthropicText("claude-sonnet-4-5")
  messages: [...],                   // UIMessage[] | ModelMessage[]
  systemPrompts: ["..."],             // 系统提示
  tools: {                           // 工具定义
    getWeather: toolDefinition({
      name: "getWeather",
      description: "...",
      parameters: z.object({...}),
      execute: async (args) => {...},
    }),
  },
  stopWhen: "toolCall" | hasToolCall, // 停止条件
  maxSteps: 10,                      // 最大循环步数
  middleware: [{                     // 中间件
    beforeToolCall: async (ctx) => {...},
    afterToolCall: async (ctx) => {...},
    onStepFinish: async (ctx) => {...},
  }],
})
// 返回: { textStream, fullText, text, usage, steps, ... }
```

**关键差异**：

- Pi 的 `streamFn` 返回 `AssistantMessageEventStream`（细粒度事件流），`@tanstack/ai` 的 `chat()` 返回高层次结果
- Pi 的 agent loop 是自己实现的（完全控制 steering/followUp/prepareNextTurn），`@tanstack/ai` 有内置 loop（`stopWhen`/`maxSteps`）
- Pi 有 `AgentMessage` 自定义消息扩展，`@tanstack/ai` 用 `UIMessage`/`ModelMessage`
- Pi 的 tool 用 TypeBox schema，`@tanstack/ai` 用 Zod schema

### 2.2 `@opentui/core` 提供的能力

```typescript
import { createCliRenderer, type KeyEvent } from "@opentui/core";

const renderer = await createCliRenderer({});

// Renderable 系统
const root = renderer.createRenderable({
  type: "row",
  children: [
    { type: "text", content: "Hello" },
    { type: "text", content: "World" },
  ],
});

// 键盘输入
renderer.keyInput.on("keypress", (event: KeyEvent) => {
  if (event.name === "return") { /* ... */ }
});

// 渲染循环由 renderer 内部驱动
```

**关键差异**：

- Pi 的 TUI 是自研差分渲染引擎 + 自定义组件系统
- `@opentui/core` 提供原生 Zig 渲染核心 + TypeScript 绑定
- 你需要在 `@opentui/core` 的 renderable 系统之上构建：Markdown 组件、消息列表、编辑器输入框、状态栏等

---

## 3. 整体架构设计

### 3.1 包结构

```
my-agent/
├── packages/
│   ├── ai-adapter/          # @tanstack/ai → 统一 StreamFn 适配层
│   ├── agent-core/          # Agent 运行时 (自己实现，对应 pi-agent-core)
│   ├── agent-session/       # 会话管理 + 应用层核心 (自己实现)
│   ├── tools/               # 内置工具 (read/bash/edit/write/grep/find/ls)
│   ├── storage/             # JSONL session 持久化
│   ├── extensions/          # 扩展系统
│   └── cli/                 # CLI 入口 + TUI (使用 @opentui/core)
├── package.json             # monorepo (bun workspaces)
├── bunfig.toml              # Bun 配置
└── tsconfig.json
```

### 3.2 依赖关系图

```
                    ┌──────────┐
     运行时: Bun      │   cli    │ ← @opentui/core, @tanstack/ai
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        ┌─────────┐ ┌──────────┐ ┌──────────┐
        │ session  │ │ tools   │ │extensions│
        └────┬────┘ └────┬────┘ └────┬─────┘
             │           │           │
             └─────┬─────┴───────────┘
                   ▼
            ┌─────────────┐
            │ agent-core  │ ← ai-adapter
            └──────┬──────┘
                   │
            ┌──────┴──────┐
            │  ai-adapter │ ← @tanstack/ai
            └─────────────┘

  存储层使用 Bun.file() / Bun.write() / bun:sqlite
  RPC 服务使用 Bun.serve() / Bun.spawn()
  子进程用 Bun.spawn() 替代 child_process
```

### 3.3 层级职责

```
┌─────────────────────────────────────────────────────────────┐
│  cli (应用入口层)                                             │
│  - CLI 参数解析                                               │
│  - TUI 渲染 (@opentui/core)                                  │
│  - 交互/打印/RPC 三种模式                                      │
│  - 键盘事件 → AgentSession API                                 │
├─────────────────────────────────────────────────────────────┤
│  agent-session (会话层)                                       │
│  - AgentSession: 共享会话核心                                  │
│  - SessionManager: JSONL 持久化 + 分支/fork/resume            │
│  - SettingsManager: 分层配置                                  │
│  - Compaction: 上下文压缩                                      │
│  - SystemPrompt 构建                                          │
│  - Skills / PromptTemplates                                   │
│  - ModelRuntime: model 发现 + auth                            │
├─────────────────────────────────────────────────────────────┤
│  agent-core (运行时层)                                        │
│  - Agent: 有状态运行时                                         │
│  - AgentLoop: 核心循环                                        │
│  - AgentMessage: 双层消息抽象                                  │
│  - AgentTool: 工具定义 + 执行                                  │
│  - AgentEvent: 生命周期事件                                   │
│  - Steering/FollowUp 队列                                     │
│  - Hooks: beforeToolCall/afterToolCall/shouldStopAfterTurn   │
├─────────────────────────────────────────────────────────────┤
│  ai-adapter (LLM 适配层)                                      │
│  - @tanstack/ai chat() → StreamFn (Pi 兼容的事件流)           │
│  - Provider adapter 注册 (openai/anthropic/google/...)        │
│  - Model 元数据管理                                           │
│  - Auth/OAuth 存储与刷新                                      │
├─────────────────────────────────────────────────────────────┤
│  @tanstack/ai (外部依赖)                @opentui/core (外部)   │
│  - chat() / streamText               - createCliRenderer     │
│  - toolDefinition                    - Renderable 系统       │
│  - adapters (openai/anthropic/...)   - KeyEvent 输入        │
│  - middleware                        - 渲染循环              │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 各模块详细设计

### 4.1 ai-adapter — LLM 适配层

**目标**：将 `@tanstack/ai` 的 `chat()` 封装为 agent-core 需要的 `StreamFn` 接口。

#### 4.1.1 StreamFn 契约

```typescript
// agent-core 定义的流式函数契约
type StreamFn = (
  model: ModelConfig,
  context: LLMContext,
  options?: StreamOptions,
) => Promise<MessageEventStream>;

interface LLMContext {
  systemPrompt: string;
  messages: LLMMessage[];     // 纯 LLM 消息（已 convertToLlm）
  tools: AgentTool[];
}

interface ModelConfig {
  provider: string;           // "openai" | "anthropic" | "google" | ...
  modelId: string;             // "gpt-5.2" | "claude-sonnet-4-5" | ...
  reasoning?: boolean;
  contextWindow: number;
  // ...
}
```

#### 4.1.2 适配器实现

```typescript
// ai-adapter/stream-fn.ts
import { chat } from "@tanstack/ai";
import { openaiText, anthropicText } from "@tanstack/ai-openai"; // 各 provider adapter

const adapterRegistry = new Map<string, (modelId: string) => any>();
adapterRegistry.set("openai", (id) => openaiText(id));
adapterRegistry.set("anthropic", (id) => anthropicText(id));
// ... 更多 provider

export function createStreamFn(modelRuntime: ModelRuntime): StreamFn {
  return async (model, context, options) => {
    const adapterFactory = adapterRegistry.get(model.provider);
    if (!adapterFactory) throw new Error(`Unknown provider: ${model.provider}`);

    const apiKey = await modelRuntime.getApiKey(model.provider);

    // 将 agent-core 的 tools 转换为 @tanstack/ai 的 toolDefinition
    const tanstackTools = convertToolsToTanstack(context.tools);

    // 将 LLMContext.messages 转换为 @tanstack/ai 的 messages 格式
    const tanstackMessages = convertMessagesToTanstack(context.messages);

    const result = chat({
      adapter: adapterFactory(model.modelId),
      messages: tanstackMessages,
      systemPrompts: [context.systemPrompt],
      tools: tanstackTools,
      stopWhen: "toolCall",         // 有 tool call 时停止，agent-core 自己管理循环
      apiKey,
      signal: options?.signal,
      // 不用 @tanstack/ai 的 maxSteps 内置循环
    });

    // 将 @tanstack/ai 的结果流转换为 agent-core 期望的事件流
    return wrapTanstackResultAsStream(result, model);
  };
}
```

#### 4.1.3 事件流转换

```typescript
// 将 @tanstack/ai 的高层次结果转换为细粒度事件流
function wrapTanstackResultAsStream(result, model): MessageEventStream {
  // @tanstack/ai 的 textStream 是 AsyncIterable<string>
  // 需要包装为 { type: "text_start" } / { type: "text_delta", delta } / ... 事件
  // 以及 tool_call 相关事件

  // 关键：@tanstack/ai 的 stream 粒度可能不如 Pi 的 AssistantMessageEventStream 细
  // 需要根据实际 API 补充：
  // - thinking_start/delta/end (如果 provider 支持 reasoning)
  // - toolcall_start/delta/end
  // - done/error (附带 usage 和 stopReason)
}
```

#### 4.1.4 ModelRuntime

```typescript
// ai-adapter/model-runtime.ts
class ModelRuntime {
  // Model 发现：从 provider catalog 或本地缓存加载可用模型
  async getAvailable(): Promise<ModelConfig[]>;

  // 按 provider + modelId 获取模型
  getModel(provider: string, modelId: string): ModelConfig | undefined;

  // Auth 管理
  getApiKey(provider: string): Promise<string | undefined>;
  hasConfiguredAuth(provider: string): boolean;
  isUsingOAuth(provider: string): boolean;

  // OAuth 流程 (需要自己实现)
  async login(provider: string): Promise<void>;
  async refresh(provider: string): Promise<void>;
}
```

**你需要自己实现的部分**：

- Model catalog 管理（每个 provider 的可用模型列表、context window、cost 等元数据）
- API key 存储（`~/.my-agent/auth.json`）
- OAuth 流程（GitHub Copilot、Anthropic 等需要 OAuth 的 provider）
- Provider adapter 注册表

### 4.2 agent-core — Agent 运行时

这是你**完全自己实现**的核心层，对应 Pi 的 `pi-agent-core`。

#### 4.2.1 AgentMessage 双层抽象

```typescript
// agent-core/types.ts

// 基础 LLM 消息类型 (与 @tanstack/ai 对齐)
interface UserMessage { role: "user"; content: Content[]; timestamp: number; }
interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];  // text | thinking | toolCall
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  usage: Usage;
  errorMessage?: string;
  timestamp: number;
}
interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Content[];
  isError: boolean;
  timestamp: number;
}
type LLMMessage = UserMessage | AssistantMessage | ToolResultMessage;

// 自定义消息扩展 (declaration merging)
interface CustomAgentMessages {}  // 空接口，应用层扩展

// AgentMessage = LLM 消息 + 自定义消息
type AgentMessage = LLMMessage | CustomAgentMessages[keyof CustomAgentMessages];
```

应用层扩展示例：

```typescript
// agent-session/messages.ts
declare module "@my/agent-core" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage;
    compactionSummary: CompactionSummaryMessage;
    custom: CustomMessage;       // extension 注册的自定义消息
  }
}
```

#### 4.2.2 AgentTool 定义

```typescript
// agent-core/types.ts
interface AgentTool<TParams = any, TDetails = any> {
  name: string;
  description: string;
  parameters: ZodSchema<TParams>;    // 用 Zod (与 @tanstack/ai 对齐)
  label: string;                      // UI 显示名

  // 可选：参数预处理 (兼容旧格式参数)
  prepareArguments?: (args: unknown) => TParams;

  // 执行 (throw on error, 不要在 content 中编码错误)
  execute: (
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
  ) => Promise<AgentToolResult<TDetails>>;

  // 执行模式覆盖
  executionMode?: "sequential" | "parallel";
}

interface AgentToolResult<T = any> {
  content: (TextContent | ImageContent)[];  // 返回给 LLM 的内容
  details: T;                                  // UI 渲染用的结构化数据
  usage?: Usage;
  terminate?: boolean;                         // 暗示 agent 应在此批次后停止
  addedToolNames?: string[];                   // 动态注册的新工具
}
```

#### 4.2.3 AgentEvent 生命周期

```typescript
// agent-core/types.ts
type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期 (一轮 = 一次 assistant 响应 + 工具调用)
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // 消息生命周期
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; rawEvent?: unknown }
  | { type: "message_end"; message: AgentMessage }
  // 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

#### 4.2.4 Agent 类（有状态运行时）

```typescript
// agent-core/agent.ts
class Agent {
  // 状态
  get state(): AgentState;
  // systemPrompt, model, thinkingLevel, tools, messages
  // isStreaming, streamingMessage, pendingToolCalls, errorMessage

  // 订阅事件
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void;

  // 核心操作
  prompt(input: string | AgentMessage | AgentMessage[]): Promise<void>;
  continue(): Promise<void>;

  // 消息队列
  steer(message: AgentMessage): void;      // 当前 turn 的 tool calls 执行完后注入
  followUp(message: AgentMessage): void;   // agent 本应停止时注入
  clearAllQueues(): void;
  hasQueuedMessages(): boolean;

  // 控制
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;

  // 配置 (构造时设置)
  convertToLlm: (messages: AgentMessage[]) => LLMMessage[] | Promise<LLMMessage[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined>;

  // Hooks
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (ctx: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined | Promise<...>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}
```

#### 4.2.5 Agent Loop 实现

```typescript
// agent-core/agent-loop.ts
async function runLoop(
  context: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: (event: AgentEvent) => Promise<void>,
  streamFn: StreamFn,
): Promise<void> {
  let currentContext = context;
  let firstTurn = true;
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  // 外层循环：处理 follow-up
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环：处理 tool calls + steering
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) await emit({ type: "turn_start" });
      else firstTurn = false;

      // 注入 pending 消息
      for (const msg of pendingMessages) {
        await emit({ type: "message_start", message: msg });
        await emit({ type: "message_end", message: msg });
        currentContext.messages.push(msg);
        newMessages.push(msg);
      }
      pendingMessages = [];

      // 1. 流式获取 assistant 响应 (LLM 调用边界)
      //    transformContext → convertToLlm → streamFn
      const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
      newMessages.push(message);

      // 错误/中止 → 直接结束
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // 2. 提取并执行 tool calls
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        const batch = message.stopReason === "length"
          ? await failTruncatedToolCalls(toolCalls, emit)  // 截断 → 全标错
          : await executeToolCalls(currentContext, message, config, signal, emit);

        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      // 3. prepareNextTurn (可切换 model/context/thinking)
      const nextTurn = await config.prepareNextTurn?.({ message, toolResults, context: currentContext, newMessages });
      if (nextTurn) {
        currentContext = nextTurn.context ?? currentContext;
        config = { ...config, model: nextTurn.model ?? config.model };
      }

      // 4. shouldStopAfterTurn?
      if (await config.shouldStopAfterTurn?.({ message, toolResults, context: currentContext, newMessages })) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // 5. 拉取 steering 消息
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 拉取 follow-up 消息
    const followUps = (await config.getFollowUpMessages?.()) || [];
    if (followUps.length > 0) {
      pendingMessages = followUps;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

#### 4.2.6 Tool 执行（并行/顺序）

```typescript
// agent-core/agent-loop.ts (续)

async function executeToolCalls(context, assistantMessage, config, signal, emit) {
  const toolCalls = assistantMessage.content.filter(c => c.type === "toolCall");

  // 检查是否有工具要求顺序执行
  const hasSequential = toolCalls.some(tc =>
    context.tools?.find(t => t.name === tc.name)?.executionMode === "sequential"
  );

  if (config.toolExecution === "sequential" || hasSequential) {
    return executeSequential(context, assistantMessage, toolCalls, config, signal, emit);
  }
  return executeParallel(context, assistantMessage, toolCalls, config, signal, emit);
}

// 并行模式：先顺序准备（验证+hook），再并发执行
async function executeParallel(context, assistantMessage, toolCalls, config, signal, emit) {
  const prepared = [];

  // 阶段 1：顺序准备
  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

    const prep = await prepareToolCall(context, assistantMessage, toolCall, config, signal);
    if (prep.kind === "immediate") {
      // 验证失败或被 block → 立即产出错误结果
      await emit({ type: "tool_execution_end", toolCallId: toolCall.id, result: prep.result, isError: true });
      prepared.push({ finalized: { toolCall, result: prep.result, isError: true } });
    } else {
      // 准备好可执行
      prepared.push(async () => {
        const executed = await executePreparedTool(prep, signal, emit);
        const finalized = await finalizeToolCall(context, assistantMessage, prep, executed, config, signal);
        await emit({ type: "tool_execution_end", toolCallId: toolCall.id, result: finalized.result, isError: finalized.isError });
        return finalized;
      });
    }
    if (signal?.aborted) break;
  }

  // 阶段 2：并发执行
  const finalized = await Promise.all(
    prepared.map(p => typeof p === "function" ? p() : Promise.resolve(p))
  );

  // 阶段 3：按源顺序产出 toolResult 消息
  const messages = finalized.map(f => createToolResultMessage(f));
  for (const msg of messages) {
    await emit({ type: "message_start", message: msg });
    await emit({ type: "message_end", message: msg });
  }

  return { messages, terminate: finalized.every(f => f.result.terminate === true) };
}
```

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
  // 2. Project settings (.my-agent/settings.json)
  // 3. Global settings (~/.my-agent/settings.json)

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

### 4.6 cli — CLI + TUI 层

#### 4.6.1 三种 Run Mode

```typescript
// cli/main.ts
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

#### 4.6.2 InteractiveMode（基于 @opentui/core）

```typescript
// cli/modes/interactive.ts
import { createCliRenderer, type KeyEvent } from "@opentui/core";

class InteractiveMode {
  private renderer: CliRenderer;
  private session: AgentSession;

  async run(): Promise<void> {
    // 1. 创建 @opentui/core renderer
    this.renderer = await createCliRenderer({});

    // 2. 构建 UI 组件树
    this.buildUI();

    // 3. 订阅 AgentSession 事件 → 更新 UI
    this.session.subscribe((event) => this.handleSessionEvent(event));

    // 4. 键盘事件路由
    this.renderer.keyInput.on("keypress", (event: KeyEvent) => {
      this.handleKeyPress(event);
    });

    // 5. 进入渲染循环 (renderer 内部驱动)
    // renderer 会持续渲染直到进程退出
  }

  private buildUI(): void {
    // 使用 @opentui/core 的 renderable 系统构建：
    //
    // ┌────────────────────────────────────┐
    // │ MessageList (滚动区域)               │  ← 渲染 AgentMessage[]
    // │   UserMessage                       │
    // │   AssistantMessage (Markdown)       │
    // │   ToolResultBlock                   │
    // │   ...                               │
    // ├────────────────────────────────────┤
    // │ StreamingIndicator                  │  ← 流式输出时的加载动画
    // ├────────────────────────────────────┤
    // │ InputBox (编辑器)                    │  ← 用户输入
    // ├────────────────────────────────────┤
    // │ Footer (状态栏)                      │  ← model、tokens、cost
    // └────────────────────────────────────┘
    //
    // 需要在 @opentui/core 之上实现的组件：
    // - Markdown 渲染器 (解析 markdown → renderable tree)
    // - 滚动消息列表
    // - 行编辑器 (光标移动、选择、复制粘贴)
    // - 自动补全 (slash commands + model names + file paths)
    // - 状态栏
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.startStreamingDisplay(event.message);
        } else if (event.message.role === "user") {
          this.addUserMessage(event.message);
        }
        break;
      case "message_update":
        this.updateStreamingDisplay(event.message);
        break;
      case "message_end":
        this.finalizeMessage(event.message);
        break;
      case "tool_execution_start":
        this.addToolExecutionBlock(event.toolName, event.args);
        break;
      case "tool_execution_end":
        this.finalizeToolExecution(event.toolCallId, event.result, event.isError);
        break;
      case "agent_settled":
        this.setInputEnabled(true);
        break;
      // ... 其他事件
    }
    this.renderer.render();  // 触发重渲染
  }

  private handleKeyPress(event: KeyEvent): void {
    // Enter → 提交输入
    // Ctrl+C → 中断/退出
    // Ctrl+P → 切换 model
    // Tab → 自动补全
    // ↑/↓ → 滚动消息历史
    // ...
  }
}
```

#### 4.6.3 PrintMode（无 TUI）

```typescript
// cli/modes/print.ts
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
// cli/modes/rpc.ts
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

### 5.1 一次完整交互的数据流

```
用户输入 "帮我重构 auth.ts"
    │
    ▼
InteractiveMode.handleKeyPress(Enter)
    │
    ▼
AgentSession.prompt("帮我重构 auth.ts")
    │
    ├── 1. 扩展命令检查 (/command)
    ├── 2. 扩展 input 事件拦截
    ├── 3. Skill/Template 展开
    ├── 4. 流式中 → steer/followUp 排队
    ├── 5. Model + Auth 验证
    ├── 6. Compaction 检查
    ├── 7. 构建 messages 数组 (user msg + pending custom msgs)
    ├── 8. 扩展 before_agent_start (可注入 custom msg / 修改 system prompt)
    │
    └── _runAgentPrompt(messages)
         │
         └── Agent.prompt(messages)
              │
              └── runAgentLoop(messages, context, config, emit, signal, streamFn)
                   │
                   ├── emit agent_start
                   ├── emit turn_start
                   ├── emit message_start (user msg)
                   ├── emit message_end (user msg)
                   │
                   └── runLoop(context, newMessages, config, signal, emit, streamFn)
                        │
                        ├── streamAssistantResponse()
                        │    ├── transformContext(messages)  ← AgentMessage[] → AgentMessage[]
                        │    ├── convertToLlm(messages)       ← AgentMessage[] → LLMMessage[]
                        │    ├── streamFn(model, llmContext, options)  ← 调 @tanstack/ai chat()
                        │    │    └── @tanstack/ai → provider API → 流式响应
                        │    ├── emit message_start (partial assistant msg)
                        │    ├── emit message_update (text_delta, thinking_delta, toolcall_delta...)
                        │    └── emit message_end (final assistant msg)
                        │
                        ├── executeToolCalls()  ← read/bash/edit/write...
                        │    ├── prepareToolCall()  → beforeToolCall hook → extension tool_call event
                        │    ├── tool.execute()    → onUpdate → emit tool_execution_update
                        │    ├── finalizeToolCall() → afterToolCall hook → extension tool_result event
                        │    ├── emit tool_execution_start
                        │    ├── emit tool_execution_end
                        │    └── emit message_start/end (toolResult)
                        │
                        ├── emit turn_end
                        ├── prepareNextTurn()  ← 可切换 model/context
                        ├── shouldStopAfterTurn?
                        ├── getSteeringMessages()  ← 检查 steer 队列
                        │
                        └── [如果有 tool calls → 继续内层循环]
                           [如果无 tool calls + 无 steering → 检查 follow-up → 继续外层循环]
                           [如果无 follow-up → emit agent_end]
    │
    ▼
AgentSession._handleAgentEvent(event)
    │
    ├── 扩展事件转发 (_emitExtensionEvent)
    ├── 用户 listener 通知 (_emit)
    ├── Session 持久化 (message_end → appendMessage)
    ├── Auto-compaction 检查 (agent_end → _checkCompaction)
    ├── Auto-retry 检查 (error → _prepareRetry)
    └── Queue 状态更新
    │
    ▼
InteractiveMode.handleSessionEvent(event)
    │
    ├── message_update → 更新流式 Markdown 渲染
    ├── tool_execution_start → 添加工具执行块
    ├── tool_execution_end → 更新工具结果
    ├── agent_settled → 启用输入框
    └── renderer.render() → @opentui/core 差分渲染到终端
```

### 5.2 @tanstack/ai 集成的关键边界

```
AgentMessage[] (内部格式，含自定义消息)
    │
    │ transformContext() ← 可选：修剪/注入上下文
    ▼
AgentMessage[] (修剪后)
    │
    │ convertToLlm() ← 过滤自定义消息，转换为纯 LLM 格式
    ▼
LLMMessage[] (纯 user/assistant/toolResult)
    │
    │ 适配层转换
    ▼
@tanstack/ai messages (UIMessage[] / ModelMessage[])
    │
    │ chat({ adapter, messages, tools, systemPrompts })
    ▼
@tanstack/ai 结果流 (textStream, steps, usage)
    │
    │ wrapTanstackResultAsStream()
    ▼
MessageEventStream (start/text_delta/thinking_delta/toolcall_delta/done/error)
    │
    │ streamAssistantResponse() 消费事件流
    ▼
AgentEvent (message_start/update/end)
```

---

## 6. 目录结构建议

```
my-agent/
├── package.json                    # monorepo root (bun workspaces)
├── bunfig.toml                     # Bun 配置 (可选)
├── tsconfig.base.json
├── tsconfig.json
├── packages/
│   │
│   ├── ai-adapter/                 # LLM 适配层
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── stream-fn.ts        # StreamFn 实现 (包装 @tanstack/ai chat)
│   │       ├── model-runtime.ts    # Model 发现 + Auth + OAuth
│   │       ├── adapters/
│   │       │   ├── registry.ts     # Provider adapter 注册表
│   │       │   ├── openai.ts        # openaiText wrapper
│   │       │   ├── anthropic.ts     # anthropicText wrapper
│   │       │   └── ...
│   │       ├── auth/
│   │       │   ├── credential-store.ts
│   │       │   ├── oauth/
│   │       │   │   ├── device-code.ts
│   │       │   │   └── pkce.ts
│   │       │   └── types.ts
│   │       ├── models/
│   │       │   ├── store.ts        # Model 元数据缓存
│   │       │   └── catalog.ts     # Model 目录
│   │       └── types.ts
│   │
│   ├── agent-core/                 # Agent 运行时 (核心)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── agent.ts            # Agent 类 (有状态运行时)
│   │       ├── agent-loop.ts       # 核心循环 (双层 loop + tool 执行)
│   │       ├── types.ts            # AgentMessage, AgentTool, AgentEvent, ...
│   │       └── stream-fn.ts        # StreamFn 类型 + 默认实现
│   │
│   ├── agent-session/             # 会话管理 + 应用层
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── agent-session.ts    # AgentSession (共享会话核心)
│   │       ├── session-manager.ts  # JSONL 持久化
│   │       ├── settings-manager.ts # 分层配置
│   │       ├── system-prompt.ts    # System prompt 构建
│   │       ├── messages.ts        # AgentMessage 自定义类型扩展
│   │       ├── sdk.ts             # createAgentSession() 工厂
│   │       ├── compaction/
│   │       │   ├── index.ts
│   │       │   ├── compaction.ts   # 上下文压缩
│   │       │   ├── branch-summary.ts
│   │       │   └── utils.ts
│   │       ├── extensions/
│   │       │   ├── types.ts        # ExtensionContext, ExtensionEvent
│   │       │   ├── runner.ts      # ExtensionRunner
│   │       │   └── loader.ts      # Extension 加载
│   │       ├── skills.ts          # Skills 加载与管理
│   │       ├── resource-loader.ts # 统一资源加载
│   │       ├── model-resolver.ts  # Model 解析
│   │       └── retry.ts           # Auto-retry 逻辑
│   │
│   ├── tools/                      # 内置工具
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── read.ts
│   │       ├── bash.ts
│   │       ├── edit.ts
│   │       ├── write.ts
│   │       ├── grep.ts
│   │       ├── find.ts
│   │       ├── ls.ts
│   │       ├── truncate.ts         # 输出截断
│   │       └── file-mutation-queue.ts  # 文件修改队列 (防冲突)
│   │
│   ├── storage/                    # JSONL session 存储 (Bun 原生 IO)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── jsonl.ts            # JSONL 读写 (Bun.file / Bun.write)
│   │       └── sqlite.ts           # 可选: Bun:sqlite 索引层
│   │
│   └── cli/                        # CLI + TUI
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── main.ts            # CLI 入口
│           ├── cli/
│           │   ├── args.ts         # 参数解析
│           │   └── initial-message.ts
│           ├── modes/
│           │   ├── interactive/
│           │   │   ├── interactive-mode.ts
│           │   │   ├── components/
│           │   │   │   ├── message-list.ts    # 消息列表组件
│           │   │   │   ├── markdown.ts         # Markdown 渲染器
│           │   │   │   ├── editor.ts           # 输入编辑器
│           │   │   │   ├── footer.ts           # 状态栏
│           │   │   │   ├── tool-block.ts       # 工具执行块
│           │   │   │   └── loader.ts           # 流式加载动画
│           │   │   ├── theme.ts                # 主题
│           │   │   └── keybindings.ts          # 快捷键
│           │   ├── print-mode.ts
│           │   └── rpc-mode.ts
│           └── config.ts           # 路径/版本等配置
```

---

## 7. 实现路线图

### Phase 1：最小可用 Agent（MVP）
>
> 目标：能在终端里跟 agent 对话，让它读写文件、执行 bash 命令

1. **ai-adapter**：实现 `@tanstack/ai` → `StreamFn` 适配（先用 OpenAI 一个 provider）
2. **agent-core**：实现 `Agent` + `AgentLoop` + `AgentTool` + `AgentEvent`
3. **tools**：实现 `read` + `bash` + `edit` + `write` 四个核心工具（`bash` 用 `Bun.spawn()`，文件 IO 用 `Bun.file()`/`Bun.write()`）
4. **agent-session**：实现 `AgentSession` + 基础 `SessionManager`（内存模式）
5. **cli**：实现 `PrintMode`（stdout 输出，无 TUI）；用 `bun run` 直接执行 TS 源码

### Phase 2：交互式 TUI
>
> 目标：有完整交互式终端界面

1. **cli/modes/interactive**：基于 `@opentui/core` 构建 TUI
   - 消息列表渲染
   - Markdown 渲染
   - 输入编辑器
   - 状态栏
   - 键盘快捷键
2. **agent-session**：实现 steering / follow-up 队列
3. **agent-session**：实现 system prompt 构建

### Phase 3：持久化与会话管理
>
> 目标：会话可以保存、恢复、分支

1. **storage**：实现 JSONL session 持久化（用 `Bun.file()` / `Bun.write()` 追加写入）
2. **storage**：可选——用 `bun:sqlite` 建立 session 元数据索引（快速 list/search）
3. **agent-session**：完善 `SessionManager`（create/open/continue/fork/list）
4. **agent-session**：实现 `SettingsManager`（分层配置，JSON 读写用 Bun.file）
5. **agent-session**：实现 Compaction（上下文压缩）

### Phase 4：扩展系统
>
> 目标：支持插件扩展

1. **agent-session/extensions**：实现 `ExtensionRunner` + `ExtensionContext`
2. **agent-session**：实现 `ResourceLoader`（extensions/skills/prompts）
3. **agent-session**：实现 Skills 系统
4. **tools**：补充 `grep` / `find` / `ls` 工具

### Phase 5：多 Provider + Auth
>
> 目标：支持多个 LLM provider，含 OAuth

1. **ai-adapter**：注册更多 provider adapter（Anthropic, Google, ...）
2. **ai-adapter/auth**：实现 API key 存储
3. **ai-adapter/auth**：实现 OAuth 流程
4. **ai-adapter/models**：实现 Model 目录管理

### Phase 6：高级功能
>
> 目标：功能对标 Pi

1. **cli/modes/rpc**：RPC 模式——用 `Bun.serve({ unix })` 起 Unix socket JSON-RPC 服务，事件流用 WebSocket 推送
2. **agent-session**：Auto-retry（可重试错误自动重试）
3. **agent-session**：Model cycling（Ctrl+P 切换 model）
4. **agent-session**：Thinking level 管理
5. **cli**：自动补全（slash commands + model names + file paths）
6. **cli**：HTML 导出
7. **agent-session**：Context files（AGENTS.md 等自动加载）
8. **打包发布**：用 `bun build --compile` 生成独立二进制

---

## 附录 A：关键设计决策

### A.1 为什么不完全用 @tanstack/ai 的内置 agent loop？

`@tanstack/ai` 的 `chat()` 有内置 agent loop（`stopWhen`/`maxSteps`/`onStepFinish`），但 Pi 的 loop 更强大：

| 能力 | @tanstack/ai 内置 loop | 自建 loop (Pi 风格) |
| ------ | ---------------------- | --------------------- |
| Steering（运行中注入消息） | ✗ | ✓ |
| Follow-up（停止后追加消息） | ✗ | ✓ |
| prepareNextTurn（每轮切换 model/context） | ✗ | ✓ |
| shouldStopAfterTurn（优雅停止） | ✗ | ✓ |
| 截断 tool call 处理 | ✗ | ✓ |
| 并行/顺序 tool 执行策略 | 部分 | ✓ |
| beforeToolCall/afterToolCall hooks | ✓ (middleware) | ✓ |
| 自定义消息类型 | ✗ | ✓ (AgentMessage) |
| 上下文转换 (transformContext) | ✗ | ✓ |

**建议**：用 `chat()` 的 `stopWhen: "toolCall"` 模式（单步模式），在外层自己实现 agent loop。这样 `@tanstack/ai` 只负责单次 LLM 调用 + tool schema 验证，循环控制权完全在自己手里。

### A.2 为什么用 AgentMessage 而不是直接用 @tanstack/ai 的消息类型？

- `@tanstack/ai` 的 `UIMessage`/`ModelMessage` 是固定的，无法添加自定义消息类型
- Pi 的 `AgentMessage` 通过 declaration merging 支持任意自定义消息（bash 执行记录、compaction 摘要、extension 自定义消息）
- `convertToLlm` 在 LLM 调用边界过滤自定义消息，只发送 LLM 能理解的格式
- 这使得 session 持久化和 UI 渲染能包含 LLM 不需要的信息

### A.3 @opentui/core 上需要构建的组件

`@opentui/core` 提供底层渲染能力，但以下组件需要自己实现：

| 组件 | 说明 |
| ------ | ------ |
| Markdown 渲染器 | 解析 markdown AST → renderable tree（代码块、标题、列表、链接等） |
| 消息列表 | 可滚动的历史消息区域，支持增量追加 |
| 输入编辑器 | 行编辑、光标移动、选择、多行、粘贴、撤销/重做 |
| 自动补全 | slash commands + model names + file paths 的补全 |
| 状态栏 | model、token 使用、cost、队列状态 |
| 流式加载动画 | agent 工作时的动画指示器 |
| 工具执行块 | 工具调用的折叠/展开显示 |
| 对话框/选择器 | 模型选择、确认对话框等 overlay |

### A.4 Schema 选择：Zod vs TypeBox

- Pi 用 TypeBox（`@sinclair/typebox`），因为它能同时提供 JSON Schema（发给 LLM）和 TypeScript 类型
- `@tanstack/ai` 用 Zod
- **建议**：统一用 Zod（与 `@tanstack/ai` 对齐），在 ai-adapter 中将 Zod schema 转换为 JSON Schema 发给 LLM（`zod-to-json-schema` 或 `@tanstack/ai` 内置的转换）

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

- `@tanstack/ai` 和 `@opentui/core` 是纯 JavaScript/TypeScript 包，与 Bun 完全兼容
- Bun 支持 Node.js API 兼容层，少量代码如果使用了 `node:fs`、`node:path` 等也能正常工作
- 建议新代码优先使用 Bun API，但不必强制重写已有的 Node.js 兼容代码
- `bun:sqlite` 的 API 与 `node:sqlite` 略有不同，但功能等价

---

## 附录 C：@tanstack/ai → agent-core 类型映射

| @tanstack/ai | agent-core | 说明 |
| ------------- | ----------- | ------ |
| `chat()` 返回的 `textStream` | `MessageEventStream` | 需要包装为细粒度事件 |
| `toolDefinition()` | `AgentTool` | schema + execute 对应 |
| `UIMessage` / `ModelMessage` | `LLMMessage` (内部用) | 在 convertToLlm 后对齐 |
| adapter (`openaiText()`) | `ModelConfig` | provider + modelId 映射 |
| `middleware.beforeToolCall` | `beforeToolCall` hook | 概念对应 |
| `middleware.afterToolCall` | `afterToolCall` hook | 概念对应 |
| `middleware.onStepFinish` | `turn_end` event | 概念对应 |
| `stopWhen` / `maxSteps` | 不使用（自建 loop） | 用 `stopWhen: "toolCall"` 单步 |
| `systemPrompts` | `AgentContext.systemPrompt` | 直接对应 |
| `steps` (返回值) | `turn_end` × N | 自建 loop 自己跟踪 |
| `usage` (返回值) | `AssistantMessage.usage` | 从 done 事件提取 |

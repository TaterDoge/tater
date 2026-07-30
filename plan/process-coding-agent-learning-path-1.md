---
goal: 通过 24 个递进任务学习并实现一个完整的 Coding Agent
version: 1.0
date_created: 2026-03-12
last_updated: 2026-03-12
owner: tater-agent
status: Planned
tags:
  - learning
  - coding-agent
  - bun
  - vercel-ai-sdk
  - opentui
---

# Coding Agent 学习与实现路径

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

本文档把 [`agent-architecture-design.md`](../agent-architecture-design.md) 中的目标架构拆分为 24 个可依次学习、实现和验证的任务。每个任务只引入一个主要概念，并留下可运行的结果。

这是一份学习施工单，不是第二份架构设计。实施时始终遵守：

```text
理解概念 → 阅读调用链 → 做最小实现 → 运行验证 → 回顾代码 → 完成小练习 → 进入下一任务
```

## 1. 使用方法

### 1.1 执行规则

1. 严格按照 Task 编号顺序实施。
2. 一次只实施一个 Task，不提前创建后续抽象。
3. 每个 Task 开始前，先阅读“学习目标”和“调用链”。
4. 每个 Task 至少运行一个成功场景和一个失败场景。
5. 只有满足全部“完成标准”后，才勾选任务并进入下一项。
6. 每完成一个阶段，创建一次可运行的 Git 提交。
7. 如果真实实现与架构文档冲突，优先保留已经验证的简单实现，并更新架构文档。

### 1.2 每个 Task 的学习流程

```text
1. 概念讲解：这个能力解决什么问题
2. 调用链：数据从哪里来，到哪里去
3. 实现预测：修改前先预测程序行为
4. 最小编码：只修改列出的必要文件
5. 运行验证：成功、失败各一个场景
6. 代码回顾：解释新增 API 和边界
7. 小练习：独立完成一个小改动
8. 完成检查：逐项核对完成标准
```

### 1.3 阶段门禁

| 阶段 | 可交付结果 | 进入下一阶段的门禁 |
| --- | --- | --- |
| 阶段一 | 能流式回答并读取文件的最小 Agent | 模型可连续调用 `read` 并生成最终回答 |
| 阶段二 | 能修改并运行代码的最小 Coding Agent | `read/write/edit/bash` 完成闭环 |
| 阶段三 | 可恢复的多轮会话 | 重启后可继续最近 Session |
| 阶段四 | 可中断、可插话、可排队的运行时 | Abort、Steering、Follow-up 语义通过验证 |
| 阶段五 | 可交互使用的终端应用 | REPL 和最小 OpenTUI 均可工作 |
| 阶段六 | 按真实需求扩展的完整 Agent | 高级能力逐项通过独立验证 |

## 2. 要求与约束

- **REQ-001**: 最终项目必须形成从 CLI 输入、LLM 推理、Tool Call、Tool Result 到最终回答的完整闭环。
- **REQ-002**: 学习路径必须让每个 Task 都产生可运行、可观察、可验证的结果。
- **REQ-003**: 使用 Bun 作为运行时和包管理器。
- **REQ-004**: 使用 Vercel AI SDK 提供模型调用和内层 Tool Loop，不重复实现第二套 Tool Loop。
- **REQ-005**: 使用 `@opentui/core` 构建最终交互式 TUI，但必须在普通 PrintMode 和 REPL 稳定后再引入。
- **REQ-006**: 内部 `AgentMessage` 与模型边界 `ModelMessage` 保持分离。
- **SEC-001**: 文件工具必须限制在允许的工作目录内，防止路径穿越。
- **SEC-002**: `bash` 必须支持超时、中断、退出码和 stderr，不得静默吞错。
- **SEC-003**: 修改真实项目之前必须具备 Tool Approval 或等价的明确授权边界。
- **CON-001**: 当前仓库主要是包结构和注释骨架，实施从最小纵向切片开始，不按包逐个填满。
- **CON-002**: 第一版只支持一个 Provider，不提前实现 OAuth、Provider catalog 或 model cycling。
- **CON-003**: JSONL 能满足需求前不引入 SQLite Session 索引。
- **GUD-001**: 每次只增加当前 Task 必需的类型、事件和配置。
- **GUD-002**: 优先使用 Bun API、标准库和已安装依赖。
- **GUD-003**: 非平凡逻辑至少保留一个最小自动化测试。
- **PAT-001**: 采用“纵向切片”模式，让每个阶段从入口一直贯通到可观察输出。

## 3. 当前状态

仓库已经具备 monorepo 目录和依赖声明，但核心源码基本仍是注释骨架：

```text
packages/ai-adapter   Provider 与 Model 边界
packages/agent-core   Agent Runtime 与事件
packages/agent-session Session、持久化、上下文
packages/tools        Coding Tools
packages/storage      JSONL 与可选 SQLite
packages/tui          CLI、PrintMode、OpenTUI、RPC
```

当前最重要的不是继续增加空文件，而是先贯通下面这条最短调用链：

```text
CLI 参数 → resolveModel() → 模型流 → stdout
```

## 4. 实施步骤

### 阶段一：最小 Agent

- **GOAL-001**: 理解模型调用、Tool 定义和 Tool Loop，并得到能读取项目文件的最小 Agent。

#### Task 01：普通 LLM 流式 CLI

**学习目标**

- 理解 `LanguageModel`、Provider、Model ID 和 API key 的关系。
- 理解一次普通 LLM 调用与 Coding Agent 的区别。
- 学习 AI SDK 流式输出的消费方式。

**调用链**

```text
命令行文本
  → packages/tui/src/main.ts
  → packages/ai-adapter/src/model-runtime.ts
  → AI SDK 模型调用
  → text stream
  → stdout
```

**实施范围**

- `packages/ai-adapter/src/model-runtime.ts`
- `packages/ai-adapter/src/index.ts`
- `packages/tui/src/main.ts`
- `packages/tui/src/modes/print-mode.ts`
- 对应包的 `package.json`

**实现清单**

- [ ] 实现 OpenAI `LanguageModel` 解析。
- [ ] 从 CLI 参数读取用户消息。
- [ ] 将模型增量文本写入 stdout。
- [ ] API key 缺失时输出明确错误并返回非零退出码。
- [ ] 暂不加入 Tool、Session、TUI、OAuth。

**验证命令**

```bash
OPENAI_API_KEY=... bun run dev "用一句话解释什么是 coding agent"
```

**失败场景**

```bash
env -u OPENAI_API_KEY bun run dev "hello"
```

**完成标准**

- 模型回答可以增量显示。
- 流结束后进程正常退出。
- 缺少凭据时不会出现难以理解的堆栈输出。
- `bun run typecheck` 通过。

**小练习**

让 CLI 在没有输入文本时打印一行 usage，并返回非零退出码。

---

#### Task 02：第一个只读 Tool

**学习目标**

- 理解 AI SDK `tool()` 的 description、input schema 和 execute。
- 理解 Tool Call 与普通文本生成的区别。
- 理解 Zod 如何验证模型生成的参数。

**调用链**

```text
用户请求
  → 模型判断需要 read
  → read input schema 校验
  → Bun.file(path).text()
  → Tool Result
  → 模型最终回答
```

**实施范围**

- `packages/tools/src/read.ts`
- `packages/tools/src/index.ts`
- `packages/tools/src/read.test.ts`
- `packages/agent-core/src/agent.ts`

**实现清单**

- [ ] 用 AI SDK `tool()` 定义 `read`。
- [ ] 参数包含 `path`、可选 `offset` 和可选 `limit`。
- [ ] 相对路径基于 Agent 的 `cwd` 解析。
- [ ] 拒绝读取 `cwd` 之外的文件。
- [ ] 文件不存在时返回可理解的错误。
- [ ] 添加最小路径边界测试。

**验证请求**

```text
读取 package.json，并告诉我项目名称。
```

**失败场景**

```text
读取 ../../../../etc/passwd。
```

**完成标准**

- 模型能够调用 `read` 并依据内容回答。
- 路径穿越被拒绝。
- offset 和 limit 使用统一的行号约定并有测试。
- `bun test packages/tools/src/read.test.ts` 通过。

**小练习**

为读取结果补充总行数信息，但不改变返回正文。

---

#### Task 03：最小 Tool Loop

**学习目标**

- 理解 Step、Tool Call、Tool Result 和最终回答之间的循环。
- 理解 `ToolLoopAgent` 和 `stopWhen`。
- 理解为什么不应自行复制 AI SDK 的内层循环。

**调用链**

```text
prompt
  → ToolLoopAgent Step 1
  → read Tool Result
  → ToolLoopAgent Step 2
  → 可选的第二次 read
  → 最终 assistant 文本
```

**实施范围**

- `packages/agent-core/src/agent.ts`
- `packages/agent-core/src/index.ts`
- `packages/tui/src/modes/print-mode.ts`

**实现清单**

- [ ] 创建包含 `read` 的 `ToolLoopAgent`。
- [ ] 使用固定的最大 Step 数作为安全上限。
- [ ] 在 stderr 显示 Tool 开始和结束信息。
- [ ] Tool 错误必须返回模型，而不是静默结束进程。
- [ ] 暂不建立完整 `AgentEvent` 类型。

**验证请求**

```text
先读取 package.json，再读取 packages/agent-core/package.json，比较两个包的名称。
```

**完成标准**

- 一次请求可以连续执行多个 Step。
- Tool Loop 最终可以自然停止。
- 达到 Step 上限时不会无限运行。
- Tool 异常可被模型解释给用户。

**小练习**

调整最大 Step 数，观察限制过小对两次文件读取任务的影响并记录原因。

---

### 阶段二：最小 Coding Agent

- **GOAL-002**: 建立读、写、改、执行的编码闭环，并用稳定应用事件隔离 AI SDK。

#### Task 04：实现 write 和 edit

**学习目标**

- 理解完整覆盖与精确替换的不同风险。
- 理解写操作的路径边界和冲突语义。
- 学习如何用临时目录测试文件修改。

**实施范围**

- `packages/tools/src/write.ts`
- `packages/tools/src/edit.ts`
- `packages/tools/src/index.ts`
- `packages/tools/src/write.test.ts`
- `packages/tools/src/edit.test.ts`

**实现清单**

- [ ] `write` 支持创建和完整覆盖文件。
- [ ] `edit` 接收 `path`、`oldText` 和 `newText`。
- [ ] `edit` 仅在 `oldText` 唯一匹配时修改文件。
- [ ] 零匹配和多匹配都拒绝写入。
- [ ] 两个工具都限制在 `cwd` 内。
- [ ] 使用临时目录完成测试。
- [ ] 在真实冲突出现前不实现 mutation queue。

**验证请求**

```text
在临时目录创建 hello.ts，让它输出 hello；然后把输出改成 hello tater，并重新读取验证。
```

**完成标准**

- 文件创建、精确编辑和重新读取形成闭环。
- edit 失败时原文件保持不变。
- 路径穿越被拒绝。
- 两个测试文件通过。

**小练习**

为 `write` 的成功结果补充写入字节数。

---

#### Task 05：实现 bash

**学习目标**

- 理解子进程、stdout、stderr 和 exit code。
- 理解 AbortSignal 与超时控制。
- 理解 shell Tool 的能力和风险。

**实施范围**

- `packages/tools/src/bash.ts`
- `packages/tools/src/truncate.ts`
- `packages/tools/src/bash.test.ts`
- `packages/tools/src/index.ts`

**实现清单**

- [ ] 使用 `Bun.spawn()` 执行命令。
- [ ] 固定使用 Agent 的 `cwd`。
- [ ] 分别捕获 stdout 和 stderr。
- [ ] 返回 exit code。
- [ ] 支持超时和 AbortSignal。
- [ ] 对过长输出执行尾部截断并明确标记。
- [ ] 暂不构建复杂 sandbox。

**验证请求**

```text
创建 hello.ts，运行它，并告诉我终端输出。
```

**失败场景**

```text
运行一个返回非零退出码的命令，并解释错误。
```

**完成标准**

- 成功命令、失败命令和超时命令都有正确结果。
- stderr 不会被吞掉。
- 中断后不残留子进程。
- `bash.test.ts` 通过。

**小练习**

运行一个同时写 stdout 和 stderr 的命令，确认两部分都可见。

---

#### Task 06：定义最小 AgentEvent

**学习目标**

- 理解 SDK 原始 stream part 与应用事件的区别。
- 理解为什么 PrintMode、TUI 和存储层不应直接依赖 SDK 事件。
- 学习事件订阅和取消订阅。

**实施范围**

- `packages/agent-core/src/types.ts`
- `packages/agent-core/src/agent.ts`
- `packages/tui/src/modes/print-mode.ts`
- `packages/agent-core/src/agent.test.ts`

**第一版事件**

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_end"; toolCallId: string; output: unknown; isError: boolean }
  | { type: "agent_end" }
  | { type: "error"; error: Error };
```

**实现清单**

- [ ] 将 AI SDK stream 映射为上述最小事件集。
- [ ] 提供 `subscribe()` 并返回取消订阅函数。
- [ ] PrintMode 只消费 `AgentEvent`。
- [ ] 暂不添加没有消费者的生命周期事件。

**完成标准**

- PrintMode 不导入 AI SDK stream part 类型。
- 文本和 Tool 生命周期均可通过事件观察。
- 取消订阅后 listener 不再收到事件。
- AgentEvent 顺序测试通过。

**小练习**

增加一个只记录 Tool 耗时的临时订阅者，不修改 Agent 核心。

---

### 阶段三：会话与上下文

- **GOAL-003**: 支持多轮对话、重启恢复和项目级 System Prompt。

#### Task 07：内存 Session 与消息边界

**学习目标**

- 理解 Agent Runtime 与 Session 的职责区别。
- 理解 `AgentMessage` 为什么不等于 `ModelMessage`。
- 理解多轮对话历史如何进入模型。

**实施范围**

- `packages/agent-core/src/types.ts`
- `packages/agent-session/src/agent-session.ts`
- `packages/agent-session/src/messages.ts`
- `packages/agent-session/src/agent-session.test.ts`

**实现清单**

- [ ] 定义最小 `AgentMessage` 联合类型。
- [ ] 实现 `convertToModelMessages()`。
- [ ] 实现 `AgentSession.prompt()`。
- [ ] 将 user、assistant 和 tool result 保存在内存中。
- [ ] 暂不持久化到磁盘。

**验证对话**

```text
用户：记住变量名是 potato。
用户：刚才的变量名是什么？
```

**完成标准**

- 第二轮请求包含第一轮上下文。
- 自定义 Session 消息不会直接进入模型。
- 转换函数具有最小单元测试。

**小练习**

增加一个只在本地显示、不会发给模型的 notification 消息。

---

#### Task 08：JSONL Session 持久化

**学习目标**

- 理解 append-only 日志、重放和恢复。
- 理解 Session Header 与 Message Entry。
- 理解持久化格式为何应独立于 AI SDK 类型。

**实施范围**

- `packages/storage/src/jsonl.ts`
- `packages/agent-session/src/session-manager.ts`
- `packages/agent-session/src/session-manager.test.ts`
- `packages/agent-session/src/agent-session.ts`

**第一版能力**

```text
create → appendMessage → open → continueRecent
```

**实现清单**

- [ ] 第一行写入 Session Header。
- [ ] 后续消息按行追加。
- [ ] 从 JSONL 重建消息历史。
- [ ] 按更新时间找到当前 cwd 最近的 Session。
- [ ] 损坏行报告文件路径和行号。
- [ ] 暂不实现 fork、branch、search 和 SQLite。

**完成标准**

- 退出进程后能恢复最近会话。
- 新消息只追加，不覆盖旧记录。
- 损坏 JSONL 的测试通过。
- 恢复后多轮上下文仍然有效。

**小练习**

实现一个只读命令，打印当前 Session ID 和文件路径。

---

#### Task 09：System Prompt 与根目录上下文

**学习目标**

- 理解 System Prompt、User Message 和 Tool Description 的职责。
- 理解 coding agent 为什么需要 cwd 和项目指令。
- 理解上下文文件的最小加载边界。

**实施范围**

- `packages/agent-session/src/system-prompt.ts`
- `packages/agent-session/src/resource-loader.ts`
- `packages/agent-session/src/system-prompt.test.ts`
- `packages/agent-session/src/agent-session.ts`

**实现清单**

- [ ] 默认 Prompt 说明 Agent 身份和 cwd。
- [ ] Prompt 列出当前启用的工具。
- [ ] 只加载仓库根目录 `AGENTS.md`。
- [ ] `AGENTS.md` 不存在时正常运行。
- [ ] 暂不递归发现嵌套指令文件。

**完成标准**

- Agent 能说明当前 cwd。
- Agent 能遵循根目录 `AGENTS.md` 的明确指令。
- 未启用的工具不会出现在 Prompt 中。
- Prompt 构建测试通过。

**小练习**

临时禁用 `bash`，验证 System Prompt 和实际工具集合保持一致。

---

### 阶段四：运行时控制

- **GOAL-004**: 让正在运行的 Agent 可中断、可插话，并能在自然结束后继续处理排队消息。

#### Task 10：Abort

**学习目标**

- 理解 `AbortController` 如何贯穿模型请求和 Tool 执行。
- 理解中断后的状态恢复。
- 理解取消与错误的区别。

**实施范围**

- `packages/agent-core/src/agent.ts`
- `packages/agent-session/src/agent-session.ts`
- `packages/tools/src/bash.ts`
- `packages/agent-core/src/abort.test.ts`

**实现清单**

- [ ] 每次 Agent 运行创建独立 AbortController。
- [ ] `AgentSession.abort()` 中断当前运行。
- [ ] signal 传递给模型和 Tool。
- [ ] bash 子进程收到中断后退出。
- [ ] 中断后 Session 回到 idle。

**完成标准**

- 长模型响应可被中断。
- 长命令可被中断且不残留进程。
- 中断后可以立即发起下一次 Prompt。
- Abort 测试通过。

**小练习**

在 PrintMode 中将一次 Ctrl+C 绑定为中断，空闲时再次 Ctrl+C 才退出。

---

#### Task 11：Steering

**学习目标**

- 理解 Steering 与普通 Prompt 的语义差异。
- 理解 `prepareStep` 的注入时机。
- 理解为什么已开始的 Tool 不应被跳过。

**实施范围**

- `packages/agent-core/src/agent.ts`
- `packages/agent-core/src/queues.ts`
- `packages/agent-session/src/agent-session.ts`
- `packages/agent-core/src/steering.test.ts`

**实现清单**

- [ ] 创建 Steering FIFO 队列。
- [ ] `AgentSession.steer()` 只在 Agent 运行中接收消息。
- [ ] 在下一次 `prepareStep` 注入队列内容。
- [ ] 不取消已经开始的 Tool Call。
- [ ] 发送队列更新事件。

**完成标准**

- Steering 在下一个 Step 生效。
- 已开始 Tool 正常结束。
- 多条 Steering 保持 FIFO 顺序。
- 空闲时调用 Steering 有清晰行为。

**小练习**

分别发送两条 Steering，观察合并注入和逐条注入的差异；第一版只保留更简单的一种。

---

#### Task 12：Follow-up

**学习目标**

- 理解内层 Tool Loop 与外层 Session 循环。
- 理解 Follow-up 为什么在 Agent 自然结束后处理。
- 理解 idle、running 和 settled 状态。

**实施范围**

- `packages/agent-core/src/queues.ts`
- `packages/agent-session/src/agent-session.ts`
- `packages/agent-session/src/follow-up.test.ts`

**实现清单**

- [ ] 创建 Follow-up FIFO 队列。
- [ ] 当前 Agent 自然结束后读取队列。
- [ ] 有消息时再次调用同一个 Agent Runtime。
- [ ] 队列为空时发出 settled 事件。
- [ ] 不实现第二套 Tool 执行循环。

**完成标准**

- Follow-up 不进入当前 Step。
- 当前运行结束后自动处理排队消息。
- 多条消息顺序稳定。
- 所有消息完成后只进入一次 settled。

**小练习**

记录 `agent_end` 和 `settled` 的次数，解释它们为何不同。

---

### 阶段五：交互式终端

- **GOAL-005**: 先构建普通 REPL，再用 OpenTUI 替换显示层，避免同时调试 Agent 和复杂 UI。

#### Task 13：普通终端 REPL

**学习目标**

- 理解持续输入循环与一次性 PrintMode 的区别。
- 理解终端信号和 Session 生命周期。
- 验证 Agent 核心不依赖 OpenTUI。

**实施范围**

- `packages/tui/src/main.ts`
- `packages/tui/src/modes/repl-mode.ts`
- `packages/tui/src/tui/args.ts`

**实现清单**

- [ ] 空参数启动时进入 REPL。
- [ ] 每次输入调用同一 `AgentSession.prompt()`。
- [ ] 支持 `/exit`。
- [ ] 支持恢复最近 Session。
- [ ] 一次 Ctrl+C 中断运行，空闲时退出。

**完成标准**

- 可以连续完成多轮对话。
- Tool 输出与用户输入不会混淆。
- 重启后可以恢复上下文。
- REPL 不导入 `@opentui/core`。

**小练习**

增加 `/session` 命令，显示 Session ID，不建立通用命令框架。

---

#### Task 14：最小 OpenTUI

**学习目标**

- 理解 OpenTUI renderer、Renderable 和键盘事件。
- 理解事件驱动 UI 如何消费 AgentSession。
- 理解流式内容与输入状态的并发更新。

**实施范围**

- `packages/tui/src/modes/interactive/interactive-mode.ts`
- `packages/tui/src/modes/interactive/components/message-list.ts`
- `packages/tui/src/modes/interactive/components/editor.ts`
- `packages/tui/src/modes/interactive/components/footer.ts`
- `packages/tui/src/modes/interactive/keybindings.ts`

**第一版布局**

```text
┌──────────────────────────────┐
│ 消息区域                     │
├──────────────────────────────┤
│ 输入框                       │
├──────────────────────────────┤
│ model · status · tokens      │
└──────────────────────────────┘
```

**实现清单**

- [ ] 渲染消息列表、输入框和状态栏。
- [ ] assistant 文本可以增量更新。
- [ ] Tool 开始和结束状态可见。
- [ ] Enter 提交，Ctrl+C 中断或退出。
- [ ] 终端 resize 后重新布局。
- [ ] 暂不实现完整 Markdown、自动补全、主题和鼠标。

**完成标准**

- 输入不会阻塞 assistant 流式更新。
- 消息不会因重渲染重复。
- Tool 状态与实际事件一致。
- resize 后界面不崩溃。

**小练习**

在 Footer 中显示 running、idle 和 aborted 三种状态。

---

### 阶段六：按需求完善

- **GOAL-006**: 在核心闭环已经稳定后，按真实瓶颈依次增加上下文、扩展、Provider 和集成能力。

#### Task 15：统一输出截断

**学习目标**

- 理解 Tool 输出如何占用上下文。
- 区分头部截断、尾部截断和元数据。

**实施范围**

- `packages/tools/src/truncate.ts`
- `packages/tools/src/read.ts`
- `packages/tools/src/bash.ts`
- `packages/tools/src/truncate.test.ts`

**完成标准**

- read 和 bash 使用同一截断函数。
- 截断结果明确说明原始大小和保留范围。
- 错误日志优先保留尾部。
- 边界测试通过。

**小练习**

比较保留头部和保留尾部对编译错误诊断的影响。

---

#### Task 16：Compaction

**学习目标**

- 理解 context window、token estimate 和 turn 边界。
- 理解摘要消息与原始 Session 日志的关系。

**实施范围**

- `packages/agent-session/src/compaction/compaction.ts`
- `packages/agent-session/src/compaction/utils.ts`
- `packages/agent-session/src/compaction/compaction.test.ts`
- `packages/agent-session/src/session-manager.ts`

**完成标准**

- 仅在达到阈值时触发。
- 截断点位于完整 turn 边界。
- 保留最近若干 turn。
- 摘要作为独立 Session Entry 持久化。
- Compaction 失败不损坏原始 Session。

**小练习**

用固定消息数据比较压缩前后的模型消息数量。

---

#### Task 17：补充 grep、find 和 ls

**学习目标**

- 理解专用 Tool 与通过 bash 执行命令的权衡。
- 学习结构化参数和稳定输出格式。

**实施范围**

- `packages/tools/src/grep.ts`
- `packages/tools/src/find.ts`
- `packages/tools/src/ls.ts`
- 对应最小测试文件

**完成标准**

- 三个工具都限制在 cwd。
- 输出使用 Task 15 的截断能力。
- 不复制 read 的路径校验逻辑。
- 只有在它们明显改善 Agent 行为后保留。

**小练习**

让 Agent 用专用 Tool 和 bash 各完成一次文件搜索，比较调用参数和结果稳定性。

---

#### Task 18：SettingsManager

**学习目标**

- 理解 global、project 和 CLI 配置优先级。
- 理解配置缺省值和显式覆盖。

**实施范围**

- `packages/agent-session/src/settings-manager.ts`
- `packages/agent-session/src/settings-manager.test.ts`
- `packages/tui/src/config.ts`
- `packages/tui/src/tui/args.ts`

**优先级**

```text
CLI > .tater/settings.json > ~/.tater/settings.json > 代码默认值
```

**完成标准**

- 优先级测试通过。
- 无配置文件时正常启动。
- 第一版只保存实际已有的配置项。
- 不创建通用 schema 框架。

**小练习**

为最大 Step 数增加 project 配置和 CLI 覆盖。

---

#### Task 19：多 Provider

**学习目标**

- 理解 AI SDK 统一模型接口。
- 理解 Provider 特有配置应该停留在哪一层。

**实施范围**

- `packages/ai-adapter/src/adapters/registry.ts`
- `packages/ai-adapter/src/adapters/openai.ts`
- `packages/ai-adapter/src/adapters/anthropic.ts`
- `packages/ai-adapter/src/model-runtime.ts`
- `packages/agent-session/src/model-resolver.ts`

**完成标准**

- OpenAI 和 Anthropic 通过同一 `ModelConfig` 解析。
- Provider 凭据缺失时错误清晰。
- Agent Core 不导入具体 Provider 包。
- 暂不实现 OAuth。

**小练习**

用同一只读文件任务分别调用两个 Provider，比较 Tool Call 表现。

---

#### Task 20：Tool Approval

**学习目标**

- 理解只读 Tool 和修改型 Tool 的风险等级。
- 理解审批与授权边界，而不是只做确认弹窗。

**实施范围**

- `packages/agent-core/src/agent.ts`
- `packages/agent-session/src/agent-session.ts`
- `packages/tui/src/modes/interactive/interactive-mode.ts`
- `packages/agent-core/src/tool-approval.test.ts`

**完成标准**

- read、grep、find、ls 默认无需审批。
- write、edit、bash 在策略要求时进入审批。
- 拒绝后 Tool 不执行，并向模型返回明确结果。
- PrintMode 对无法交互审批的情况有确定行为。

**小练习**

配置一次只允许 read 的会话，验证模型不能绕过 Tool 集合调用 bash。

---

#### Task 21：最小 Extension 系统

**学习目标**

- 理解 Extension 的真实扩展点和生命周期。
- 理解何时需要插件，何时普通函数已经足够。

**实施范围**

- `packages/agent-session/src/extensions/types.ts`
- `packages/agent-session/src/extensions/loader.ts`
- `packages/agent-session/src/extensions/runner.ts`
- `packages/agent-session/src/extensions/runner.test.ts`

**第一版只支持**

```text
注册 Tool + 订阅 AgentEvent
```

**完成标准**

- 能加载一个本地 Extension。
- Extension 可以注册一个 Tool。
- Extension 可以订阅并取消订阅事件。
- 不实现 commands、keyboard、CLI flags 等未验证扩展点。

**小练习**

实现一个记录 Tool 名称的本地 Extension。

---

#### Task 22：Skills 与 Prompt Commands

**学习目标**

- 理解 Skill 是按需注入的指导文本，不是 Tool。
- 理解 slash command 的输入转换职责。

**实施范围**

- `packages/agent-session/src/skills.ts`
- `packages/agent-session/src/resource-loader.ts`
- `packages/agent-session/src/system-prompt.ts`
- `packages/agent-session/src/skills.test.ts`

**完成标准**

- 可从固定目录发现 Skill。
- 仅选中的 Skill 内容进入上下文。
- 缺失或损坏 Skill 有明确错误。
- 不加载全部 Skill 到每次请求。

**小练习**

创建一个只指导 Agent 总结 TypeScript 文件的最小 Skill，并验证按需加载。

---

#### Task 23：RPC 模式

**学习目标**

- 理解同一个 AgentSession 如何服务不同前端。
- 理解请求响应和事件流的区别。

**实施范围**

- `packages/tui/src/modes/rpc-mode.ts`
- `packages/tui/src/modes/rpc-mode/rpc-handler.ts`
- `packages/tui/src/modes/rpc-mode.test.ts`

**第一版协议**

```text
prompt
abort
getState
subscribe events
```

**完成标准**

- RPC 与 TUI 共享同一个 AgentSession API。
- 方法参数经过 schema 校验。
- 事件流保持顺序。
- 客户端断开不会结束 AgentSession。
- 暂不实现复杂 Supervisor。

**小练习**

写一个最小脚本，通过 RPC 发送 Prompt 并打印 text delta。

---

#### Task 24：Auth、模型目录与发布

**学习目标**

- 理解环境变量、本地凭据和 OAuth 的适用条件。
- 理解 Model catalog 是元数据，不应控制 Agent Loop。
- 理解 Bun 独立二进制的构建边界。

**实施范围**

- `packages/ai-adapter/src/auth/credential-store.ts`
- `packages/ai-adapter/src/models/catalog.ts`
- `packages/ai-adapter/src/models/store.ts`
- `packages/tui/src/config.ts`
- 根目录 `package.json`

**实现清单**

- [ ] 先支持环境变量和本地凭据文件。
- [ ] 仅在目标 Provider 明确需要时加入对应 OAuth 流程。
- [ ] Model catalog 保存 provider、modelId、contextWindow 等元数据。
- [ ] 使用 `bun build --compile` 生成独立二进制。
- [ ] 对凭据文件设置最小文件权限。

**完成标准**

- 二进制可在干净终端中启动。
- 凭据不会写入 Session、日志或错误输出。
- 模型选择不会泄漏到 Agent Core 的 Provider 实现细节。
- 核心 smoke test 通过。

**小练习**

在不保存 key 的情况下，仅通过环境变量运行编译后的二进制。

---

## 5. 总任务追踪表

| Task | 名称 | 依赖 | 状态 | 完成日期 |
| --- | --- | --- | --- | --- |
| TASK-001 | 普通 LLM 流式 CLI | 无 | ⬜ | |
| TASK-002 | 第一个只读 Tool | 依赖 TASK-001 | ⬜ | |
| TASK-003 | 最小 Tool Loop | 依赖 TASK-002 | ⬜ | |
| TASK-004 | write 和 edit | 依赖 TASK-003 | ⬜ | |
| TASK-005 | bash | 依赖 TASK-004 | ⬜ | |
| TASK-006 | 最小 AgentEvent | 依赖 TASK-005 | ⬜ | |
| TASK-007 | 内存 Session 与消息边界 | 依赖 TASK-006 | ⬜ | |
| TASK-008 | JSONL Session 持久化 | 依赖 TASK-007 | ⬜ | |
| TASK-009 | System Prompt 与根目录上下文 | 依赖 TASK-008 | ⬜ | |
| TASK-010 | Abort | 依赖 TASK-009 | ⬜ | |
| TASK-011 | Steering | 依赖 TASK-010 | ⬜ | |
| TASK-012 | Follow-up | 依赖 TASK-011 | ⬜ | |
| TASK-013 | 普通终端 REPL | 依赖 TASK-012 | ⬜ | |
| TASK-014 | 最小 OpenTUI | 依赖 TASK-013 | ⬜ | |
| TASK-015 | 统一输出截断 | 依赖 TASK-014 | ⬜ | |
| TASK-016 | Compaction | 依赖 TASK-015 | ⬜ | |
| TASK-017 | grep、find 和 ls | 依赖 TASK-015 | ⬜ | |
| TASK-018 | SettingsManager | 依赖 TASK-016 | ⬜ | |
| TASK-019 | 多 Provider | 依赖 TASK-018 | ⬜ | |
| TASK-020 | Tool Approval | 依赖 TASK-019 | ⬜ | |
| TASK-021 | 最小 Extension 系统 | 依赖 TASK-020 | ⬜ | |
| TASK-022 | Skills 与 Prompt Commands | 依赖 TASK-021 | ⬜ | |
| TASK-023 | RPC 模式 | 依赖 TASK-022 | ⬜ | |
| TASK-024 | Auth、模型目录与发布 | 依赖 TASK-023 | ⬜ | |

## 6. 架构能力映射

| 架构能力 | 对应 Task |
| --- | --- |
| AI SDK / LanguageModel | `TASK-001`、`TASK-019` |
| Tool 定义 | `TASK-002`、`TASK-004`、`TASK-005`、`TASK-017` |
| Tool Loop | `TASK-003` |
| AgentEvent | `TASK-006` |
| AgentMessage 边界 | `TASK-007` |
| Session 持久化 | `TASK-008` |
| System Prompt / Context | `TASK-009` |
| Abort | `TASK-010` |
| Steering | `TASK-011` |
| Follow-up | `TASK-012` |
| PrintMode / REPL | `TASK-001`、`TASK-013` |
| OpenTUI | `TASK-014` |
| 输出截断 | `TASK-015` |
| Compaction | `TASK-016` |
| Settings | `TASK-018` |
| Tool Approval | `TASK-020` |
| Extensions | `TASK-021` |
| Skills / Commands | `TASK-022` |
| RPC | `TASK-023` |
| Auth / Model catalog | `TASK-024` |

## 7. 替代方案

- **ALT-001**: 按 package 横向实现完整模块。未采用，因为长时间无法形成可运行闭环，也不利于逐步学习。
- **ALT-002**: 一开始完整复刻 Pi。未采用，因为会重复 AI SDK 已提供的 Tool Loop，并引入大量尚未验证的抽象。
- **ALT-003**: 一开始构建完整 OpenTUI。未采用，因为 Agent 和 UI 同时调试会掩盖核心运行时问题。
- **ALT-004**: 一开始引入 SQLite。未采用，因为 JSONL 足以支持学习阶段的持久化和恢复。

## 8. 依赖

- **DEP-001**: Bun 运行时与包管理器。
- **DEP-002**: `ai`，用于模型流和 `ToolLoopAgent`。
- **DEP-003**: `@ai-sdk/openai`，第一阶段唯一 Provider。
- **DEP-004**: `zod`，用于 Tool 和 RPC 参数校验。
- **DEP-005**: `@opentui/core`，仅从 TASK-014 开始使用。
- **DEP-006**: `@ai-sdk/anthropic`，仅从 TASK-019 开始使用。

## 9. 关键文件

- **FILE-001**: `agent-architecture-design.md`，最终能力地图与架构边界参考。
- **FILE-002**: `packages/tui/src/main.ts`，CLI 入口和运行模式分发。
- **FILE-003**: `packages/ai-adapter/src/model-runtime.ts`，模型解析边界。
- **FILE-004**: `packages/agent-core/src/agent.ts`，ToolLoopAgent 薄封装和运行时控制。
- **FILE-005**: `packages/agent-core/src/types.ts`，AgentMessage 和 AgentEvent。
- **FILE-006**: `packages/agent-session/src/agent-session.ts`，共享会话核心。
- **FILE-007**: `packages/agent-session/src/session-manager.ts`，Session JSONL 重放与恢复。
- **FILE-008**: `packages/tools/src/index.ts`，内置工具注册入口。
- **FILE-009**: `packages/tui/src/modes/print-mode.ts`，最早可验证的输出界面。
- **FILE-010**: `packages/tui/src/modes/interactive/interactive-mode.ts`，最终交互式终端界面。

## 10. 测试计划

- **TEST-001**: 每个 Task 的目标测试必须单独通过。
- **TEST-002**: 每阶段结束运行 `bun test`。
- **TEST-003**: 每阶段结束运行 `bun run typecheck`。
- **TEST-004**: 每阶段结束运行 `bun run lint`。
- **TEST-005**: 阶段一 smoke test：模型连续读取两个文件并回答。
- **TEST-006**: 阶段二 smoke test：创建、修改、执行并重新读取临时代码文件。
- **TEST-007**: 阶段三 smoke test：退出并恢复 Session 后继续多轮对话。
- **TEST-008**: 阶段四 smoke test：中断长命令后继续 Prompt，并验证 Steering 和 Follow-up 顺序。
- **TEST-009**: 阶段五 smoke test：OpenTUI 中完成一次包含 Tool Call 的交互。
- **TEST-010**: 阶段六 smoke test：编译独立二进制并完成只读 Coding Agent 请求。

## 11. 风险与假设

- **RISK-001**: AI SDK 版本 API 与架构文档示例可能存在差异；每个 Task 开始前应以当前安装版本类型定义为准。
- **RISK-002**: 过早扩展事件和消息类型会形成第二套复杂协议；只添加当前消费者需要的字段。
- **RISK-003**: bash、write 和 edit 具有真实破坏能力；测试必须使用临时目录，并在进入真实项目操作前完成审批能力。
- **RISK-004**: OpenTUI 的组件 API 可能变化；TASK-014 前不让 Agent Core 依赖任何 TUI 类型。
- **ASSUMPTION-001**: 学习期间具备至少一个 OpenAI 兼容模型的有效凭据。
- **ASSUMPTION-002**: 项目继续使用当前 Bun monorepo 结构。
- **ASSUMPTION-003**: 每次学习会话只推进一个 Task，由学习者确认完成后再继续。

## 12. 完成标准

整条学习路径完成时，项目应满足：

- [ ] 支持多轮对话和流式文本输出。
- [ ] 支持 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`。
- [ ] Tool Loop 由 AI SDK 管理，没有第二套重复实现。
- [ ] AgentSession 支持持久化、恢复、Abort、Steering 和 Follow-up。
- [ ] 支持 PrintMode、REPL、OpenTUI 和最小 RPC。
- [ ] 支持 Compaction、Settings、Tool Approval、Extensions 和 Skills。
- [ ] 支持至少 OpenAI 与 Anthropic 两个 Provider。
- [ ] 可通过 Bun 编译为独立二进制。
- [ ] 所有测试、类型检查和 lint 通过。
- [ ] 每个核心能力都能由学习者解释其调用链和设计边界。

## 13. 延伸阅读

- [项目架构设计](../agent-architecture-design.md)
- [Vercel AI SDK 文档](https://ai-sdk.dev/docs)
- [Bun 文档](https://bun.com/docs)
- [OpenTUI](https://github.com/sst/opentui)

## 14. 下一步

只开始 **TASK-001：普通 LLM 流式 CLI**。

开始前先回答以下问题：

1. Provider、Model 和 API key 各自负责什么？
2. 为什么普通 `streamText()` 还不算 Agent？
3. CLI 输入经过哪些文件到达模型？
4. 文本增量应该写到 stdout 还是 stderr？为什么？

完成概念确认后，再修改 TASK-001 列出的文件。不要预先实现 `read` 或 `ToolLoopAgent`。

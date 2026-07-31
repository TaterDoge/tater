# TUI 输入与事件架构调整计划

## Context

当前 `packages/tui/src/main.tsx` 同时承担 renderer/keymap 创建、应用 UI、消息状态、提交逻辑以及全局 console 快捷键注册。`packages/tui/src/modes/interactive/keybindings.ts` 目前只是空占位文件。目标是让入口文件只做启动与依赖装配，并将两类机制明确分开：

- OpenTUI renderer 事件（例如鼠标文本选择完成）
- Keymap 命令与按键映射（例如 `` ` `` 切换 console）

初步 review 结论：不建议把 keymap 监听放进泛化的 `events/`；`useBindings` 注册的是包含 `commands` 与 `bindings` 的 keymap layer，应独立使用 `keybindings/` 目录，并按功能/作用域拆分文件。

## Approach

建议以交互模式为边界组织相关代码，而不是把仅交互 TUI 使用的监听器放到 `src/` 全局：

```text
packages/tui/src/
├── main.tsx
└── modes/
    └── interactive/
        ├── interactive-mode.tsx
        ├── components/
        │   └── ...
        ├── events/
        │   ├── index.ts
        │   └── copy-selection.ts
        ├── keybindings/
        │   ├── index.ts
        │   └── console.ts
        └── theme.ts
```

职责建议：

- `main.tsx`：解析/选择运行模式；创建或调用交互模式入口，不定义事件或键位。
- `interactive-mode.tsx`：导出 `InteractiveMode` 根组件；在其 Solid owner 中各调用一次 `useInteractiveEvents()` 与 `useInteractiveKeybindings()`，并承载当前交互 UI/状态。
- `events/index.ts`：导出 `useInteractiveEvents()`，只组合 renderer 级事件 hooks，不包含 keymap。
- `events/copy-selection.ts`：导出 `useCopySelection()`；通过 Solid 的 `useSelectionHandler` 取得选中文本，文本非空且 renderer 报告支持 OSC 52 时调用 clipboard API。不支持或写出失败时静默跳过，当前阶段不执行平台相关系统命令。
- `keybindings/index.ts`：导出 `useInteractiveKeybindings()`，组合所有交互模式 keymap layer hooks。
- `keybindings/console.ts`：导出 `useConsoleKeybindings()`，同时定义 `toggle-console` command 及其默认按键；command 与 binding 留在同一功能文件，避免字符串命令名跨文件漂移。

随着功能增长，继续按领域新增 `keybindings/session.ts`、`keybindings/navigation.ts`、`keybindings/editor.ts`，而不是按技术类型拆成一个 `commands.ts` 和一个 `bindings.ts`。

## Files to modify

- `packages/tui/src/main.tsx` — 移除应用级事件与按键定义，仅保留启动装配。
- `packages/tui/src/modes/interactive/interactive-mode.tsx` — 从占位文件调整为交互模式组合入口。
- `packages/tui/src/modes/interactive/keybindings.ts` — 删除/替换为空间更清晰的 `keybindings/` 目录。
- `packages/tui/src/modes/interactive/keybindings/index.ts` — 统一注册交互模式键位层。
- `packages/tui/src/modes/interactive/keybindings/console.ts` — console command 与默认 binding。
- `packages/tui/src/modes/interactive/events/index.ts` — 统一挂载交互模式 renderer 事件。
- `packages/tui/src/modes/interactive/events/copy-selection.ts` — 文本选择复制行为。

`main.tsx` 继续负责创建 renderer、默认 keymap 和 `KeymapProvider`；`InteractiveMode` 必须渲染在 provider 内，确保拆出的 `useBindings` 可以取得 keymap context。

## Reuse

- `createDefaultOpenTuiKeymap(renderer)`：`packages/tui/src/main.tsx` 已使用，继续作为 keymap host。
- `KeymapProvider`：`packages/tui/src/main.tsx` 已使用，保证所有 `useBindings` hooks 位于 provider 下。
- `useBindings`：当前 `main.tsx` 的 console layer 注册方式直接迁移到功能文件。
- `useRenderer`：当前 console command 已使用；selection copy 也复用同一 renderer context。
- `useSelectionHandler`：使用 `@opentui/solid` 官方生命周期 hook，随 Solid owner 自动清理监听。
- `Selection.getSelectedText()` 与 `renderer.copyToClipboardOSC52()`：复用 OpenTUI 原生选择及 OSC 52 能力，不引入自建事件总线或 clipboard service。

## Steps

- [x] 将当前 `App` UI/消息状态/提交逻辑从 `main.tsx` 移入 `InteractiveMode`，保持现有渲染与占位回复行为不变。
- [x] 用 `keybindings/` 目录替换空的 `keybindings.ts`。
- [x] 将 console command 和按键映射原样迁移到 `keybindings/console.ts`，并由 `keybindings/index.ts` 聚合。
- [x] 新增 `events/` 目录，由 `events/index.ts` 聚合 selection-copy hook。
- [x] 在 `InteractiveMode` 顶层各调用一次事件与键位聚合 hook，避免因消息列表或子组件重建重复注册。
- [x] 对消息 `<text>` 显式设置 `selectable`；selection 文本为空时不复制。
- [x] 仅在 `renderer.isOsc52Supported()` 为真时调用 `copyToClipboardOSC52()`；不支持或返回失败时静默降级。
- [x] 精简 `main.tsx` 为 renderer、默认 keymap、provider 和交互模式装配，并删除旧空占位文件。
- [x] 整理 imports/exports，遵守项目 Biome/TypeScript 规则。

## Verification

- 运行 `packages/tui` TypeScript typecheck。
- 运行现有 Bun tests。
- 启动交互模式，确认 `` ` `` 仍能打开/关闭 console，且不会重复触发。
- 鼠标拖选单行和跨行消息，确认 selection 完成后复制到系统剪贴板。
- 选择空白或未产生文本时，确认不会尝试复制。
- 在不支持/禁用 OSC 52 的终端中确认应用不报错且静默跳过，不调用 `pbcopy`、`wl-copy` 或 `xclip`。
- 退出交互模式，确认 renderer 与 Solid scope 清理后没有残留监听器。

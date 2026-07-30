// TUI 入口：参数解析 → 模式分发

/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload";

import { render } from "@opentui/solid";

const App = () => <text fg="#00FF00">Hello, OpenTUI!</text>;

await render(App, {
  exitOnCtrlC: true,
  targetFps: 60,
});

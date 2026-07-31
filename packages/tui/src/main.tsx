/** @jsxImportSource @opentui/solid */
import { ConsolePosition, createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { InteractiveMode } from "./modes/interactive/interactive-mode";

const renderer = await createCliRenderer({
  consoleOptions: { position: ConsolePosition.BOTTOM, sizePercent: 30 },
  exitOnCtrlC: true,
  targetFps: 60,
});
const keymap = createDefaultOpenTuiKeymap(renderer);

await render(
  () => (
    <KeymapProvider keymap={keymap}>
      <InteractiveMode />
    </KeymapProvider>
  ),
  renderer
);

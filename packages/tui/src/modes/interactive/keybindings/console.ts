import { useBindings } from "@opentui/keymap/solid";
import { useRenderer } from "@opentui/solid";

export const useConsoleKeybindings = () => {
  const renderer = useRenderer();

  useBindings(() => ({
    bindings: [{ cmd: "toggle-console", key: "`" }],
    commands: [
      {
        name: "toggle-console",
        run() {
          renderer.console.toggle();
        },
      },
    ],
  }));
};

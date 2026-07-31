import { useRenderer, useSelectionHandler } from "@opentui/solid";

export const useCopySelection = () => {
  const renderer = useRenderer();

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();

    if (!(text && renderer.isOsc52Supported())) {
      return;
    }

    renderer.copyToClipboardOSC52(text);
  });
};

import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  compile: {
    outfile: "../../dist/tater-agent",
  },
  entrypoints: ["src/main.tsx"],
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

import { resolve } from "node:path";
import { settingsConfigFileSchema } from "@tater/agent-session";
import { z } from "zod";

const outputPath = resolve(import.meta.dir, "../../../settings.schema.json");
const schema = z.toJSONSchema(settingsConfigFileSchema, {
  io: "input",
  target: "draft-7",
});

await Bun.write(
  outputPath,
  `${JSON.stringify(
    {
      ...schema,
      $id: "https://raw.githubusercontent.com/TaterDoge/tater/main/settings.schema.json",
      title: "Tater Settings",
    },
    null,
    2
  )}\n`
);

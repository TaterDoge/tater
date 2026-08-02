import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigDir,
  mergeConfigFiles,
  SETTINGS_SCHEMA_URL,
  SettingsManager,
} from "./settings-manager";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tater-settings-"));
  tempDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("getConfigDir", () => {
  test("优先使用绝对 XDG_CONFIG_HOME", () => {
    expect(
      getConfigDir({ HOME: "/home/user", XDG_CONFIG_HOME: "/tmp/config" })
    ).toBe("/tmp/config/tater");
  });

  test("忽略相对 XDG_CONFIG_HOME 并回退到 HOME", () => {
    expect(
      getConfigDir({ HOME: "/home/user", XDG_CONFIG_HOME: "relative" })
    ).toBe("/home/user/.config/tater");
  });
});

describe("mergeConfigFiles", () => {
  test("按 global、project、CLI 顺序合并嵌套配置", () => {
    const config = mergeConfigFiles(
      {
        generation: {
          headers: { global: "yes" },
          maxRetries: 1,
          providerOptions: {
            openai: { reasoningEffort: "low", store: false },
          },
        },
        model: "global/model",
        provider: {
          llm: {
            adapter: "openai",
            models: {
              global: { limit: { context: 1000, output: 100 } },
            },
            options: { organization: "org" },
          },
        },
      },
      {
        generation: {
          headers: { project: "yes" },
          providerOptions: { openai: { store: true } },
          temperature: 0.5,
        },
        model: "project/model",
        provider: {
          llm: {
            adapter: "openai",
            models: {
              project: { limit: { context: 2000, output: 200 } },
            },
            options: { project: "project" },
          },
        },
      },
      {
        generation: { maxRetries: 3 },
        model: "cli/model",
      }
    );

    expect(config.model).toBe("cli/model");
    expect(config.generation).toEqual({
      headers: { global: "yes", project: "yes" },
      maxRetries: 3,
      providerOptions: {
        openai: { reasoningEffort: "low", store: true },
      },
      temperature: 0.5,
    });
    expect(config.provider.llm?.models).toEqual({
      global: { limit: { context: 1000, output: 100 } },
      project: { limit: { context: 2000, output: 200 } },
    });
    expect(config.provider.llm?.options).toEqual({
      organization: "org",
      project: "project",
    });
  });

  test("拒绝拼写错误的配置字段", () => {
    expect(() =>
      mergeConfigFiles({ generation: { maxRetry: 1 } } as never, {})
    ).toThrow();
  });
});

describe("SettingsManager", () => {
  test("全局配置不存在时创建带 Schema 的 JSON 文件", async () => {
    const root = await createTempDirectory();
    const configPath = join(root, "config", "tater", "settings.json");

    await SettingsManager.create(
      root,
      {},
      {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
      }
    );

    expect(await Bun.file(configPath).json()).toEqual({
      $schema: SETTINGS_SCHEMA_URL,
    });
    expect((await Bun.file(configPath).stat()).mode % 0o1000).toBe(0o600);
  });

  test("读取 XDG 全局配置和项目配置", async () => {
    const root = await createTempDirectory();
    const xdg = join(root, "config");
    const cwd = join(root, "project");
    await Bun.write(
      join(xdg, "tater", "settings.json"),
      JSON.stringify({ model: "llm/global", theme: "dark" })
    );
    await Bun.write(
      join(cwd, ".tater", "settings.json"),
      JSON.stringify({ model: "llm/project" })
    );

    const settings = await SettingsManager.create(
      cwd,
      { model: "llm/cli" },
      { HOME: root, XDG_CONFIG_HOME: xdg }
    );

    expect(settings.getDefaultModel()).toBe("llm/cli");
    expect(settings.getTheme()).toBe("dark");
    expect(await Bun.file(join(xdg, "tater", "settings.json")).json()).toEqual({
      model: "llm/global",
      theme: "dark",
    });
  });

  test("无效 JSON 会报告配置文件路径", async () => {
    const root = await createTempDirectory();
    const configPath = join(root, "tater", "settings.json");
    await Bun.write(configPath, "{");

    expect(
      SettingsManager.create(root, {}, { HOME: root, XDG_CONFIG_HOME: root })
    ).rejects.toThrow(configPath);
  });
});

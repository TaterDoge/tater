import { chmod } from "node:fs/promises";
import {
  type GenerationConfig,
  generationConfigSchema,
  type ProviderConfig,
  providerConfigSchema,
} from "@tater/ai-adapter/types";
import { z } from "zod";

export type Env = Readonly<Record<string, string | undefined>>;

export interface SettingsPaths {
  global: string;
  project: string;
}

export const settingsConfigFileSchema = z.strictObject({
  $schema: z.url().optional(),
  generation: generationConfigSchema.optional(),
  model: z.string().min(1).optional(),
  provider: z.record(z.string().min(1), providerConfigSchema).optional(),
  smallModel: z.string().min(1).optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
  theme: z.string().min(1).optional(),
});

export const settingsConfigSchema = settingsConfigFileSchema.extend({
  generation: generationConfigSchema.default({}),
  provider: z.record(z.string().min(1), providerConfigSchema).default({}),
});

export type SettingsConfigFile = z.infer<typeof settingsConfigFileSchema>;
export type SettingsConfig = z.infer<typeof settingsConfigSchema>;

export function getConfigDir(env: Env = Bun.env): string {
  let configHome = env.XDG_CONFIG_HOME?.startsWith("/")
    ? env.XDG_CONFIG_HOME
    : undefined;
  if (!configHome && env.HOME) {
    configHome = `${env.HOME}/.config`;
  }

  if (!configHome) {
    throw new Error("无法确定配置目录：HOME 未设置");
  }

  return `${configHome}/tater`;
}

export function getSettingsPaths(
  cwd: string,
  env: Env = Bun.env
): SettingsPaths {
  return {
    global: `${getConfigDir(env)}/settings.json`,
    project: `${cwd}/.tater/settings.json`,
  };
}

async function ensureGlobalConfig(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    await Bun.write(path, "{}\n");
    await chmod(path, 0o600);
  }
}

async function loadConfigFile(path: string): Promise<SettingsConfigFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {};
  }

  try {
    return settingsConfigFileSchema.parse(await file.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`配置文件无效：${path}\n${message}`, { cause: error });
  }
}

function mergeProviderOptions(
  ...configs: (GenerationConfig["providerOptions"] | undefined)[]
): GenerationConfig["providerOptions"] {
  const merged: NonNullable<GenerationConfig["providerOptions"]> = {};
  for (const config of configs) {
    for (const [providerId, options] of Object.entries(config ?? {})) {
      merged[providerId] = { ...merged[providerId], ...options };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeProviders(
  ...configs: (Record<string, ProviderConfig> | undefined)[]
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};
  for (const config of configs) {
    for (const [providerId, provider] of Object.entries(config ?? {})) {
      const previous = merged[providerId];
      if (!previous || previous.adapter !== provider.adapter) {
        merged[providerId] = provider;
        continue;
      }

      // discriminated union 需要按 adapter 分支合并，避免把不同厂商的 options 混在一起。
      if (provider.adapter === "openai" && previous.adapter === "openai") {
        merged[providerId] = {
          ...provider,
          models: { ...previous.models, ...provider.models },
          options: { ...previous.options, ...provider.options },
        };
      } else if (
        provider.adapter === "anthropic" &&
        previous.adapter === "anthropic"
      ) {
        merged[providerId] = {
          ...provider,
          models: { ...previous.models, ...provider.models },
          options: { ...previous.options, ...provider.options },
        };
      } else if (
        provider.adapter === "openai-compatible" &&
        previous.adapter === "openai-compatible"
      ) {
        merged[providerId] = {
          ...provider,
          models: { ...previous.models, ...provider.models },
          options: { ...previous.options, ...provider.options },
        };
      }
    }
  }
  return merged;
}

export function mergeConfigFiles(
  global: SettingsConfigFile,
  project: SettingsConfigFile,
  cli: SettingsConfigFile = {}
): SettingsConfig {
  const headers = {
    ...global.generation?.headers,
    ...project.generation?.headers,
    ...cli.generation?.headers,
  };
  const providerOptions = mergeProviderOptions(
    global.generation?.providerOptions,
    project.generation?.providerOptions,
    cli.generation?.providerOptions
  );

  return settingsConfigSchema.parse({
    ...global,
    ...project,
    ...cli,
    generation: {
      ...global.generation,
      ...project.generation,
      ...cli.generation,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    },
    provider: mergeProviders(global.provider, project.provider, cli.provider),
  });
}

export class SettingsManager {
  private readonly settings: SettingsConfig;
  readonly paths: SettingsPaths;

  private constructor(settings: SettingsConfig, paths: SettingsPaths) {
    this.settings = settings;
    this.paths = paths;
  }

  static async create(
    cwd: string,
    cli: SettingsConfigFile = {},
    env: Env = Bun.env
  ): Promise<SettingsManager> {
    const paths = getSettingsPaths(cwd, env);
    await ensureGlobalConfig(paths.global);

    const [global, project] = await Promise.all([
      loadConfigFile(paths.global),
      loadConfigFile(paths.project),
    ]);

    return new SettingsManager(
      mergeConfigFiles(global, project, settingsConfigFileSchema.parse(cli)),
      paths
    );
  }

  getConfig(): Readonly<SettingsConfig> {
    return this.settings;
  }

  getDefaultModel(): string | undefined {
    return this.settings.model;
  }

  getSmallModel(): string | undefined {
    return this.settings.smallModel;
  }

  getTheme(): string {
    return this.settings.theme ?? "default";
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.settings.steeringMode ?? "all";
  }
}

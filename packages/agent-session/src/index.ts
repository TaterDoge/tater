// biome-ignore lint/performance/noBarrelFile: package 根导出是 workspace 的公共 API。
export {
  type Env,
  getConfigDir,
  getSettingsPaths,
  mergeConfigFiles,
  type SettingsConfig,
  type SettingsConfigFile,
  SettingsManager,
  type SettingsPaths,
  settingsConfigFileSchema,
  settingsConfigSchema,
} from "./settings-manager";

import type { LanguageModel } from "ai";
import { createLanguageModel } from "./adapters/registry";
import type {
  GenerationConfig,
  ModelConfig,
  ProviderConfig,
  ThinkingLevel,
} from "./types";

export interface ModelSettings {
  generation: GenerationConfig;
  model?: string;
  provider: Record<string, ProviderConfig>;
}

export interface ResolvedModel {
  id: string;
  metadata: ModelConfig;
  model: LanguageModel;
  providerId: string;
}

export function parseModelReference(reference: string): {
  providerId: string;
  modelId: string;
} {
  const separator = reference.indexOf("/");
  if (separator < 1 || separator === reference.length - 1) {
    throw new Error(`模型引用必须使用 provider/model 格式：${reference}`);
  }

  return {
    modelId: reference.slice(separator + 1),
    providerId: reference.slice(0, separator),
  };
}

export function resolveModel(
  config: ModelSettings,
  reference = config.model
): ResolvedModel {
  const fallback = Object.entries(config.provider).find(
    ([, candidate]) => Object.keys(candidate.models).length > 0
  );
  const { providerId, modelId } = reference
    ? parseModelReference(reference)
    : {
        modelId: Object.keys(fallback?.[1].models ?? {})[0],
        providerId: fallback?.[0],
      };

  if (!(providerId && modelId)) {
    throw new Error("未配置可用模型");
  }

  const provider = config.provider[providerId];
  if (!provider) {
    throw new Error(`不存在 Provider：${providerId}`);
  }

  const metadata = provider.models[modelId];
  if (!metadata) {
    throw new Error(`Provider ${providerId} 中不存在模型：${modelId}`);
  }

  return {
    id: modelId,
    metadata,
    model: createLanguageModel(provider, modelId),
    providerId,
  };
}

export function mapThinkingLevel(
  provider: ProviderConfig,
  modelId: string,
  level: ThinkingLevel
): ThinkingLevel | null {
  const model = provider.models[modelId];
  if (!model) {
    throw new Error(`Provider 中不存在模型：${modelId}`);
  }

  const mappedLevel = model.thinkingLevelMap?.[level];
  return mappedLevel === undefined ? level : mappedLevel;
}

export function getGenerationConfig(config: ModelSettings): GenerationConfig {
  return config.generation;
}

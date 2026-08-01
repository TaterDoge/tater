import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderConfig } from "../types";

export function createLanguageModel(
  providerConfig: ProviderConfig,
  modelId: string
): LanguageModel {
  if (!providerConfig.models[modelId]) {
    throw new Error(`Provider 中不存在模型：${modelId}`);
  }

  if (providerConfig.adapter === "openai") {
    const modelConfig = providerConfig.models[modelId];
    const provider = createOpenAI(providerConfig.options);
    if (modelConfig.api === "chat") {
      return provider.chat(modelId);
    }
    if (modelConfig.api === "completion") {
      return provider.completion(modelId);
    }
    return provider.responses(modelId);
  }

  if (providerConfig.adapter === "anthropic") {
    return createAnthropic(providerConfig.options)(modelId);
  }

  return createOpenAICompatible(providerConfig.options)(modelId);
}

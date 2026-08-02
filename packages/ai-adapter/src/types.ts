import { z } from "zod";

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const modelBaseConfigSchema = z.strictObject({
  compat: z
    .strictObject({
      maxTokensField: z
        .enum(["max_tokens", "max_completion_tokens"])
        .optional(),
      supportsDeveloperRole: z.boolean().optional(),
      supportsReasoningEffort: z.boolean().optional(),
      supportsStore: z.boolean().optional(),
      supportsStrictMode: z.boolean().optional(),
      thinkingFormat: z.enum(["openai", "anthropic", "deepseek"]).optional(),
    })
    .optional(),
  cost: z
    .strictObject({
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
    })
    .optional(),
  limit: z
    .strictObject({
      context: z.number().int().positive(),
      output: z.number().int().positive(),
    })
    .optional(),
  modalities: z
    .strictObject({
      input: z.array(z.enum(["text", "image", "audio"])),
      output: z.array(z.enum(["text", "image", "audio"])),
    })
    .optional(),
  name: z.string().min(1).optional(),
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z
    .partialRecord(thinkingLevelSchema, thinkingLevelSchema.nullable())
    .optional(),
});

// 只有 OpenAI adapter 会读取 api；其他 adapter 出现该字段时应直接拒绝。
const openAIModelConfigSchema = modelBaseConfigSchema.extend({
  api: z.enum(["responses", "chat", "completion"]).optional(),
});
const modelsSchema = z.record(z.string().min(1), modelBaseConfigSchema);
const openAIModelsSchema = z.record(z.string().min(1), openAIModelConfigSchema);
const commonProviderOptionsSchema = z.strictObject({
  apiKey: z.string().min(1).optional(),
  baseURL: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1).optional(),
});

export const providerConfigSchema = z.discriminatedUnion("adapter", [
  z.strictObject({
    adapter: z.literal("openai"),
    models: openAIModelsSchema,
    options: commonProviderOptionsSchema.extend({
      organization: z.string().min(1).optional(),
      project: z.string().min(1).optional(),
    }),
  }),
  z.strictObject({
    adapter: z.literal("anthropic"),
    models: modelsSchema,
    options: commonProviderOptionsSchema.extend({
      authToken: z.string().min(1).optional(),
    }),
  }),
  z.strictObject({
    adapter: z.literal("openai-compatible"),
    models: modelsSchema,
    options: z.strictObject({
      apiKey: z.string().min(1).optional(),
      baseURL: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      includeUsage: z.boolean().optional(),
      name: z.string().min(1),
      queryParams: z.record(z.string(), z.string()).optional(),
      supportsStructuredOutputs: z.boolean().optional(),
    }),
  }),
]);

export const generationConfigSchema = z.strictObject({
  frequencyPenalty: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  presencePenalty: z.number().optional(),
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.json()))
    .optional(),
  seed: z.number().int().optional(),
  stopSequences: z.array(z.string()).optional(),
  temperature: z.number().optional(),
  timeout: z
    .union([
      z.number().int().positive(),
      z.strictObject({
        chunkMs: z.number().int().positive().optional(),
        firstChunkMs: z.number().int().positive().optional(),
        stepMs: z.number().int().positive().optional(),
        toolMs: z.number().int().positive().optional(),
        totalMs: z.number().int().positive().optional(),
      }),
    ])
    .optional(),
  topK: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
});

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ModelConfig =
  | z.infer<typeof modelBaseConfigSchema>
  | z.infer<typeof openAIModelConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type GenerationConfig = z.infer<typeof generationConfigSchema>;

import { describe, expect, test } from "bun:test";
import type { ModelSettings } from "./model-runtime";
import {
  mapThinkingLevel,
  parseModelReference,
  resolveModel,
} from "./model-runtime";

const config: ModelSettings = {
  generation: {},
  model: "local/test-model",
  provider: {
    local: {
      adapter: "openai-compatible",
      models: {
        "test-model": {
          limit: { context: 1000, output: 100 },
          reasoning: true,
          thinkingLevelMap: { high: null, xhigh: "max" },
        },
      },
      options: {
        baseURL: "http://localhost:8317/v1",
        name: "local",
      },
    },
  },
};

describe("parseModelReference", () => {
  test("解析 provider/model 引用", () => {
    expect(parseModelReference("local/test-model")).toEqual({
      modelId: "test-model",
      providerId: "local",
    });
  });

  test("拒绝无 Provider 的引用", () => {
    expect(() => parseModelReference("test-model")).toThrow("provider/model");
  });
});

describe("resolveModel", () => {
  test("从默认引用创建 AI SDK 模型", () => {
    const resolved = resolveModel(config);
    expect(resolved.id).toBe("test-model");
    expect(resolved.providerId).toBe("local");
    expect(typeof resolved.model).toBe("object");
  });

  test("未设置默认模型时使用第一个 Provider 的第一个模型", () => {
    const { model: _model, ...configWithoutDefault } = config;
    const resolved = resolveModel(configWithoutDefault);

    expect(resolved.id).toBe("test-model");
    expect(resolved.providerId).toBe("local");
  });

  test("未配置任何模型时报告错误", () => {
    expect(() => resolveModel({ generation: {}, provider: {} })).toThrow(
      "未配置可用模型"
    );
  });

  test("映射模型的 thinking level", () => {
    const provider = config.provider.local;

    expect(mapThinkingLevel(provider, "test-model", "xhigh")).toBe("max");
    expect(mapThinkingLevel(provider, "test-model", "high")).toBeNull();
    expect(mapThinkingLevel(provider, "test-model", "low")).toBe("low");
  });
});

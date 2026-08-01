import { describe, expect, test } from "bun:test";
import { providerConfigSchema } from "./types";

const model = { limit: { context: 1000, output: 100 } };

describe("providerConfigSchema", () => {
  test("OpenAI 支持选择 API", () => {
    expect(
      providerConfigSchema.parse({
        adapter: "openai",
        models: { test: { ...model, api: "chat" } },
        options: {},
      })
    ).toBeDefined();
  });

  test("Anthropic 和 OpenAI-compatible 拒绝无效的 API 选项", () => {
    expect(() =>
      providerConfigSchema.parse({
        adapter: "anthropic",
        models: { test: { ...model, api: "chat" } },
        options: {},
      })
    ).toThrow();
    expect(() =>
      providerConfigSchema.parse({
        adapter: "openai-compatible",
        models: { test: { ...model, api: "chat" } },
        options: { baseURL: "http://localhost:8317/v1", name: "local" },
      })
    ).toThrow();
  });
});

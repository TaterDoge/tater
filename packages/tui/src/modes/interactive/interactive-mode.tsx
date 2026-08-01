import { effect } from "@opentui/solid";
import { type ModelSettings, resolveModel } from "@tater/ai-adapter";
import { streamText } from "ai";
import { createSignal, For } from "solid-js";
import { useInteractiveEvents } from "./events";
import { useInteractiveKeybindings } from "./keybindings";

interface Msg {
  content: string;
  role: "user" | "assistant";
}

// TODO: 实际从 SettingsManager.create(cwd).getConfig() 构造ModelSettings;
const modelSettings: ModelSettings = {
  generation: { temperature: 0.7 },
  model: "custom/gpt-5.6-luna",
  provider: {
    custom: {
      adapter: "openai",
      models: {
        "gpt-5.6-luna": {
          api: "chat",
          limit: { context: 128_000, output: 16_384 },
        },
      },
      options: { apiKey: "sk-local", baseURL: "http://localhost:8317/v1" },
    },
  },
};

const { model } = resolveModel(modelSettings);

export const InteractiveMode = () => {
  useInteractiveEvents();
  useInteractiveKeybindings();

  const [messages, setMessages] = createSignal<Msg[]>([
    { content: "你好，有什么可以帮你？", role: "assistant" },
  ]);
  const [draft, setDraft] = createSignal("");

  const submit = async () => {
    const v = draft();
    if (!v.trim()) {
      return;
    }

    // 先把用户消息和一条空的 assistant 占位推进列表，UI 立即响应
    const history = messages();
    setMessages((m) => [
      ...m,
      { content: v, role: "user" },
      { content: "", role: "assistant" },
    ]);
    setDraft("");

    const result = streamText({
      messages: [...history, { content: v, role: "user" }],
      model,
    });

    // 消费 textStream，把每个 chunk 追加到最后一条 assistant 消息
    for await (const chunk of result.textStream) {
      setMessages((msgs) => {
        const last = msgs.at(-1);
        if (!last) {
          return msgs; // 占位已被清空则不动
        }
        const merged = { ...last, content: last.content + chunk };
        return msgs.with(-1, merged);
      });
    }
  };

  effect(() => {
    console.log("messages", messages());
  });

  return (
    <box
      borderColor="#9ece6a"
      borderStyle="rounded"
      style={{ flexDirection: "column", height: "100%", width: "100%" }}
    >
      {/* 消息历史：sticky 底部，新消息自动滚动 */}
      <scrollbox
        stickyScroll
        stickyStart="bottom"
        style={{ flexGrow: 1, width: "100%" }}
      >
        <For each={messages()}>
          {(m) => (
            <box style={{ flexDirection: "row", padding: 0 }}>
              <text
                fg={m.role === "user" ? "#7aa2f7" : "#9ece6a"}
                selectable={true}
              >
                {m.role === "user" ? "你" : "AI"}: {m.content}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
      {/* 输入框 */}
      <box
        borderColor="#565f89"
        borderStyle="rounded"
        style={{
          backgroundColor: "#1f2335",
          marginTop: 1,
          padding: 1,
          width: "100%",
        }}
      >
        <input
          backgroundColor="#1f2335"
          cursorColor="#7aa2f7"
          focused={true}
          focusedBackgroundColor="#292e42"
          onInput={setDraft}
          onSubmit={submit}
          placeholder="输入消息，Enter 发送…"
          textColor="#c0caf5"
          value={draft()}
        />
      </box>
    </box>
  );
};

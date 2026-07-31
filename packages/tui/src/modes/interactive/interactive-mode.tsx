/** @jsxImportSource @opentui/solid */
import { createSignal, For } from "solid-js";
import { useInteractiveEvents } from "./events";
import { useInteractiveKeybindings } from "./keybindings";

interface Msg {
  content: string;
  role: "user" | "assistant";
}

export const InteractiveMode = () => {
  useInteractiveEvents();
  useInteractiveKeybindings();

  const [messages, setMessages] = createSignal<Msg[]>([
    { content: "你好，有什么可以帮你？", role: "assistant" },
  ]);
  const [draft, setDraft] = createSignal("");

  const submit = () => {
    const v = draft();
    if (!v.trim()) {
      return;
    }
    console.log(v);
    setMessages((m) => [...m, { content: v, role: "user" }]);
    setDraft(""); // ponytail: 假数据，接 LLM 时换成流式 append
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        { content: "（占位回复）", role: "assistant" },
      ]);
    }, 300);
  };

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

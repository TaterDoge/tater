有，但你这个场景不需要自己做弹框。OpenTUI 自带 **Console Overlay**，专门显示被 TUI 截获的 `console.log`。

### Core 用法

```ts
import { createCliRenderer, ConsolePosition } from "@opentui/core"

const renderer = await createCliRenderer({
  consoleOptions: {
    position: ConsolePosition.BOTTOM,
    sizePercent: 30,
  },
})

renderer.console.show()
console.log("测试内容", { foo: "bar" })
```

也可以启动时直接打开：

```bash
SHOW_CONSOLE=true bun run dev
```

或者绑定快捷键开关：

```ts
renderer.keyInput.on("keypress", (key) => {
  if (key.name === "`") {
    renderer.console.toggle()
  }
})
```

### React 用法

```tsx
import { useRenderer } from "@opentui/react"
import { useEffect } from "react"

function App() {
  const renderer = useRenderer()

  useEffect(() => {
    renderer.console.show()
    console.log("测试内容")
  }, [renderer])

  return <box />
}
```

Console 聚焦后可用方向键滚动，`+` / `-` 调整大小。

真正的 modal 弹框通常需要用绝对定位的 `<box>` 或 Portal 自己组合；仅为了调试打印，直接用 `renderer.console.show()` 最简单。

# mindmap

基于 [silkor](../) 画布内核的 思维导图 场景包，包名 `silkio-mindmap`。

三个开源仓各司其职：`silkor` 提供内核与官方插件，`mindmap` 与 `flowchart` 是两个互不依赖的场景实现。本仓不依赖 `flowchart`。

## 安装

```sh
pnpm add silkio-mindmap
```

`@silkor/core` 与 `@silkor/preset` 会作为依赖一并安装（便捷装配所需）。

## 使用

便捷装配模式（默认）：只传画布元素，场景内部自建 `App` 并按官方预设（`officialPlugins()`）装配全部官方插件，开箱即用：

```ts
import { MindMap } from "silkio-mindmap";

const mindmap = new MindMap({ canvas, data: root, onChange: (type) => { /* ... */ } });
```

显式装配模式（高级用法）：宿主自行创建 `App`、装配官方插件，再把 `app` 交给场景包，便于宿主完全控制插件组合（实现均可按契约替换）；`examples/demo-mindmap` 演示了这一用法。两种模式二选一，装配缺口由 `app.require(...)` 兜底报错。

对外导出见 `src/index.ts`。`examples/demo-mindmap` 是可运行的 Astro + Vue 演示。

## 开发

```sh
pnpm install
pnpm check:deps   # 边界守护：禁止直连插件、禁止依赖另一个场景仓
pnpm build
pnpm test
```

`pnpm check:deps` 会把「场景包只依赖 core + preset」这条规则机械化。官方插件清单以 `@silkor/preset` 的 `officialPlugins()` 为单一事实来源，本仓不得直接依赖 `@silkor/plugin-*`。

> 依赖的 `@silkor/core` / `@silkor/preset` 固定从 npm 安装正式版本，不再链接本地源码。需要改内核时在 `silkor` 仓开发并发布，再升级本仓的依赖版本号。

## 版本约定

依赖的 `@silkor/core` / `@silkor/preset` 版本号必须与 `silkor` 仓当前发布的版本族一致。能力键常量在 core、实现在插件，版本错配会到 `app.require(...)` 运行时才暴露。

## License

MIT

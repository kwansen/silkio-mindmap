# mindmap

基于 [silker](../) 画布内核的 思维导图 场景包，包名 `@silker/mindmap`。

三个开源仓各司其职：`silker` 提供内核与官方插件，`mindmap` 与 `flowchart` 是两个互不依赖的场景实现。本仓不依赖 `flowchart`。

## 安装

```sh
pnpm add @silker/mindmap
```

`@silker/core` 会作为依赖一并安装；若需要官方插件预设，另装 `@silker/preset`。

## 使用

显式装配模式：宿主自行创建 `App`、装配官方插件（`officialPlugins()`），再把 `app` 交给场景包。本包刻意不依赖 `@silker/preset`，便于宿主完全控制插件组合；`examples/demo-mindmap` 演示了这一用法。独立使用时建议补一层便捷入口，避免用户手工装配。

对外导出见 `src/index.ts`。`examples/demo-mindmap` 是可运行的 Astro + Vue 演示。

## 开发

```sh
pnpm install
pnpm check:deps   # 边界守护：禁止直连插件、禁止依赖另一个场景仓
pnpm build
pnpm test
```

`pnpm check:deps` 会把「场景包只依赖 core + preset」这条规则机械化。官方插件清单以 `@silker/preset` 的 `officialPlugins()` 为单一事实来源，本仓不得直接依赖 `@silker/plugin-*`。

> 本地跨仓联调请在父开发目录（`silker-dev.code-workspace`）执行，父目录的 workspace 覆盖层会让 `^1.0.0` 依赖链接到 `silker/` 的源码，改内核即时生效。本仓自己的 CI 在仓目录执行，依赖从 npm 拉取正式版本。

## 版本约定

依赖的 `@silker/core` / `@silker/preset` 版本号必须与 `silker` 仓当前发布的版本族一致。能力键常量在 core、实现在插件，版本错配会到 `app.require(...)` 运行时才暴露。

## License

ISC

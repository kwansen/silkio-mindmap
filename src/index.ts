// 统一导出 MindMap 与相关类型
export { MindMap } from "./mindmap"
export type {
  Style,
  MindMapNode,
  MindMapOptions,
  LayoutDirection,
  MindMapChangeType,
} from "./mindmap"
// 自动布局：契约 + 官方树形布局插件（第三方布局插件按能力键同名覆盖）
export { BuiltinTreeLayout } from "./layout"
export { AUTO_LAYOUT_CAPABILITY } from "./auto-layout"
export type { AutoLayoutCapability, AutoLayoutOptions } from "./auto-layout"

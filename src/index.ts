// 统一导出 MindMap 与相关类型
export { MindMap } from "./mindmap"
// 包内不变量断言开关：生产环境可关闭（默认开启，违例即抛错）
export { setInvariantsEnabled } from "./invariants"
export type {
  Style,
  MindMapNode,
  MindMapOptions,
  LayoutDirection,
  LayoutDirectionRef,
  MindMapChangeType,
} from "./types"
// 自动布局：契约 + 官方树形布局插件（第三方布局插件按能力键同名覆盖）
export { BuiltinTreeLayout } from "./layout"
export { AUTO_LAYOUT_CAPABILITY } from "./auto-layout"
export type { AutoLayoutCapability, AutoLayoutOptions } from "./auto-layout"
// AI 编辑：契约 + 控制器 + 插件（生成适配器由宿主经 MindMapOptions.ai 注入）。
// 操作解析/目标定位等内部纯函数不进入公共 API——宿主只消费控制器与协议类型；
// 包内测试与扩展经 "./ai"（或 ai-protocol/ai-report 子模块）导入
export {
  AIEditingController,
  AIEditingPlugin,
  AI_EDITING_CAPABILITY,
  defaultAIEditPrompt,
} from "./ai"
export type {
  AIMindMapOp,
  AIMindMapAddOp,
  AIMindMapEditOp,
  AIMindMapMoveOp,
  AIMindMapDeleteOp,
  AIMindMapRenderOp,
  AIMindMapAnswerOp,
  AIMindMapUndoOp,
  AIMindMapRedoOp,
  AIMindMapHistoryOp,
  AIEditRequest,
  AIEditResult,
  AIEditStep,
  AIEditTurn,
  AIEditGenerate,
  AIEditRunOptions,
} from "./ai"

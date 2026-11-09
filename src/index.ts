// 统一导出 MindMap 与相关类型
export { MindMap } from "./mindmap"
export type {
  Style,
  MindMapNode,
  MindMapOptions,
  LayoutDirection,
  MindMapChangeType,
} from "./types"
// 自动布局：契约 + 官方树形布局插件（第三方布局插件按能力键同名覆盖）
export { BuiltinTreeLayout } from "./layout"
export { AUTO_LAYOUT_CAPABILITY } from "./auto-layout"
export type { AutoLayoutCapability, AutoLayoutOptions } from "./auto-layout"
// AI 编辑：契约 + 控制器 + 插件（生成适配器由宿主经 MindMapOptions.ai 注入）
export {
  AIEditingController,
  AIEditingPlugin,
  AI_EDITING_CAPABILITY,
  defaultAIEditPrompt,
  normalizeAIOps,
  normalizeRenderTree,
  parseAIResponse,
  nodePath,
  collectTargetCandidates,
  parseTargetSegment,
  matchTargetSegment,
  resolveTargetByPath,
} from "./ai"
export type {
  AIMindMapOp,
  AIMindMapAddOp,
  AIMindMapEditOp,
  AIMindMapMoveOp,
  AIMindMapDeleteOp,
  AIMindMapRenderOp,
  AIMindMapAnswerOp,
  AIEditRequest,
  AIEditResult,
  AIEditStep,
  AIEditTurn,
  AIEditGenerate,
  AIEditRunOptions,
  AIEditingDeps,
} from "./ai"

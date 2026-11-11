// AI 编辑模块转发出口：按职责拆分为四个子模块——
// - ai-protocol：操作 DSL / 请求与结果契约 / 目标定位与输出规整纯函数
// - ai-prompt：缺省提示词模板（协议的默认渲染）
// - ai-report：历史栈的可读描述（history 操作的读取实现）
// - ai-controller：控制器 + 能力注册插件（编译执行管线）
// 本文件保持既有导入路径（"./ai"）稳定，包外公共 API 面由 index.ts 收口
export * from "./ai-protocol";
export { defaultAIEditPrompt } from "./ai-prompt";
export { describeHistoryCommand } from "./ai-report";
export { AIEditingController, AIEditingPlugin } from "./ai-controller";
export type { AIEditingDeps } from "./ai-controller";

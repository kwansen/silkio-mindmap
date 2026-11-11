// 高亮环两态颜色（交互层共享常量）：激活（未编辑）蓝色，编辑紫色。
// 独立成文件避免消费方（如 drag）为取常量而依赖 editing 控制器模块
export const ACTIVE_COLOR = "#3b82f6";
export const EDITING_COLOR = "#a855f7";

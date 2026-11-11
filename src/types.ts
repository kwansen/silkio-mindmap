import type { App, Plugin } from "@silker/core";
import type { EdgeShape } from "@silker/core";
import type { AIEditGenerate } from "./ai";

export interface Style {
  color: string;
  backgroundColor: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  radius: number | [number, number, number, number];
  borderColor: string;
  borderWidth: number;
  lineHeight: number;
  padding:
    | number
    | [number]
    | [number, number]
    | [number, number, number]
    | [number, number, number, number];
}

export interface MindMapNode {
  // 节点稳定标识：序列化时自动捕获（运行时 Text 自带 id），供历史命令序列化
  // 与数据往返时保持节点同一性；缺省时运行时自动生成
  id?: string;
  text: string;
  // 节点样式：缺省时按级数回退到 levelStyles 配置（用户数据可覆盖级数配置）
  style?: Style;
  // 子树折叠态：true 时该节点折叠（子树隐藏），缺省为展开
  collapsed?: boolean;
  children: MindMapNode[];
}

// 未配置 levelStyles 且节点缺省 style 时的兜底样式
export const defaultStyle: Style = {
  color: "#1f2937",
  backgroundColor: "#ffffff",
  fontSize: 16,
  fontWeight: 400,
  fontFamily: "sans-serif",
  radius: 6,
  borderColor: "#94a3b8",
  borderWidth: 0,
  lineHeight: 1.4,
  padding: [6, 12],
};

export interface MindMapOptions {
  // 显式装配（starter-kit 模式）：传入宿主自建的 App（要求已安装官方外部插件
  // History/Command/Viewport/Pointer/Clicker/Exporter/TextEditor/Selection，
  // 通常经 @silker/preset 的 officialPlugins()，实现均可按契约替换），
  // MindMap 复用之并只补齐自有插件；场景包不依赖 preset，缺失能力由 require 兜底报错
  app: App;
  data: MindMapNode;
  // 布局方向：'right' 从左往右（子节点在父节点右侧），'left' 从右往左（子节点在父节点左侧），
  // 'down' 自上而下（子节点在父节点下方水平排列，即组织结构图布局），
  // 'both' 双向平衡布局（根节点的子节点按整体高度等分到左右两侧），默认 'left'
  direction?: "left" | "right" | "down" | "both";
  // 按级数的样式配置：index 0 为根节点（一级），依次向深层级递增，超出配置长度时套用最后一项。
  // 节点数据上的 style 优先于级数配置；新建节点（Tab/Enter）按其级数取样式
  levelStyles?: Style[];
  // 布局间距：levelGap 父子间距（横向布局为水平间距、纵向为垂直间距），
  // siblingGap 兄弟间距（横向布局为垂直间距、纵向为水平间距），默认 48 / 12。
  // init 初始布局与 relayout 重布局共用同一份配置，避免两处硬编码漂移
  levelGap?: number;
  siblingGap?: number;
  // 数据变化回调：结构变化（新增/删除/拖拽换父/折叠切换/方向与连线样式）在重布局
  // 落定后触发；文本编辑在每次输入（重布局落定后）与编辑会话结束时各触发一次，
  // 宿主可据此做实时保存；undo/redo 以回退的变更类型触发（不产生新变更）。
  // 当前数据用 toJSON() 导出
  onChange?: (type: MindMapChangeType) => void;
  // 连线样式：'bezier' 单段贝塞尔 S 曲线（默认），'path' 父级水平直线引出 + Z 字折线接入，
  // 'rPath' 同 path 但第二个弯折带圆角
  edgeStyle?: EdgeShape;
  // 额外装配的插件（在官方布局插件之后、初始数据 init 之前安装）：第三方布局插件
  // 经此注册同名 mindmap.auto-layout 能力覆盖官方实现，初始布局即可生效
  plugins?: Plugin[];
  // AI 编辑生成适配器（AIEditingPlugin 依赖）：宿主实现——拿到 AIEditRequest
  // （用户指令 + 带 id 的树快照 + 锚点/选中上下文）后调自家 LLM，返回操作数组
  // 或其 JSON 字符串。协议与提示词模板见 ai.ts（defaultAIEditPrompt）；
  // 未配置时 mindmap.ai.run 报"未配置适配器"
  ai?: AIEditGenerate;
  // 初始化失败出口：init（建树/布局/挂载）为构造期异步流程，失败时经此通知宿主
  //（缺省仅 console.error；未配置时宿主无法感知初始化失败）
  onError?: (error: unknown) => void;
}

// 数据变化类型：新增节点 / 删除节点 / 拖拽换父 / 文本编辑结束 / 折叠切换 / 布局方向切换 / 连线样式切换 / AI 编辑
export type MindMapChangeType =
  | "add"
  | "delete"
  | "move"
  | "text"
  | "collapse"
  | "layout"
  | "edge"
  | "ai";

export type LayoutDirection = NonNullable<MindMapOptions["direction"]>;

// 布局方向的共享状态引用：门面创建单一实例并按引用分发给模型与各交互控制器，
// 各方运行时读取同一份值——方向切换只改这一处状态，各模块不再持有方向副本，
// 也无需逐个调用 setDirection 同步
export type LayoutDirectionRef = { value: LayoutDirection };

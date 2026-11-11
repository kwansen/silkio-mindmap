import type { EdgeShape } from "@silker/core";
import type { LayoutDirection, MindMapNode, Style } from "./types";

// 历史命令序列化载荷的单一类型源：commands.ts（生产端 toJSON）、history-codec.ts
//（消费端 decode）、ai.ts（history 描述读取）共享同一形状定义，编译期锁定 wire
// 格式，杜绝三处手写漂移。字段语义见各命令工厂的 toJSON 注释。
// id 字段为 string | null：与运行时 Text/连线的可空 id 如实对齐（命令只在
// serializeForHistory 已自动捕获 id 的节点上构造，运行时恒有值；消费端 decode
// 对 null 按"解析失败返回 null 整体放弃导入"处理）。

export interface AddPayload {
  parentId: string | null;
  index: number;
  edgeId: string | null;
  node: MindMapNode;
}

export interface PasteInsertPayload {
  parentId: string | null;
  index: number;
  node: MindMapNode;
  edgeId: string | null;
  innerEdgeIds: Array<string | null>;
}

export interface PastePayload {
  inserts: PasteInsertPayload[];
}

export interface DeleteCapturePayload {
  parentId: string | null;
  index: number;
  node: MindMapNode;
}

export interface DeleteDeadEdgePayload {
  id: string | null;
  fromId: string | null;
  toId: string | null;
}

export interface DeletePayload {
  captures: DeleteCapturePayload[];
  // 待清理连线按端点 id 引用（mindmap 连线严格父→子一对一，端点二元组唯一标识一条边）
  dead: DeleteDeadEdgePayload[];
}

export interface MoveEntryPayload {
  nodeId: string | null;
  oldParentId: string | null;
  oldIndex: number;
  newParentId: string | null;
  newIndex: number;
  oldStyle: Style;
  newStyle: Style;
  oldEdgeId: string | null;
  newEdgeId: string | null;
}

export interface MovePayload {
  moves: MoveEntryPayload[];
}

export interface TextPayload {
  nodeId: string | null;
  before: string;
  after: string;
}

export interface LayoutPayload {
  before: LayoutDirection;
  after: LayoutDirection;
}

export interface EdgePayload {
  before: EdgeShape;
  after: EdgeShape;
}

// render（AI 整树替换）单侧载荷：整树定格快照 + collectEdges 深度先序配对的连线 id
export interface RenderSidePayload {
  root: MindMapNode;
  edgeIds: Array<string | null>;
}

export interface RenderPayload {
  before: RenderSidePayload;
  after: RenderSidePayload;
}

// mindmap 各命令 toJSON 的返回类型：kind 与 payload 形状编译期绑定，
// 生产端形状漂移在赋值处即报错
export type MindmapSerialized =
  | { kind: "mindmap.add"; payload: AddPayload }
  | { kind: "mindmap.paste"; payload: PastePayload }
  | { kind: "mindmap.delete"; payload: DeletePayload }
  | { kind: "mindmap.move"; payload: MovePayload }
  | { kind: "mindmap.text"; payload: TextPayload }
  | { kind: "mindmap.layout"; payload: LayoutPayload }
  | { kind: "mindmap.edge"; payload: EdgePayload }
  | { kind: "mindmap.render"; payload: RenderPayload };

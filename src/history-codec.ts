// 历史命令编解码器：把 mindmap 各命令的序列化载荷（kind + 纯数据）重建为可执行的
// HistoryCommand。只依赖 core 契约与自有模型，不依赖 plugin-*（check-deps 分层约束）。
//
// 引用解析规则（与导出载荷一一对应）：
// - 节点按 id 解析：先查树上（nodeById），再查会话注册表；查不到且载荷内嵌了
//   子树数据（add/paste/delete 的 node 字段）时经 renderNode(data, 0, true) 重建
//   并登记整个子树的 id（保证跨命令引用同一实例）。
// - 连线按 id 解析：先查模型连线表，再查会话注册表；查不到时按 (fromId,toId)
//   端点重建（createEdge）并回写原 id。重建发生在 revive 阶段而非 redo 执行时，
//   同一连线的 redo/undo 共用同一对象，重放不会重复创建。
//
// 复合命令（core 的 composite kind）在此解码为 compose(...)，子命令递归走本解码器。
// 解码失败的命令返回 null：importJSON 收到 null 即整体放弃导入且不改动栈。
import { compose } from "@silker/core";
import type { App, HistoryCommand, SerializedCommand, Text } from "@silker/core";
import type { MindEdge } from "./Edge";
import type { MindTree } from "./model";
import type { MindMapNode, Style } from "./types";

export interface MindmapCodecDeps {
  model: MindTree;
  app: App;
}

// 会话注册表：一次 importHistory 的引用解析上下文（codec 实例即会话，
// 每次 importHistory 新建）
interface MindmapImportSession {
  nodes: Map<string, Text>;
  edges: Map<string, MindEdge>;
}

// 各 kind 的载荷形状（与 operations.ts / editing.ts / drag.ts 的 toJSON 一一对应）
interface AddPayload {
  parentId: string;
  index: number;
  edgeId: string;
  node: MindMapNode;
}
interface PastePayload {
  inserts: Array<{
    parentId: string;
    index: number;
    node: MindMapNode;
    edgeId: string;
    innerEdgeIds: string[];
  }>;
}
interface DeletePayload {
  captures: Array<{ parentId: string; index: number; node: MindMapNode }>;
  dead: Array<{ id: string; fromId: string; toId: string }>;
}
interface MovePayload {
  moves: Array<{
    nodeId: string;
    oldParentId: string;
    oldIndex: number;
    newParentId: string;
    newIndex: number;
    oldStyle: Style;
    newStyle: Style;
    oldEdgeId: string;
    newEdgeId: string;
  }>;
}
interface TextPayload {
  nodeId: string;
  before: string;
  after: string;
}

// 创建编解码器：decode 把 SerializedCommand 重建为 HistoryCommand（失败返回 null）
export function createMindmapCodec(deps: MindmapCodecDeps) {
  const { model, app } = deps;
  // 会话注册表：树上查不到的节点/连线对象在此登记，跨命令按 id 去重
  const nodes = new Map<string, Text>();
  const edges = new Map<string, MindEdge>();

  // 节点解析：树上 → 注册表；都没有且调用方提供内嵌数据则重建并登记整个子树
  function resolveNode(id: string): Text | null {
    return model.nodeById(id) ?? nodes.get(id) ?? null;
  }

  // 把节点子树的全部 id 登记进注册表（renderNode 重建后子树结构已完整）
  function registerSubtree(node: Text) {
    nodes.set(node.id!, node);
    node.children.forEach((c) => registerSubtree(c as Text));
  }

  // 由内嵌数据重建节点（不存在才创建；styleAsDefault 使显式样式只进 nodeStyles 缓存）
  function ensureNode(data: MindMapNode): Text | null {
    if (!data.id) return model.renderNode(data, 0, true);
    const existing = resolveNode(data.id);
    if (existing) return existing;
    const node = model.renderNode(data, 0, true);
    registerSubtree(node);
    return node;
  }

  // 连线解析：模型连线表 → 注册表；都没有则按端点重建并回写原 id
  function resolveEdge(id: string, fromId: string, toId: string): MindEdge | null {
    const live = model.edges.find((e) => e.id === id);
    if (live) return live;
    const cached = edges.get(id);
    if (cached) return cached;
    const from = resolveNode(fromId);
    const to = resolveNode(toId);
    if (!from || !to) return null;
    const edge = model.createEdge(from, to);
    edge.id = id;
    edges.set(id, edge);
    return edge;
  }

  // 按内嵌数据重建节点（add/paste/delete 共用）：失败返回 null
  function reviveNode(data: MindMapNode): Text | null {
    const node = ensureNode(data);
    return node;
  }

  // decode：按 kind 分发到各重建器，未知 kind 返回 null
  function decode(s: SerializedCommand): HistoryCommand | null {
    switch (s.kind) {
      case "composite": {
        const p = s.payload as { type?: string; children: SerializedCommand[] };
        const children = p.children.map(decode);
        if (children.some((c) => !c)) return null;
        return compose(p.type, ...children as HistoryCommand[]);
      }
      case "mindmap.add":
        return decodeAdd(s.payload as AddPayload);
      case "mindmap.paste":
        return decodePaste(s.payload as PastePayload);
      case "mindmap.delete":
        return decodeDelete(s.payload as DeletePayload);
      case "mindmap.move":
        return decodeMove(s.payload as MovePayload);
      case "mindmap.text":
        return decodeText(s.payload as TextPayload);
      default:
        return null;
    }
  }

  function decodeAdd(p: AddPayload): HistoryCommand | null {
    const parent = resolveNode(p.parentId);
    const node = reviveNode(p.node);
    if (!parent || !node) return null;
    const edge = resolveEdge(p.edgeId, p.parentId, node.id!);
    if (!edge) return null;
    return {
      type: "add",
      redo: () => {
        parent.attachChild(node, p.index);
        app.add(edge);
        model.edges.push(edge);
      },
      undo: () => {
        parent.detachChild(node);
        model.edges = model.edges.filter((e) => e !== edge);
        app.remove(edge);
      },
      // 重建命令的 toJSON 透传原始载荷：导入后再导出保持数据稳定
      toJSON: () => ({ kind: "mindmap.add", payload: p }),
    };
  }

  function decodePaste(p: PastePayload): HistoryCommand | null {
    const inserts: Array<{
      parent: Text;
      node: Text;
      edge: MindEdge;
      inner: MindEdge[];
      index: number;
    }> = [];
    for (const ins of p.inserts) {
      const parent = resolveNode(ins.parentId);
      const node = reviveNode(ins.node);
      if (!parent || !node) return null;
      const edge = resolveEdge(ins.edgeId, ins.parentId, node.id!);
      if (!edge) return null;
      // 内部连线按 collectEdges 的深度先序与 innerEdgeIds 一一配对
      const pairs: Array<[Text, Text]> = [];
      const walk = (parent2: Text) => {
        parent2.children.forEach((c) => {
          pairs.push([parent2, c as Text]);
          walk(c as Text);
        });
      };
      walk(node);
      const inner: MindEdge[] = [];
      for (let i = 0; i < pairs.length; i++) {
        const [f, t] = pairs[i];
        const e = resolveEdge(ins.innerEdgeIds[i], f.id!, t.id!);
        if (!e) return null;
        inner.push(e);
      }
      inserts.push({ parent, node, edge, inner, index: ins.index });
    }
    return {
      type: "add",
      redo: () => {
        inserts.forEach(({ parent, node, edge, inner, index }) => {
          parent.attachChild(node, index);
          app.add(edge);
          app.add(inner);
          model.edges.push(edge, ...inner);
        });
      },
      undo: () => {
        for (let i = inserts.length - 1; i >= 0; i--) {
          const { parent, node, edge, inner } = inserts[i];
          parent.detachChild(node);
          const removed = [edge, ...inner];
          model.edges = model.edges.filter((e) => !removed.includes(e));
          removed.forEach((e2) => app.remove(e2));
        }
      },
      toJSON: () => ({ kind: "mindmap.paste", payload: p }),
    };
  }

  function decodeDelete(p: DeletePayload): HistoryCommand | null {
    const captures: Array<{ node: Text; parent: Text; index: number }> = [];
    for (const c of p.captures) {
      const parent = resolveNode(c.parentId);
      const node = reviveNode(c.node);
      if (!parent || !node) return null;
      captures.push({ node, parent, index: c.index });
    }
    const dead: MindEdge[] = [];
    for (const d of p.dead) {
      const edge = resolveEdge(d.id, d.fromId, d.toId);
      if (!edge) return null;
      dead.push(edge);
    }
    return {
      type: "delete",
      redo: () => {
        captures.forEach(({ node, parent }) => parent.remove(node));
        model.edges = model.edges.filter((e) => !dead.includes(e));
        dead.forEach((e) => app.remove(e));
      },
      undo: () => {
        for (let i = captures.length - 1; i >= 0; i--) {
          const { node, parent, index } = captures[i];
          parent.attachChild(node, index);
        }
        dead.forEach((e) => {
          model.edges.push(e);
          app.add(e);
        });
      },
      toJSON: () => ({ kind: "mindmap.delete", payload: p }),
    };
  }

  function decodeMove(p: MovePayload): HistoryCommand | null {
    const moves: Array<{
      node: Text;
      oldParent: Text;
      newParent: Text;
      oldIndex: number;
      newIndex: number;
      oldStyle: Style;
      newStyle: Style;
      oldEdge: MindEdge;
      newEdge: MindEdge;
    }> = [];
    for (const m of p.moves) {
      const node = resolveNode(m.nodeId);
      const oldParent = resolveNode(m.oldParentId);
      const newParent = resolveNode(m.newParentId);
      if (!node || !oldParent || !newParent) return null;
      const oldEdge = resolveEdge(m.oldEdgeId, m.oldParentId, m.nodeId);
      const newEdge = resolveEdge(m.newEdgeId, m.newParentId, m.nodeId);
      if (!oldEdge || !newEdge) return null;
      moves.push({
        node,
        oldParent,
        newParent,
        oldIndex: m.oldIndex,
        newIndex: m.newIndex,
        oldStyle: m.oldStyle,
        newStyle: m.newStyle,
        oldEdge,
        newEdge,
      });
    }
    return {
      type: "move",
      redo: () => {
        for (const m of moves) {
          m.oldParent.remove(m.node);
          m.newParent.attachChild(m.node, m.newIndex);
          model.edges = model.edges.filter((e) => e !== m.oldEdge);
          app.remove(m.oldEdge);
          model.edges.push(m.newEdge);
          app.add(m.newEdge);
          if (model.levelStyles.length) model.applyNodeStyle(m.node, m.newStyle);
        }
      },
      undo: () => {
        for (const m of [...moves].reverse()) {
          m.newParent.remove(m.node);
          m.oldParent.attachChild(m.node, m.oldIndex);
          model.edges = model.edges.filter((e) => e !== m.newEdge);
          app.remove(m.newEdge);
          model.edges.push(m.oldEdge);
          app.add(m.oldEdge);
          model.applyNodeStyle(m.node, m.oldStyle);
        }
      },
      toJSON: () => ({ kind: "mindmap.move", payload: p }),
    };
  }

  function decodeText(p: TextPayload): HistoryCommand | null {
    const node = resolveNode(p.nodeId);
    if (!node) return null;
    return {
      type: "text",
      redo: () => {
        node.text = p.after;
      },
      undo: () => {
        node.text = p.before;
      },
      toJSON: () => ({ kind: "mindmap.text", payload: p }),
    };
  }

  return { decode };
}

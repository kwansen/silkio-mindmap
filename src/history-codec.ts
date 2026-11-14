// 历史命令编解码器：把 mindmap 各命令的序列化载荷（kind + 纯数据）重建为可执行的
// HistoryCommand。只依赖 core 契约与自有模型，不依赖 plugin-*（check-deps 分层约束）。
//
// 引用解析规则（与导出载荷一一对应）：
// - 节点按 id 解析：先查会话注册表，再查树上（nodeById）；查不到且载荷内嵌了
//   子树数据（add/paste/delete 的 node 字段）时经 renderNode(data, 0, true) 重建
//   并登记整个子树的 id（保证跨命令引用同一实例）。
// - 连线按 id 解析：先查模型连线表，再查会话注册表（命中须端点与解析出的
//   from/to 一致）；不一致或查不到时按 (fromId,toId) 端点重建（createEdge）并
//   回写原 id。重建发生在 revive 阶段而非 redo 执行时，
//   同一连线的 redo/undo 共用同一对象，重放不会重复创建。
//
// 复合命令（core 的 composite kind）在此解码为 compose(...)，子命令递归走本解码器。
// 解码失败的命令返回 null：importJSON 收到 null 即整体放弃导入且不改动栈。
import { compose } from "@silkor/core";
import type { App, EdgeShape, HistoryCommand, SerializedCommand, Text } from "@silkor/core";
import {
  makeAddCommand,
  makeDeleteCommand,
  makeMoveCommand,
  makePasteCommand,
  makeRenderCommand,
  makeTextCommand,
} from "./commands";
import type { MindEdge } from "./Edge";
import type { MindTree } from "./model";
import type { LayoutDirection, MindMapNode, Style } from "./types";
import type {
  AddPayload,
  DeletePayload,
  EdgePayload,
  LayoutPayload,
  MovePayload,
  PastePayload,
  RenderPayload,
  RenderSidePayload,
  TextPayload,
} from "./history-payloads";

export interface MindmapCodecDeps {
  model: MindTree;
  app: App;
  // 布局方向命令重建入口：恢复门面/模型/各控制器方向状态（MindMap.applyDirection）
  onDirection: (direction: LayoutDirection) => void;
  // 挂载节点登记点击激活：编解码器重建的节点不经 app.add 包装，redo/undo 挂载时
  // 经命令工厂的 bindNode 统一登记（见 commands.ts），漏登记即无法点击激活
  bindNode: (node: Text) => void;
}

// 会话注册表：一次 importHistory 的引用解析上下文（codec 实例即会话，
// 每次 importHistory 新建）
interface MindmapImportSession {
  nodes: Map<string, Text>;
  edges: Map<string, MindEdge>;
}

// render（AI 整树替换）单侧载荷别名（形状即 history-payloads 的 RenderSidePayload）
type RenderSide = RenderSidePayload;

// 创建编解码器：decode 把 SerializedCommand 重建为 HistoryCommand（失败返回 null）
export function createMindmapCodec(deps: MindmapCodecDeps) {
  const { model, app, bindNode } = deps;
  // 会话注册表：树上查不到的节点/连线对象在此登记，跨命令按 id 去重
  const nodes = new Map<string, Text>();
  const edges = new Map<string, MindEdge>();

  // 节点解析：注册表 → 树上。注册表优先：render（AI 整树替换）会为与现存树
  // 相同的 id 登记全新的轨迹实例（前后树复用 id 表达不同实例），按解码轨迹
  // "后注册者胜出"才能让后续命令绑定到正确一侧的实例；无 render 的栈里
  // 注册表只含树上查不到的 id（ensureNode 仅在树上缺失时登记），两序等价。
  // 载荷 id 可空（与运行时 Text.id 对齐），null 视为解析失败返回 null，
  // 由调用方整体放弃导入
  // 树索引快照（惰性建）：首次树查找建一次 O(n) 快照，后续复用——大栈导入
  // 时多次 miss 不再逐次全树遍历。解码只解析不执行命令，树结构在整个
  // 会话内不变，快照始终有效
  let treeIndex: Map<string, Text> | null = null;
  function resolveNode(id: string | null | undefined): Text | null {
    if (!id) return null;
    const hit = nodes.get(id);
    if (hit) return hit;
    treeIndex ??= model.indexById();
    return treeIndex.get(id) ?? null;
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

  // 连线解析：模型连线表 → 注册表（命中须端点一致）→ 按 (fromId,toId) 端点重建
  // 并回写原 id（载荷 id 可空，null 视为解析失败返回 null，由调用方整体放弃导入）。
  // 端点一致性校验：解码会话可能为同一 id 重建了全新节点实例（如 render 的 after
  // 侧总是全新重建并覆盖登记），现存连线/注册表连线仍指向重建前的旧实例——此时
  // 直接复用会让命令重放的连线端点与同批重建的节点实例脱节（连线锚点跟随不在
  // 场景树内的旧节点），故按解析出的端点重建并覆盖注册
  function resolveEdge(
    id: string | null | undefined,
    fromId: string | null | undefined,
    toId: string | null | undefined,
  ): MindEdge | null {
    if (!id) return null;
    const from = resolveNode(fromId);
    const to = resolveNode(toId);
    const live = model.edges.find(
      (e) => e.id === id && e.fromNode === from && e.toNode === to,
    );
    if (live) return live;
    const cached = edges.get(id);
    if (cached && cached.fromNode === from && cached.toNode === to) return cached;
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
      case "mindmap.layout":
        return decodeLayout(s.payload as LayoutPayload);
      case "mindmap.edge":
        return decodeEdge(s.payload as EdgePayload);
      case "mindmap.render":
        return decodeRender(s.payload as RenderPayload);
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
    // redo/undo 复用命令工厂；重建命令的 toJSON 透传原始载荷：导入后再导出保持数据稳定
    const cmd = makeAddCommand({ app, model, bindNode }, { parent, node, index: p.index, edge });
    cmd.toJSON = () => ({ kind: "mindmap.add", payload: p });
    return cmd;
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
    // redo/undo 复用命令工厂；重建命令的 toJSON 透传原始载荷：导入后再导出保持数据稳定
    const cmd = makePasteCommand({ app, model, bindNode }, inserts);
    cmd.toJSON = () => ({ kind: "mindmap.paste", payload: p });
    return cmd;
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
    // redo/undo 复用命令工厂（dead 显式传入：按载荷 id 解析的连线对象须跨
    // redo/undo 共用同一实例，不做重算）；toJSON 透传原始载荷保持数据稳定
    const cmd = makeDeleteCommand({ app, model, bindNode }, captures, dead);
    cmd.toJSON = () => ({ kind: "mindmap.delete", payload: p });
    return cmd;
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
    // redo/undo 复用命令工厂（同连线对象时工厂跳过换线，净状态与逐条换接等价）；
    // toJSON 透传原始载荷：导入后再导出保持数据稳定
    const cmd = makeMoveCommand({ app, model, bindNode }, moves);
    cmd.toJSON = () => ({ kind: "mindmap.move", payload: p });
    return cmd;
  }

  function decodeText(p: TextPayload): HistoryCommand | null {
    const node = resolveNode(p.nodeId);
    if (!node) return null;
    // redo/undo 复用命令工厂；toJSON 透传原始载荷：导入后再导出保持数据稳定
    const cmd = makeTextCommand(node, p.before, p.after);
    cmd.toJSON = () => ({ kind: "mindmap.text", payload: p });
    return cmd;
  }

  // 布局方向命令：纯方向快照，无对象引用，恢复门面方向状态后由 undo/redo 流程统一重布局。
  // 载荷方向非法（脏数据）时返回 null 整体放弃导入
  function decodeLayout(p: LayoutPayload): HistoryCommand | null {
    const dirs: LayoutDirection[] = ["left", "right", "down", "both"];
    if (!dirs.includes(p.before) || !dirs.includes(p.after)) return null;
    return {
      type: "layout",
      redo: () => deps.onDirection(p.after),
      undo: () => deps.onDirection(p.before),
      // 重建命令的 toJSON 透传原始载荷：导入后再导出保持数据稳定
      toJSON: () => ({ kind: "mindmap.layout", payload: p }),
    };
  }

  // 连线样式命令：按当前连线表重建为载荷样式（setEdgeStyle 继承纵向标志/可见性并
  // 沿用原连线 id，跨命令按 id 解析的引用保持一致）；场景换入换出经 replaceEdges
  // 原语统一收口（见 model.ts）。样式未变化时 setEdgeStyle 返回 null 直接跳过
  //（正常导入纪律下 undo/redo 交替执行不会命中）
  function decodeEdge(p: EdgePayload): HistoryCommand {
    const apply = (shape: EdgeShape) => {
      model.setEdgeStyle(shape);
    };
    return {
      type: "edge",
      redo: () => apply(p.after),
      undo: () => apply(p.before),
      // 重建命令的 toJSON 透传原始载荷：导入后再导出保持数据稳定
      toJSON: () => ({ kind: "mindmap.edge", payload: p }),
    };
  }

  // render（AI 整树替换）单侧整树重建：before 侧优先复用注册表实例（此前命令已为
  // 同一轨迹位置登记的实例，如前一轮 render 的 after 侧），after 侧总是按数据全新
  // 重建并覆盖登记——前后树复用同一 id 表达不同实例，after 侧若复用 before 侧实例
  // 会丢失结构差异。两侧都刻意不走树上解析——解码时树上是最终态（render 之后的
  // 世界），直接复用会错绑。连线按 collectEdges 深度先序与 edgeIds 配对（对齐
  // decodePaste 的内连线纪律），配对数不符返回 null 整体放弃导入
  function decodeRenderSide(
    side: RenderSide,
    alwaysFresh: boolean,
  ): { root: Text; edges: MindEdge[] } | null {
    if (!side.root.id) return null;
    let treeRoot = alwaysFresh ? null : (nodes.get(side.root.id) ?? null);
    if (!treeRoot) {
      treeRoot = model.renderNode(side.root, 0, true);
      registerSubtree(treeRoot);
    }
    const pairs: Array<[Text, Text]> = [];
    const walk = (parent: Text) => {
      parent.children.forEach((c) => {
        pairs.push([parent, c as Text]);
        walk(c as Text);
      });
    };
    walk(treeRoot);
    if (pairs.length !== side.edgeIds.length) return null;
    const out: MindEdge[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const [f, t] = pairs[i];
      const e = resolveEdge(side.edgeIds[i], f.id!, t.id!);
      if (!e) return null;
      out.push(e);
    }
    return { root: treeRoot, edges: out };
  }

  // render 整树替换命令：redo 把 after 侧整树换入场景并接管 model.root/edges，
  // undo 换回 before 侧。双侧实例在解码期重建并登记（after 侧后注册，覆盖与
  // before 侧重复的 id），后续命令按注册表解析即绑定到正确一侧
  function decodeRender(p: RenderPayload): HistoryCommand | null {
    const before = decodeRenderSide(p.before, false);
    const after = decodeRenderSide(p.after, true);
    if (!before || !after) return null;
    // redo/undo 复用命令工厂；toJSON 透传原始载荷：导入后再导出保持数据稳定
    const cmd = makeRenderCommand({ app, model, bindNode }, before, after);
    cmd.toJSON = () => ({ kind: "mindmap.render", payload: p });
    return cmd;
  }

  return { decode };
}

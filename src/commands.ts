import type { App, HistoryCommand, Node, Text } from "@silker/core";
import { invariant } from "./invariants";
import type { MindEdge } from "./Edge";
import type { MindTree } from "./model";
import type { Style } from "./types";
import type {
  AddPayload,
  DeletePayload,
  MindmapSerialized,
  MovePayload,
  PastePayload,
  RenderPayload,
  TextPayload,
} from "./history-payloads";

// 思维导图历史命令工厂：add/paste/delete/move/text/render 六类命令的 redo/undo/toJSON
// 统一在此构造，operations / ai / drag / history-codec 各生产方共用同一形状，避免命令
// 闭包多处手写漂移。
// 结构纪律（单一出处，生产方不得绕开）：
// - 连线表与场景的同步一律经 model 的 mountEdges/unmountEdges/replaceEdges 原语，
//   命令闭包不再手工双写 model.edges 与 app.add/remove；
// - redo/undo 中挂载的节点一律经 deps.bindNode 登记点击激活（编解码器重建的节点
//   无其它绑定入口，漏登记即无法点击激活）；
// - toJSON 载荷形状由 history-payloads.ts 编译期锁定（MindmapSerialized）。
// - 上述纪律经 invariants.ts 断言兜底：redo/undo 的挂载/摘除对称、节点当前父级与
//   命令定格一致、连线表成员合法——违例即抛错，不再静默腐蚀历史重放。
// 编解码器重建命令时以原始载荷覆写 toJSON（透传保持"导入后再导出"数据稳定，
// 见 history-codec.ts 各 decode* 注释）。

export interface CommandDeps {
  app: Pick<App, "add" | "remove">;
  model: Pick<
    MindTree,
    | "root"
    | "edges"
    | "levelStyles"
    | "serializeForHistory"
    | "applyNodeStyle"
    | "mountEdges"
    | "unmountEdges"
    | "replaceEdges"
  >;
  // 挂载节点登记点击激活（幂等）：手动路径由门面注入 editor.bind 的去重包装；
  // 编解码器路径必传——重建节点不经 app.add 包装，漏登记即无法点击激活。
  // 缺省（如测试桩）时挂载不登记
  bindNode?: (node: Text) => void;
}

// 新增单节点命令（kind: mindmap.add）：Tab/Enter 新建、外部文本新建共用。
// redo/undo 对称地挂载/摘除子节点与父子连线（结构重放走静默原语，不产生中间事件）
export function makeAddCommand(
  deps: CommandDeps,
  ins: { parent: Text; node: Text; index: number; edge: MindEdge },
): HistoryCommand {
  return {
    type: "add",
    redo: () => {
      invariant(
        !ins.parent.children.includes(ins.node),
        "add.redo: 节点已挂在父级下（重复执行 redo 或结构被绕开命令改动）",
      );
      ins.parent.attachChild(ins.node, ins.index);
      deps.model.mountEdges([ins.edge]);
      deps.bindNode?.(ins.node);
    },
    undo: () => {
      invariant(
        ins.parent.children.includes(ins.node),
        "add.undo: 节点不在父级下（重复执行 undo 或结构被绕开命令改动）",
      );
      ins.parent.detachChild(ins.node);
      deps.model.unmountEdges([ins.edge]);
    },
    // 序列化载荷：node 定格完整子树数据（含生效样式与 id），父级与连线按 id 引用
    toJSON: (): MindmapSerialized => ({
      kind: "mindmap.add",
      payload: {
        parentId: ins.parent.id,
        index: ins.index,
        edgeId: ins.edge.id,
        node: deps.model.serializeForHistory(ins.node),
      } satisfies AddPayload,
    }),
  };
}

// 批量新增命令（kind: mindmap.paste）：粘贴与 AI add 共用。多插入点 + 内嵌子树连线，
// redo 顺序挂载、undo 逆序摘除（前序摘除不影响后序兄弟索引）
export interface PasteInsert {
  parent: Text;
  node: Text;
  edge: MindEdge;
  inner: MindEdge[];
  index: number;
}

export function makePasteCommand(
  deps: CommandDeps,
  inserts: PasteInsert[],
): HistoryCommand {
  return {
    type: "add",
    redo: () => {
      inserts.forEach(({ parent, node, edge, inner, index }) => {
        invariant(
          !parent.children.includes(node),
          "paste.redo: 节点已挂在父级下（重复执行 redo 或结构被绕开命令改动）",
        );
        parent.attachChild(node, index);
        deps.model.mountEdges([edge, ...inner]);
        deps.bindNode?.(node);
      });
    },
    undo: () => {
      for (let i = inserts.length - 1; i >= 0; i--) {
        const { parent, node, edge, inner } = inserts[i];
        invariant(
          parent.children.includes(node),
          "paste.undo: 节点不在父级下（重复执行 undo 或结构被绕开命令改动）",
        );
        parent.detachChild(node);
        deps.model.unmountEdges([edge, ...inner]);
      }
    },
    // 序列化载荷：插入子树内嵌数据（含生效样式与 id），连线按 id 引用；
    // innerEdgeIds 顺序与 collectEdges 深度先序一致，编解码器按同序重建连线
    toJSON: (): MindmapSerialized => ({
      kind: "mindmap.paste",
      payload: {
        inserts: inserts.map(({ parent, node, edge, inner, index }) => ({
          parentId: parent.id,
          index,
          node: deps.model.serializeForHistory(node),
          edgeId: edge.id,
          innerEdgeIds: inner.map((e) => e.id),
        })),
      } satisfies PastePayload,
    }),
  };
}

// 删除命令（kind: mindmap.delete）：手动删除、AI delete、编解码器共用。
// 摘除各目标子树并清理端点在子树内的连线。dead 缺省时在 redo 首帧按当时树状态
// 定格死连线（AI 批内编译：编译期树未变，前序 move 尚未执行，届时收集会把
// "即将被移出子树的节点"的连线误判为死连线）；显式传入时沿用不重算——
// 手动删除编译期树未变两序等价；编解码器按载荷 id 解析的连线对象须跨 redo/undo
// 共用同一实例。exec 先于任何 toJSON 调用，惰性定格不影响载荷完整性
export interface DeleteCapture {
  node: Text;
  parent: Text;
  index: number;
}

export function makeDeleteCommand(
  deps: CommandDeps,
  captures: DeleteCapture[],
  dead?: MindEdge[],
): HistoryCommand {
  let deadEdges: MindEdge[] | null = dead ?? null;
  const computeDead = () => {
    const subtree = new Set<Node>();
    const collect = (n: Node) => {
      subtree.add(n);
      n.children.forEach(collect);
    };
    captures.forEach(({ node }) => collect(node));
    return deps.model.edges.filter(
      (e) => subtree.has(e.fromNode) || subtree.has(e.toNode),
    );
  };
  return {
    type: "delete",
    redo: () => {
      const dead = deadEdges ?? computeDead();
      deadEdges = dead;
      captures.forEach(({ node, parent }) => {
        // 惰性定格死连线依赖"exec 立即执行 redo 且编译期结构未变"：节点当前父级
        // 若与定格父级不一致（如同批内已移动该节点），死连线计算与摘除都会失真
        invariant(
          (node.parent as Text | null) === parent,
          "delete.redo: 节点当前父级与命令定格父级不一致（同批内移动后再删除等时序破坏）",
        );
        parent.remove(node);
      });
      deps.model.unmountEdges(dead);
    },
    undo: () => {
      // 逆序插回：同父多目标按索引从大到小还原，前序插入不影响后序索引
      for (let i = captures.length - 1; i >= 0; i--) {
        const { node, parent, index } = captures[i];
        invariant(
          !parent.children.includes(node),
          "delete.undo: 节点仍在父级下（重复执行 undo 或结构被绕开命令改动）",
        );
        parent.attachChild(node, index);
      }
      const dead = deadEdges ?? [];
      deps.model.mountEdges(dead);
      captures.forEach(({ node }) => deps.bindNode?.(node));
    },
    // 序列化载荷：被删节点脱离树，内嵌完整子树数据；待清理连线按端点 id 引用
    toJSON: (): MindmapSerialized => ({
      kind: "mindmap.delete",
      payload: {
        captures: captures.map(({ node, parent, index }) => ({
          parentId: parent.id,
          index,
          node: deps.model.serializeForHistory(node),
        })),
        dead: (deadEdges ?? []).map((e) => ({
          id: e.id,
          fromId: e.fromNode.id,
          toId: e.toNode.id,
        })),
      } satisfies DeletePayload,
    }),
  };
}

// 移动命令（kind: mindmap.move）：手动拖拽、AI move、编解码器共用。换父/同父排序
// + 连线换接 + 级数样式重设。多选目标合并为一条命令，undo 逆序回退；redo 中样式
// 应用仅在有级数配置时生效，undo 无条件还原 oldStyle（三条路径的原行为一致）
export interface MoveEntry {
  node: Text;
  oldParent: Text;
  oldIndex: number;
  newParent: Text;
  newIndex: number;
  oldStyle: Style;
  newStyle: Style;
  oldEdge: MindEdge;
  newEdge: MindEdge;
}

export function makeMoveCommand(
  deps: CommandDeps,
  moves: MoveEntry[],
): HistoryCommand {
  return {
    type: "move",
    redo: () => {
      for (const m of moves) {
        // 节点当前父级须与命令定格一致：同批内重复移动同一节点会让本命令的
        // oldParent 失真（undo 回到错误父级），编译期已拒绝，此处兜底校验
        invariant(
          (m.node.parent as Text | null) === m.oldParent,
          "move.redo: 节点当前父级与命令定格 oldParent 不一致（同批内重复移动等时序破坏）",
        );
        m.oldParent.remove(m.node);
        m.newParent.attachChild(m.node, m.newIndex);
        // 换线：移除旧父连线，加入新父连线（同父排序 newEdge === oldEdge 时跳过）
        if (m.newEdge !== m.oldEdge) {
          deps.model.unmountEdges([m.oldEdge]);
          deps.model.mountEdges([m.newEdge]);
        }
        if (deps.model.levelStyles.length)
          deps.model.applyNodeStyle(m.node, m.newStyle);
      }
    },
    undo: () => {
      for (const m of [...moves].reverse()) {
        invariant(
          (m.node.parent as Text | null) === m.newParent,
          "move.undo: 节点当前父级与命令定格 newParent 不一致（重复执行 undo 或结构被绕开命令改动）",
        );
        m.newParent.remove(m.node);
        m.oldParent.attachChild(m.node, m.oldIndex);
        // 换线反向：移除新父连线，还原旧父连线
        if (m.newEdge !== m.oldEdge) {
          deps.model.unmountEdges([m.newEdge]);
          deps.model.mountEdges([m.oldEdge]);
        }
        deps.model.applyNodeStyle(m.node, m.oldStyle);
      }
    },
    // 序列化载荷：节点/父级/连线全部按 id 引用（连线经会话注册表按 id 去重）
    toJSON: (): MindmapSerialized => ({
      kind: "mindmap.move",
      payload: {
        moves: moves.map((m) => ({
          nodeId: m.node.id,
          oldParentId: m.oldParent.id,
          oldIndex: m.oldIndex,
          newParentId: m.newParent.id,
          newIndex: m.newIndex,
          oldStyle: m.oldStyle,
          newStyle: m.newStyle,
          oldEdgeId: m.oldEdge.id,
          newEdgeId: m.newEdge.id,
        })),
      } satisfies MovePayload,
    }),
  };
}

// 文本命令（kind: mindmap.text）：编辑提交、AI edit、编解码器共用。
// before/after 为纯文本快照，节点按 id 引用
export function makeTextCommand(
  node: Text,
  before: string,
  after: string,
): HistoryCommand {
  return {
    type: "text",
    redo: () => {
      node.text = after;
    },
    undo: () => {
      node.text = before;
    },
    toJSON: (): MindmapSerialized => ({
      kind: "mindmap.text",
      payload: { nodeId: node.id, before, after } satisfies TextPayload,
    }),
  };
}

// AI 整树替换命令（kind: mindmap.render）：AI render、编解码器共用。
// 双侧整树对象以引用整体换入换出场景并接管 model.root/edges
export interface RenderSide {
  root: Text;
  edges: MindEdge[];
}

export function makeRenderCommand(
  deps: CommandDeps,
  before: RenderSide,
  after: RenderSide,
): HistoryCommand {
  const swapIn = (side: RenderSide) => {
    const prevRoot = deps.model.root!;
    deps.app.remove(prevRoot);
    deps.model.replaceEdges(side.edges);
    deps.model.root = side.root;
    deps.app.add(side.root);
    // 换入侧整树登记点击激活（bindNode 幂等去重；编解码器重建的双侧树无其它绑定入口）
    deps.bindNode?.(side.root);
  };
  return {
    type: "ai",
    redo: () => swapIn(after),
    undo: () => swapIn(before),
    // 序列化载荷：双侧整树定格快照 + collectEdges 深度先序配对的连线 id
    toJSON: (): MindmapSerialized => ({
      kind: "mindmap.render",
      payload: {
        before: {
          root: deps.model.serializeForHistory(before.root),
          edgeIds: before.edges.map((e) => e.id),
        },
        after: {
          root: deps.model.serializeForHistory(after.root),
          edgeIds: after.edges.map((e) => e.id),
        },
      } satisfies RenderPayload,
    }),
  };
}

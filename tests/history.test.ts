// 历史命令工厂与编解码器回归测试：六类命令的 redo/undo 对称重放、toJSON 载荷形状、
// 载荷往返（导出 → decode → 再导出数据一致）与解码后重放的结构自洽。
// Text 构造函数依赖 DOM（document/canvas 测量），node 环境下用最小 stub：
// Object.create(Text.prototype) 绕过构造器（attachChild/detachChild/remove 继承自
// Node.prototype，直接操作 _children）；MindTree.renderNode 在实例上替换为 stub 工厂
//（codec 重建路径只消费结构引用，样式缓存不参与断言）。
import { describe, expect, it } from "vitest";
import { Text } from "@silker/core";
import type { App, Node, SerializedCommand } from "@silker/core";
import { MindTree } from "../src/model";
import {
  makeAddCommand,
  makeDeleteCommand,
  makeMoveCommand,
  makePasteCommand,
  makeRenderCommand,
  makeTextCommand,
} from "../src/commands";
import type { CommandDeps, PasteInsert } from "../src/commands";
import { createMindmapCodec } from "../src/history-codec";
import type { MindEdge } from "../src/Edge";
import { defaultStyle } from "../src/types";
import type { LayoutDirection, MindMapNode, Style } from "../src/types";

type FT = Text & {
  id: string | null;
  text: string;
  collapsed: boolean;
  parent: Node | null;
  measure: () => void;
};

let nseq = 0;
const ft = (
  text: string,
  opts: { id?: string; collapsed?: boolean; children?: FT[] } = {},
): FT => {
  const n = Object.create(Text.prototype) as FT;
  n.id = opts.id ?? `n${++nseq}`;
  n.text = text;
  n.collapsed = opts.collapsed ?? false;
  n.visible = true;
  n.measure = () => {};
  // changeSubs 为构造期实例字段（remove/add 派发变更事件用）：绕过构造器需手动铺
  (n as unknown as { changeSubs: Set<unknown>; _children: Node[] }).changeSubs =
    new Set();
  (n as unknown as { _children: Node[] })._children = opts.children ?? [];
  n.parent = null;
  (opts.children ?? []).forEach((c) => (c.parent = n));
  return n;
};

let eseq = 0;
const mkEdge = (from: FT, to: FT): MindEdge =>
  ({
    id: `e${++eseq}`,
    fromNode: from as unknown as Text,
    toNode: to as unknown as Text,
    visible: true,
    vertical: false,
  }) as unknown as MindEdge;

const newModel = (root: FT, levelStyles: Style[] = []) => {
  const tree = new MindTree({ levelStyles, edgeStyle: "bezier" });
  tree.root = root as unknown as Text;
  // codec 的 renderNode 重建路径在实例上替换为最小 stub 工厂（绕过 DOM 测量）
  const build = (d: MindMapNode): FT =>
    ft(d.text, { id: d.id, collapsed: d.collapsed, children: d.children.map(build) });
  tree.renderNode = build as unknown as typeof tree.renderNode;
  return tree;
};

const depsFor = (tree: MindTree, bound: FT[] = []): CommandDeps => ({
  app: { add: () => {}, remove: () => {} },
  model: tree,
  bindNode: (n) => bound.push(n as unknown as FT),
});

const codecFor = (tree: MindTree, bound: FT[] = [], dirs: string[] = []) =>
  createMindmapCodec({
    model: tree,
    app: { add: () => {}, remove: () => {} } as unknown as App,
    onDirection: (d) => dirs.push(d),
    bindNode: (n) => bound.push(n as unknown as FT),
  });

const texts = (n: FT): string[] =>
  (n.children as unknown as FT[]).map((c) => c.text);

const sameEdges = (tree: MindTree, es: MindEdge[]) =>
  expect([...tree.edges].map((e) => e.id).sort()).toEqual(
    es.map((e) => e.id).sort(),
  );

describe("commands 工厂：redo/undo 对称重放", () => {
  it("add：redo 挂载子节点与连线并登记 bindNode，undo 对称摘除", () => {
    const a = ft("a", { id: "a" });
    const root = ft("root", { id: "root", children: [a] });
    const tree = newModel(root);
    tree.mountEdges([mkEdge(root, a)]);
    const n = ft("n", { id: "n" });
    const e2 = mkEdge(root, n);
    const bound: FT[] = [];
    const cmd = makeAddCommand(depsFor(tree, bound), {
      parent: root,
      node: n,
      index: 0,
      edge: e2,
    });
    cmd.redo();
    expect(texts(root)).toEqual(["n", "a"]);
    expect(tree.edges).toContain(e2);
    expect(bound).toEqual([n as unknown as Text]);
    cmd.undo();
    expect(texts(root)).toEqual(["a"]);
    expect(tree.edges).not.toContain(e2);
  });

  it("delete：redo 摘除子树并惰性清理死连线，undo 逆序插回还原原序与连线", () => {
    const g = ft("g", { id: "g" });
    const a = ft("a", { id: "a", children: [g] });
    const b = ft("b", { id: "b" });
    const c = ft("c", { id: "c" });
    const root = ft("root", { id: "root", children: [a, b, c] });
    const tree = newModel(root);
    const eRA = mkEdge(root, a);
    const eAG = mkEdge(a, g);
    const eRB = mkEdge(root, b);
    const eRC = mkEdge(root, c);
    tree.mountEdges([eRA, eAG, eRB, eRC]);
    const cmd = makeDeleteCommand(depsFor(tree), [
      { node: a, parent: root, index: 0 },
      { node: c, parent: root, index: 2 },
    ]);
    cmd.redo();
    expect(texts(root)).toEqual(["b"]);
    // 死连线在 redo 首帧按当时树状态惰性计算：子树端点关联的 eRA/eAG/eRC 全部清理
    sameEdges(tree, [eRB]);
    cmd.undo();
    // 逆序插回：同父多目标按索引从大到小还原
    expect(texts(root)).toEqual(["a", "b", "c"]);
    sameEdges(tree, [eRA, eAG, eRB, eRC]);
  });

  it("move：redo 换父换线并按级数重设样式，undo 逆序还原", () => {
    const s0: Style = { ...defaultStyle, fontSize: 24 };
    const s1: Style = { ...defaultStyle, fontSize: 18 };
    const a = ft("a", { id: "a" });
    const b = ft("b", { id: "b" });
    const root = ft("root", { id: "root", children: [a, b] });
    const tree = newModel(root, [s0, s1]);
    const eRA = mkEdge(root, a);
    const eRB = mkEdge(root, b);
    tree.mountEdges([eRA, eRB]);
    const eBA = mkEdge(b, a);
    const cmd = makeMoveCommand(depsFor(tree), [
      {
        node: a,
        oldParent: root,
        oldIndex: 0,
        newParent: b,
        newIndex: 0,
        oldStyle: s0,
        newStyle: s1,
        oldEdge: eRA,
        newEdge: eBA,
      },
    ]);
    cmd.redo();
    expect(texts(root)).toEqual(["b"]);
    expect(texts(b)).toEqual(["a"]);
    sameEdges(tree, [eRB, eBA]);
    expect(a.fontSize).toBe(18);
    cmd.undo();
    expect(texts(root)).toEqual(["a", "b"]);
    sameEdges(tree, [eRA, eRB]);
    expect(a.fontSize).toBe(24);
  });

  it("text：redo/undo 切换 before/after 文本", () => {
    const a = ft("a", { id: "a" });
    const cmd = makeTextCommand(a as unknown as Text, "x", "y");
    cmd.redo();
    expect(a.text).toBe("y");
    cmd.undo();
    expect(a.text).toBe("x");
  });

  it("paste：redo 顺序挂载多插入点与内嵌连线，undo 逆序摘除", () => {
    const a = ft("a", { id: "a" });
    const root = ft("root", { id: "root", children: [a] });
    const tree = newModel(root);
    const eRA = mkEdge(root, a);
    tree.mountEdges([eRA]);
    const n1c = ft("n1c", { id: "n1c" });
    const n1 = ft("n1", { id: "n1", children: [n1c] });
    const n2 = ft("n2", { id: "n2" });
    const inner1 = [mkEdge(n1, n1c)];
    const inserts: PasteInsert[] = [
      { parent: root, node: n1, edge: mkEdge(root, n1), inner: inner1, index: 1 },
      { parent: root, node: n2, edge: mkEdge(root, n2), inner: [], index: 2 },
    ];
    const cmd = makePasteCommand(depsFor(tree), inserts);
    cmd.redo();
    expect(texts(root)).toEqual(["a", "n1", "n2"]);
    sameEdges(tree, [eRA, ...inserts.map((i) => i.edge), inner1[0]!]);
    cmd.undo();
    expect(texts(root)).toEqual(["a"]);
    sameEdges(tree, [eRA]);
  });
});

describe("history-codec：载荷往返与解码后重放", () => {
  it("add：往返数据一致，重建命令 redo/undo 重放还原结构与连线引用", () => {
    const a = ft("a", { id: "a" });
    const root = ft("root", { id: "root", children: [a] });
    const tree = newModel(root);
    tree.mountEdges([mkEdge(root, a)]);
    const n = ft("n", { id: "n" });
    const e2 = mkEdge(root, n);
    const bound: FT[] = [];
    const cmd = makeAddCommand(depsFor(tree, bound), {
      parent: root,
      node: n,
      index: 0,
      edge: e2,
    });
    const payload = cmd.toJSON();
    expect(payload).toEqual({
      kind: "mindmap.add",
      payload: {
        parentId: "root",
        index: 0,
        edgeId: e2.id,
        node: { id: "n", text: "n", children: [] },
      },
    });
    // 最终态 = 已应用：先 redo 再按载荷解码（与 importHistory 生产时序一致）
    cmd.redo();
    const codec = codecFor(tree, bound);
    const decoded = codec.decode(payload as unknown as SerializedCommand);
    expect(decoded).not.toBeNull();
    // 重建命令的 toJSON 透传原始载荷：导入后再导出数据稳定
    expect(decoded!.toJSON()).toEqual(payload);
    decoded!.undo();
    expect(texts(root)).toEqual(["a"]);
    decoded!.redo();
    expect(texts(root)).toEqual(["n", "a"]);
    // 重建节点经 bindNode 统一登记（redo 挂载路径）
    expect(bound.some((t) => t.id === "n")).toBe(true);
    // 连线按原 id 重建并接回重建实例
    const re = tree.edges.find((e) => e.id === e2.id)!;
    expect(re.fromNode).toBe(root as unknown as Text);
    expect(re.toNode).toBe(tree.root!.children[0]);
  });

  it("delete：死连线按 id 解析还原，被删子树整体重建且端点指向重建实例", () => {
    const g = ft("g", { id: "g" });
    const a = ft("a", { id: "a", children: [g] });
    const b = ft("b", { id: "b" });
    const root = ft("root", { id: "root", children: [a, b] });
    const tree = newModel(root);
    const eRA = mkEdge(root, a);
    const eAG = mkEdge(a, g);
    const eRB = mkEdge(root, b);
    tree.mountEdges([eRA, eAG, eRB]);
    const cmd = makeDeleteCommand(depsFor(tree), [
      { node: a, parent: root, index: 0 },
    ]);
    // 死连线惰性定格：exec（redo）先于 toJSON（与生产时序一致），载荷才含完整 dead
    cmd.redo();
    const payload = cmd.toJSON();
    cmd.redo(); // 最终态：子树已删、死连线已清
    sameEdges(tree, [eRB]);
    const decoded = codecFor(tree).decode(payload as unknown as SerializedCommand);
    expect(decoded).not.toBeNull();
    expect(decoded!.toJSON()).toEqual(payload);
    decoded!.undo();
    expect(texts(root)).toEqual(["a", "b"]);
    const ra = root.children[0] as unknown as FT;
    expect(ra.text).toBe("a");
    expect(texts(ra)).toEqual(["g"]);
    sameEdges(tree, [eRA, eAG, eRB]);
    const reRA = tree.edges.find((e) => e.id === eRA.id)!;
    expect(reRA.fromNode).toBe(root as unknown as Text);
    expect(reRA.toNode).toBe(ra as unknown as Text);
    decoded!.redo();
    expect(texts(root)).toEqual(["b"]);
    sameEdges(tree, [eRB]);
  });

  it("move：按 id 解析节点与两侧连线，undo/redo 重放换父与样式", () => {
    const s0: Style = { ...defaultStyle, fontSize: 24 };
    const s1: Style = { ...defaultStyle, fontSize: 18 };
    const a = ft("a", { id: "a" });
    const b = ft("b", { id: "b" });
    const root = ft("root", { id: "root", children: [a, b] });
    const tree = newModel(root, [s0, s1]);
    const eRA = mkEdge(root, a);
    const eRB = mkEdge(root, b);
    tree.mountEdges([eRA, eRB]);
    const eBA = mkEdge(b, a);
    const cmd = makeMoveCommand(depsFor(tree), [
      {
        node: a,
        oldParent: root,
        oldIndex: 0,
        newParent: b,
        newIndex: 0,
        oldStyle: s0,
        newStyle: s1,
        oldEdge: eRA,
        newEdge: eBA,
      },
    ]);
    const payload = cmd.toJSON();
    cmd.redo(); // 最终态：a 已在 b 下
    const decoded = codecFor(tree).decode(payload as unknown as SerializedCommand);
    expect(decoded).not.toBeNull();
    expect(decoded!.toJSON()).toEqual(payload);
    decoded!.undo();
    expect(texts(root)).toEqual(["a", "b"]);
    expect(texts(b)).toEqual([]);
    expect(a.fontSize).toBe(24);
    sameEdges(tree, [eRA, eRB]);
    decoded!.redo();
    expect(texts(root)).toEqual(["b"]);
    expect(texts(b)).toEqual(["a"]);
    expect(a.fontSize).toBe(18);
    sameEdges(tree, [eRB, eBA]);
  });

  it("text 与 composite：未知节点返回 null，组合命令递归解码", () => {
    const a = ft("a", { id: "a" });
    const root = ft("root", { id: "root", children: [a] });
    const tree = newModel(root);
    const codec = codecFor(tree);
    // 未知 id 且无内嵌数据：解析失败整体放弃导入
    expect(
      codec.decode({
        kind: "mindmap.text",
        payload: { nodeId: "zzz", before: "x", after: "y" },
      } as unknown as SerializedCommand),
    ).toBeNull();
    const payload = makeTextCommand(a as unknown as Text, "x", "y").toJSON();
    const decoded = codec.decode(payload as unknown as SerializedCommand)!;
    decoded.undo();
    expect(a.text).toBe("x");
    decoded.redo();
    expect(a.text).toBe("y");
    // composite：子命令递归走本解码器（children 为完整 SerializedCommand）
    const comp = codec.decode({
      kind: "composite",
      payload: { type: "ai", children: [payload] },
    } as unknown as SerializedCommand)!;
    comp.undo();
    expect(a.text).toBe("x");
    comp.redo();
    expect(a.text).toBe("y");
  });

  it("render：after 侧全新重建（id 冲突后注册者胜出），连线端点绑定重建实例", () => {
    const a = ft("a", { id: "a" });
    const root = ft("root", { id: "root", children: [a] });
    const tree = newModel(root);
    const eRA = mkEdge(root, a);
    tree.mountEdges([eRA]);
    // 原始 render 命令：before = 当前树，after 复用同一组 id 表达全新结构
    const a2 = ft("a2", { id: "a" });
    const root2 = ft("root2", { id: "root", children: [a2] });
    const e2 = mkEdge(root2, a2);
    const cmd = makeRenderCommand(
      depsFor(tree),
      { root: root as unknown as Text, edges: [eRA] },
      { root: root2 as unknown as Text, edges: [e2] },
    );
    const payload = cmd.toJSON();
    cmd.redo(); // 最终态 = after 侧已接管
    expect(tree.root).toBe(root2 as unknown as Text);
    const bound: FT[] = [];
    const decoded = codecFor(tree, bound).decode(
      payload as unknown as SerializedCommand,
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.toJSON()).toEqual(payload);
    decoded!.undo();
    // undo 回到 before 侧（按载荷重建，端点自洽）
    expect(tree.root!.text).toBe("root");
    const ra = tree.root!.children[0] as unknown as FT;
    expect(ra.text).toBe("a");
    const be = tree.edges.find((e) => e.id === eRA.id)!;
    expect(be.fromNode).toBe(tree.root);
    expect(be.toNode).toBe(ra as unknown as Text);
    decoded!.redo();
    // 回归：redo 换入 after 侧后，连线端点必须指向重建的 after 实例
    //（resolveEdge 命中现存连线表须校验端点一致，否则会绑到重建前的旧实例上）
    expect(tree.root!.text).toBe("root2");
    const ra2 = tree.root!.children[0] as unknown as FT;
    expect(ra2.text).toBe("a2");
    const ae = tree.edges.find((e) => e.id === e2.id)!;
    expect(ae.fromNode).toBe(tree.root);
    expect(ae.toNode).toBe(ra2 as unknown as Text);
  });

  it("layout：合法方向重建并回调 onDirection，非法方向返回 null", () => {
    const tree = newModel(ft("root", { id: "root" }));
    const dirs: LayoutDirection[] = [];
    const codec = codecFor(tree, [], dirs);
    const decoded = codec.decode({
      kind: "mindmap.layout",
      payload: { before: "left", after: "down" },
    } as unknown as SerializedCommand)!;
    decoded.redo();
    expect(dirs).toEqual(["down"]);
    decoded.undo();
    expect(dirs).toEqual(["down", "left"]);
    expect(
      codec.decode({
        kind: "mindmap.layout",
        payload: { before: "x" as LayoutDirection, after: "down" },
      } as unknown as SerializedCommand),
    ).toBeNull();
  });
});

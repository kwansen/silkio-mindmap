// MindTree 模型回归测试：序列化、级数、样式解析与折叠可见性联动。
// Text 构造函数依赖 DOM（document/canvas 测量），node 环境下用最小 stub：
// Object.create(Text.prototype) 绕过构造器，手动铺 text/collapsed/children/parent 字段
// （text setter 内的 measure 由 measureCtx 缺失自动跳过，不会触碰 DOM）。
import { describe, expect, it } from "vitest";
import { Text } from "@silker/core";
import type { Node } from "@silker/core";
import { MindTree } from "../src/model";
import type { MindEdge } from "../src/Edge";
import { defaultStyle } from "../src/types";
import type { MindMapNode, Style } from "../src/types";

type FT = Text & {
  text: string;
  collapsed: boolean;
  visible: boolean;
  children: Node[];
  parent: Node | null;
};

const f = (text: string, children: FT[] = [], collapsed = false): FT => {
  const n = Object.create(Text.prototype) as FT;
  n.text = text;
  n.collapsed = collapsed;
  n.visible = true;
  n.children = children;
  n.parent = null;
  children.forEach((c) => (c.parent = n));
  return n;
};

const asT = (n: FT): Text => n as unknown as Text;

const newTree = (levelStyles: Style[] = []) =>
  new MindTree({ levelStyles, edgeStyle: "bezier" });

describe("MindTree.serializeNode / toJSON", () => {
  it("toJSON：未初始化时抛错", () => {
    const tree = newTree();
    expect(() => tree.toJSON()).toThrow("MindMap 尚未初始化完成");
  });

  it("serializeNode：文本 + 折叠态 + 子树递归", () => {
    const leaf = f("leaf");
    const child = f("child", [leaf], true);
    const root = f("root", [child]);
    const tree = newTree();
    tree.root = asT(root);
    expect(tree.toJSON()).toEqual({
      text: "root",
      children: [
        {
          text: "child",
          collapsed: true,
          children: [{ text: "leaf", children: [] }],
        },
      ],
    });
  });

  it("serializeNode：自定义样式入档，未自定义的节点不带 style 字段", () => {
    const a = f("a");
    const b = f("b");
    const root = f("root", [a, b]);
    const tree = newTree();
    tree.root = asT(root);
    const custom: Style = { ...defaultStyle, color: "#ff0000" };
    tree.customStyles.set(asT(b), custom);
    const json = tree.toJSON();
    expect(json.children[0]).not.toHaveProperty("style");
    expect(json.children[1].style).toEqual(custom);
  });
});

describe("MindTree.depthOf / levelStyle / newNodeStyle", () => {
  it("depthOf：沿 parent 链回溯，根为 0", () => {
    const g = f("g");
    const c = f("c", [g]);
    const root = f("r", [c]);
    const tree = newTree();
    expect(tree.depthOf(asT(root))).toBe(0);
    expect(tree.depthOf(asT(c))).toBe(1);
    expect(tree.depthOf(asT(g))).toBe(2);
  });

  it("levelStyle：按级数取配置，超出长度套用最后一项，未配置兜底 defaultStyle", () => {
    const s0: Style = { ...defaultStyle, fontSize: 24 };
    const s1: Style = { ...defaultStyle, fontSize: 18 };
    const tree = newTree([s0, s1]);
    expect(tree.levelStyle(0)).toBe(s0);
    expect(tree.levelStyle(1)).toBe(s1);
    expect(tree.levelStyle(5)).toBe(s1);
    expect(newTree().levelStyle(0)).toBe(defaultStyle);
  });

  it("newNodeStyle：配置级数样式按级数取值，未配置沿用参考节点的实际样式缓存", () => {
    const s1: Style = { ...defaultStyle, fontSize: 18 };
    const withCfg = newTree([defaultStyle, s1]);
    const ref = f("ref");
    expect(withCfg.newNodeStyle(asT(ref), 1)).toBe(s1);
    const noCfg = newTree();
    const cached: Style = { ...defaultStyle, color: "#123456" };
    noCfg.nodeStyles.set(asT(ref), cached);
    expect(noCfg.newNodeStyle(asT(ref), 3)).toBe(cached);
  });
});

describe("MindTree.applyCollapseVisibility", () => {
  it("折叠子树整体隐藏（含连线），展开恢复", () => {
    const g = f("g");
    const c1 = f("c1", [g]);
    const c2 = f("c2");
    const root = f("r", [c1, c2]);
    const tree = newTree();
    tree.root = asT(root);
    const e1 = { fromNode: root, toNode: c1, visible: true };
    const e2 = { fromNode: root, toNode: c2, visible: true };
    const e3 = { fromNode: c1, toNode: g, visible: true };
    tree.edges = [e1, e2, e3] as unknown as MindEdge[];

    tree.applyCollapseVisibility();
    expect(root.visible).toBe(true);
    expect(c1.visible).toBe(true);
    expect(g.visible).toBe(true);
    expect([e1.visible, e2.visible, e3.visible]).toEqual([true, true, true]);

    c1.collapsed = true;
    tree.applyCollapseVisibility();
    expect(c1.visible).toBe(true);
    expect(g.visible).toBe(false);
    // 连线可见性跟随端点：任一端不可见即隐藏
    expect(e3.visible).toBe(false);
    expect(e1.visible).toBe(true);
    expect(e2.visible).toBe(true);

    c1.collapsed = false;
    tree.applyCollapseVisibility();
    expect(g.visible).toBe(true);
    expect(e3.visible).toBe(true);
  });
});

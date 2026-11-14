// 落点候选与插入序号回归测试（drop.ts 纯函数）。
// Text 构造函数依赖 DOM（document/canvas 测量），node 环境下用最小 stub：
// Object.create(Text.prototype) 绕过构造器（dropTarget 的 instanceof Text 判定成立），
// 手动铺几何/可见性字段并覆写 getWorldPoint（避免触发 DOMMatrix 世界矩阵计算）。
import { describe, expect, it } from "vitest";
import { Text } from "@silkor/core";
import type { Node } from "@silkor/core";
import { dropIndex, dropTarget } from "../src/drop";

type FT = Text & {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  getWorldPoint: () => { x: number; y: number };
};

const f = (
  x: number,
  y: number,
  width = 100,
  height = 40,
  opts: { visible?: boolean; children?: FT[] } = {},
): FT => {
  const n = Object.create(Text.prototype) as FT;
  n.x = x;
  n.y = y;
  n.width = width;
  n.height = height;
  n.visible = opts.visible ?? true;
  (n as unknown as { _children: Node[] })._children = opts.children ?? [];
  n.getWorldPoint = () => ({ x, y });
  return n;
};

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const NO_DRAG = new Set<Node>();

// dropTarget 便捷封装：sideOf 按布局方向模拟——单侧布局返回固定侧别；
// both 布局按节点与根的世界坐标相对位置判定（与 model.sideOf 的几何判定一致）
const target = (
  direction: "left" | "right" | "down" | "both",
  children: Node[],
  b: { x: number; y: number; w: number; h: number },
  drag: Set<Node> = NO_DRAG,
): Text | null => {
  const root = children[0] as Text;
  return dropTarget(
    children,
    b,
    drag,
    direction,
    (n) => {
      if (direction === "down") return "right";
      if (direction !== "both") return direction;
      return n.getWorldPoint().x < root.getWorldPoint().x ? "left" : "right";
    },
    root,
  );
};

describe("dropTarget 落点候选", () => {
  it("floatBox 缺失返回 null", () => {
    const a = f(0, 0);
    const root = f(0, 0, 0, 0, { children: [a] });
    expect(target("right", [root], box(0, 0, 0, 0), new Set())).toBe(null);
    expect(dropTarget([root], null, NO_DRAG, "right", () => "right", root)).toBe(null);
  });

  it("从左向右布局：取合集左缘与候选节点右缘的间距，落在 DROP_RANGE 内命中", () => {
    const a = f(0, 0); // 右缘 100
    const root = f(0, 0, 0, 0, { children: [a] });
    // 合集左缘 150 → 间距 50
    expect(target("right", [root], box(150, 0, 60, 40))).toBe(a);
    // 间距 600 > DROP_RANGE(500) 不命中
    expect(target("right", [root], box(700, 0, 60, 40))).toBe(null);
  });

  it("从左向右布局：候选在合集右侧（负间距）不命中", () => {
    const a = f(400, 0); // 右缘 500 > 合集左缘 200
    expect(target("right", [a], box(200, 0, 60, 40))).toBe(null);
  });

  it("从左向右布局：多候选取水平间距最小者", () => {
    const near = f(0, 0); // 右缘 100，间距 50
    const far = f(-50, 0); // 右缘 50，间距 100
    const root = f(0, 0, 0, 0, { children: [near, far] });
    expect(target("right", [root], box(150, 0, 60, 40))).toBe(near);
  });

  it("间距相同（同层边缘对齐）时取与合集垂直中心距离最近者", () => {
    const up = f(0, 0); // cy = 20
    const down = f(0, 200); // cy = 220
    const root = f(0, 0, 0, 0, { children: [up, down] });
    // 合集 y∈[0,40] 中心 20：up 更近
    expect(target("right", [root], box(150, 0, 60, 40))).toBe(up);
    // 合集 y∈[200,240] 中心 220：down 更近
    expect(target("right", [root], box(150, 200, 60, 40))).toBe(down);
  });

  it("垂直命中带为子树纵向跨度：合集落在父节点自身范围之外仍可命中父节点", () => {
    const child = f(300, 200); // 子树跨度 [0, 240]
    const parent = f(0, 0, 100, 40, { children: [child] });
    const root = f(0, 0, 0, 0, { children: [parent] });
    // 合集 y∈[100,140]：与 parent 自身盒体不相交，但落在子树跨度内
    expect(target("right", [root], box(150, 100, 60, 40))).toBe(parent);
  });

  it("贴着后代悬浮时后代水平间距更小则优先", () => {
    const child = f(150, 200); // 右缘 250，间距 10
    const parent = f(0, 0, 100, 40, { children: [child] });
    const root = f(0, 0, 0, 0, { children: [parent] });
    // 合集左缘 260：parent 间距 160（经子树跨度命中），child 间距 10
    expect(target("right", [root], box(260, 200, 60, 40))).toBe(child);
  });

  it("被拖子树内的节点不作候选", () => {
    const child = f(150, 0);
    const parent = f(0, 0, 100, 40, { children: [child] });
    const dragging = new Set<Node>([parent, child]);
    expect(target("right", [parent], box(120, 0, 60, 40), dragging)).toBe(null);
  });

  it("隐藏节点不参与候选（隐藏子树也不贡献跨度）", () => {
    const hidden = f(0, 0, 100, 40, { visible: false });
    const visible = f(0, 0);
    const root = f(0, 0, 0, 0, { children: [hidden, visible] });
    expect(target("right", [root], box(120, 0, 60, 40))).toBe(visible);
  });

  it("从左向右布局镜像：direction 'left' 取合集右缘与候选节点左缘的间距", () => {
    const a = f(300, 0); // 左缘 300
    // 合集右缘 280 → 间距 20
    expect(target("left", [a], box(200, 0, 80, 40))).toBe(a);
    // 间距 620 > DROP_RANGE 不命中
    expect(target("left", [a], box(-400, 0, 80, 40))).toBe(null);
  });

  it("双向布局（both）：左分子树按左侧判定——合集在节点左侧命中", () => {
    // 左分子树节点位于根（x=1000）左侧：子侧为左缘，合集右缘贴近其左缘
    const root = f(1000, 0, 100, 40);
    const a = f(300, 0); // 左缘 300
    // 合集右缘 280 → 间距 20
    expect(target("both", [root, a], box(200, 0, 80, 40))).toBe(a);
    // 合集在节点右侧（对左分子树是负间距）不命中
    expect(target("both", [root, a], box(400, 0, 80, 40))).toBe(null);
  });

  it("双向布局（both）：根节点两侧均可放置", () => {
    const root = f(0, 0, 100, 40);
    // 右侧：合集左缘 160 → 间距 60
    expect(target("both", [root], box(160, 0, 60, 40))).toBe(root);
    // 左侧：合集右缘 -60 → 间距 60
    expect(target("both", [root], box(-120, 0, 60, 40))).toBe(root);
  });

  it("双向布局（both）：右分子树仍按右侧判定", () => {
    const root = f(0, 0, 100, 40);
    const a = f(300, 0); // 左缘 300，右缘 400
    // 合集左缘 460 → 间距 60
    expect(target("both", [root, a], box(460, 0, 60, 40))).toBe(a);
  });

  it("纵向布局（down）：取合集顶缘与候选节点底缘的垂直间距，落在 DROP_RANGE 内命中", () => {
    const a = f(0, 0); // 底缘 40
    const root = f(0, 0, 0, 0, { children: [a] });
    // 合集顶缘 90 → 间距 50，水平有重叠
    expect(target("down", [root], box(20, 90, 60, 40))).toBe(a);
    // 间距 600 > DROP_RANGE(500) 不命中
    expect(target("down", [root], box(20, 640, 60, 40))).toBe(null);
  });

  it("纵向布局（down）：合集顶缘高于候选节点底缘（负间距）不命中", () => {
    const a = f(0, 400); // 底缘 440 > 合集顶缘 100
    expect(target("down", [a], box(0, 100, 60, 40))).toBe(null);
  });

  it("纵向布局（down）：水平无重叠（子树横向跨度外）不命中", () => {
    const a = f(0, 0);
    const root = f(0, 0, 0, 0, { children: [a] });
    // 合集 x [500, 560] 与子树横向跨度 [0, 100] 无重叠
    expect(target("down", [root], box(500, 90, 60, 40))).toBe(null);
  });
});

describe("dropIndex 插入序号", () => {
  it("横向布局：按子节点垂直中点与 dropPoint.y 的严格小于比较计数", () => {
    const c1 = f(0, 0); // 中点 20
    const c2 = f(0, 100); // 中点 120
    const c3 = f(0, 200); // 中点 220
    const parent = f(0, 0, 0, 0, { children: [c1, c2, c3] });
    const at = (y: number) => ({ x: 0, y });
    expect(dropIndex(parent, at(-10), "right")).toBe(0);
    expect(dropIndex(parent, at(20), "right")).toBe(0); // 等于中点不计入上方
    expect(dropIndex(parent, at(21), "right")).toBe(1);
    expect(dropIndex(parent, at(121), "right")).toBe(2);
    expect(dropIndex(parent, at(1000), "right")).toBe(3);
  });

  it("横向布局：折叠隐藏的子节点不占位统计", () => {
    const c1 = f(0, 0);
    const c2 = f(0, 100, 100, 40, { visible: false });
    const c3 = f(0, 200);
    const parent = f(0, 0, 0, 0, { children: [c1, c2, c3] });
    expect(dropIndex(parent, { x: 0, y: 121 }, "right")).toBe(1);
  });

  it("纵向布局（down）：按子节点水平中点与 dropPoint.x 的严格小于比较计数", () => {
    const c1 = f(0, 0); // 中点 50
    const c2 = f(100, 0); // 中点 150
    const c3 = f(200, 0); // 中点 250
    const parent = f(0, 0, 0, 0, { children: [c1, c2, c3] });
    const at = (x: number) => ({ x, y: 0 });
    expect(dropIndex(parent, at(-10), "down")).toBe(0);
    expect(dropIndex(parent, at(50), "down")).toBe(0); // 等于中点不计入左方
    expect(dropIndex(parent, at(51), "down")).toBe(1);
    expect(dropIndex(parent, at(151), "down")).toBe(2);
    expect(dropIndex(parent, at(1000), "down")).toBe(3);
  });
});

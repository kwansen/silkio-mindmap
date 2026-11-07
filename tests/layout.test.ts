// 树形布局回归测试：layout() 的纵向堆叠、垂直居中、方向镜像与折叠语义。
// Node 为抽象类，测试用空子类构造节点（layout 只读写几何字段，不触碰渲染）。
import { describe, expect, it } from "vitest";
import { Node } from "@silker/core";
import { layout } from "../src/layout";

class T extends Node {}

const n = (width: number, height: number) => new T({ width, height });

// direction: 'right' = 从左向右布局（子节点在父右侧）；'left' 为镜像
const OPTS = { direction: "right" as const, levelGap: 60, siblingGap: 10 };

describe("layout 树形布局", () => {
  it("叶子节点：位置不变", () => {
    const root = n(100, 60);
    layout(root, OPTS);
    expect(root.x).toBe(0);
    expect(root.y).toBe(0);
  });

  it("单子节点：水平偏移 levelGap、相对父节点垂直居中", () => {
    const root = n(100, 60);
    const child = n(80, 20);
    root.add(child);
    layout(root, OPTS);
    expect(child.x).toBe(100 + 60); // parent.width + levelGap
    expect(child.y).toBe(20); // (60 - 20) / 2
  });

  it("多兄弟：按内容高度堆叠，兄弟间隙等于 siblingGap", () => {
    const root = n(100, 60);
    const c1 = n(80, 20);
    const c2 = n(80, 20);
    root.add(c1);
    root.add(c2);
    layout(root, OPTS);
    // 块高 20+10+20=50，整体居中偏移 (60-50)/2=5
    expect(c1.y).toBe(5);
    expect(c2.y).toBe(35);
    expect(c2.y - (c1.y + c1.height)).toBe(OPTS.siblingGap);
  });

  it("子树按内容实际占位堆叠：深层兄弟不与浅层重叠", () => {
    // c1 挂两个孙子（内容块高 50），c2 单节点（高 20）
    const root = n(100, 60);
    const c1 = n(80, 20);
    const c2 = n(80, 20);
    const g1 = n(60, 20);
    const g2 = n(60, 20);
    c1.add(g1);
    c1.add(g2);
    root.add(c1);
    root.add(c2);
    layout(root, OPTS);
    // c1 的内容跨度 50（孙子块），c2 紧随其后 gap=10
    // 孙子 y 相对 c1：块高 50 居中于 c1（h=20）→ shift=-15
    expect(g1.y).toBe(-15);
    expect(g2.y).toBe(15);
    // 绝对位置（父相对坐标累加）：g1 底部 < c2 顶部
    const g1Bottom = c1.y + g1.y + g1.height;
    expect(g2.y - (g1.y + g1.height)).toBe(OPTS.siblingGap);
    expect(c2.y).toBeGreaterThanOrEqual(g1Bottom + OPTS.siblingGap);
  });

  it("direction 'left'：子节点镜像到父节点左侧", () => {
    const root = n(100, 60);
    const child = n(80, 20);
    root.add(child);
    layout(root, { ...OPTS, direction: "left" });
    expect(child.x).toBe(-(80 + 60)); // -(child.width + levelGap)
  });

  it("折叠节点视为叶子：子节点位置不动", () => {
    const root = n(100, 60);
    root.collapsed = true;
    const child = n(80, 20);
    root.add(child);
    layout(root, OPTS);
    expect(child.x).toBe(0);
    expect(child.y).toBe(0);
  });

  it("visible=false 的子节点仍参与布局（可见性由上层联动）", () => {
    const root = n(100, 60);
    const c1 = n(80, 20);
    c1.visible = false;
    root.add(c1);
    layout(root, OPTS);
    expect(c1.x).toBe(160); // 照常分配位置
  });
});

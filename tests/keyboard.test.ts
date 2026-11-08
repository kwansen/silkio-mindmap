// 键盘导航回归测试：topLeftSelection 选集锚点与 navigateVertical 垂直导航评分。
// Text 构造函数依赖 DOM，node 环境下用最小 stub（Object.create(Text.prototype) 绕过构造器，
// 覆写 getWorldPoint 避免触发 DOMMatrix）；KeyboardNav 的依赖经结构化接口声明，
// 测试直接以假对象注入（模型/激活控制器的最小 stub）。
import { describe, expect, it } from "vitest";
import { Text } from "@silker/core";
import { KeyboardNav } from "../src/keyboard";
import type { KeyboardNavDeps } from "../src/keyboard";

type FT = Text & {
  visible: boolean;
  parent: FT | null;
  width: number;
  height: number;
  getWorldPoint: () => { x: number; y: number };
};

const f = (x: number, y: number, width = 100, height = 40): FT => {
  const n = Object.create(Text.prototype) as FT;
  n.visible = true;
  (n as unknown as { _children: FT[] })._children = [];
  n.parent = null;
  n.width = width;
  n.height = height;
  n.getWorldPoint = () => ({ x, y });
  return n;
};

// 构造 KeyboardNav：items 为选集，all 为模型收集到的全部节点（collectTexts stub 返回），
// activated 记录 activate 调用（导航结果断言用）；direction 缺省 'right'
const build = (
  items: FT[],
  root: FT | null,
  all: FT[],
  activated: FT[],
  direction: "left" | "right" | "down" = "right",
) => {
  const deps = {
    model: {
      root: root as unknown as Text | null,
      collectTexts: (_n: Text, out: Text[]) => {
        all.forEach((t) => out.push(t));
      },
    },
    sel: { items: items as unknown as Text[] },
    direction,
    activation: {
      // 单选派生：与 ActivationController.active 同语义
      active: items.length === 1 ? (items[0] as unknown as Text) : null,
      activate: (t: Text) => {
        activated.push(t as unknown as FT);
      },
      wake: () => {},
      keymapGuard: () => true,
    },
    collapse: { toggle: async () => {} },
    operations: { createRelated: async () => {} },
  };
  return new KeyboardNav(deps as unknown as KeyboardNavDeps);
};

// navigateVertical 为私有方法，测试经类型断言直调（评分逻辑回归）
const navigateVertical = (
  nav: KeyboardNav,
  key: "ArrowUp" | "ArrowDown",
  current: FT,
) =>
  (
    nav as unknown as {
      navigateVertical: (k: "ArrowUp" | "ArrowDown", c: Text) => void;
    }
  ).navigateVertical(key, current as unknown as Text);

describe("topLeftSelection 选集锚点", () => {
  it("多选时取最上（y 最小）节点", () => {
    const a = f(0, 200);
    const b = f(300, 100);
    const nav = build([a, b], null, [], []);
    expect(nav.topLeftSelection()).toBe(b);
  });

  it("同高（0.5 容差内）取最左（x 最小）", () => {
    const a = f(300, 100);
    const b = f(100, 100.4); // 视为同高
    const c = f(0, 101); // 超出容差，更靠下
    const nav = build([a, b, c], null, [], []);
    expect(nav.topLeftSelection()).toBe(b);
  });
});

describe("navigateVertical 垂直导航评分", () => {
  it("优先取正下方（水平区间重叠）且垂直距离最近者", () => {
    const cur = f(100, 100);
    const a = f(100, 200); // 正下，dy = 100
    const b = f(100, 400); // 正下，dy = 300
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, a, b], activated);
    navigateVertical(nav, "ArrowDown", cur);
    expect(activated).toEqual([a]);
  });

  it("无水平重叠时按斜向矩形间距（dx + dy）最近者", () => {
    const cur = f(100, 100);
    const near = f(250, 150); // dx = 50，dy = 30 → 80
    const far = f(400, 140); // dx = 300，dy = 20 → 320
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, near, far], activated);
    navigateVertical(nav, "ArrowDown", cur);
    expect(activated).toEqual([near]);
  });

  it("斜向候选不抢正下方候选（即便斜向更近）", () => {
    const cur = f(100, 100);
    const diag = f(250, 130); // 斜向：dx = 50 + dy = 10 = 60
    const below = f(100, 180); // 正下：dy = 80
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, diag, below], activated);
    navigateVertical(nav, "ArrowDown", cur);
    expect(activated).toEqual([below]);
  });

  it("隐藏节点不参与导航", () => {
    const cur = f(100, 100);
    const hidden = f(100, 200);
    hidden.visible = false;
    const below = f(100, 300);
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, hidden, below], activated);
    navigateVertical(nav, "ArrowDown", cur);
    expect(activated).toEqual([below]);
  });

  it("上方导航（ArrowUp）对称：取正上方最近者", () => {
    const cur = f(100, 300);
    const up = f(100, 100);
    const farther = f(100, 0);
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, up, farther], activated);
    navigateVertical(nav, "ArrowUp", cur);
    expect(activated).toEqual([up]);
  });
});

// 纵向布局（down）的方向键导航：层级与兄弟轴互换——↑↓ 走层级，←→ 走水平兄弟
describe("direction 'down' 层级导航", () => {
  it("ArrowDown 进入首子节点", () => {
    const root = f(0, 0);
    const c1 = f(0, 100);
    const c2 = f(200, 100);
    (root as unknown as { _children: FT[] })._children = [c1, c2];
    c1.parent = root as unknown as FT;
    c2.parent = root as unknown as FT;
    const activated: FT[] = [];
    const nav = build([root], root, [root, c1, c2], activated, "down");
    nav.navigate("ArrowDown");
    expect(activated).toEqual([c1]);
  });

  it("ArrowUp 回父节点", () => {
    const root = f(0, 0);
    const c1 = f(0, 100);
    c1.parent = root as unknown as FT;
    const activated: FT[] = [];
    const nav = build([c1], root, [root, c1], activated, "down");
    nav.navigate("ArrowUp");
    expect(activated).toEqual([root]);
  });
});

describe("navigateHorizontal 水平导航评分（direction 'down' 用）", () => {
  // navigateHorizontal 为私有方法，测试经类型断言直调
  const navigateHorizontal = (
    nav: KeyboardNav,
    key: "ArrowLeft" | "ArrowRight",
    current: FT,
  ) =>
    (
      nav as unknown as {
        navigateHorizontal: (k: "ArrowLeft" | "ArrowRight", c: Text) => void;
      }
    ).navigateHorizontal(key, current as unknown as Text);

  it("优先取正右方（垂直区间重叠）且水平距离最近者", () => {
    const cur = f(100, 100);
    const a = f(200, 100); // 正右，dx = 100
    const b = f(400, 100); // 正右，dx = 300
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, a, b], activated, "down");
    navigateHorizontal(nav, "ArrowRight", cur);
    expect(activated).toEqual([a]);
  });

  it("无垂直重叠时按斜向矩形间距（dx + dy）最近者", () => {
    const cur = f(100, 100);
    const near = f(150, 130); // dx = 0，dy = 10 → 10
    const far = f(140, 400); // dx = -10，dy = 260 → 270
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, near, far], activated, "down");
    navigateHorizontal(nav, "ArrowRight", cur);
    expect(activated).toEqual([near]);
  });

  it("左侧导航（ArrowLeft）取正左方最近者", () => {
    const cur = f(300, 100);
    const a = f(100, 100); // 正左，dx = 200
    const b = f(0, 100); // 正左，dx = 300
    const activated: FT[] = [];
    const nav = build([cur], cur, [cur, a, b], activated, "down");
    navigateHorizontal(nav, "ArrowLeft", cur);
    expect(activated).toEqual([a]);
  });
});

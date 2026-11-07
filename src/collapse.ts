import type { Node, Text } from "@silker/core";
import type { SelectionCapability } from "@silker/plugin-selection";
import { TOGGLE_RADIUS, TOGGLE_GAP } from "./CollapseToggle";
import type { MindTree } from "./model";
import type { MindMapChangeType, LayoutDirection } from "./types";

export interface CollapseDeps {
  // 模型（树根的只读消费方）
  model: Pick<MindTree, "root">;
  direction: LayoutDirection;
  // 选中能力（切换折叠后判断选中态是否指向被隐藏节点）
  sel: Pick<SelectionCapability<Text>, "items">;
  // 拖拽或框选进行中（busy 时隐藏全部展开态开关）
  isBusy: () => boolean;
  requestRender: () => void;
  onRelayout: () => Promise<void> | void;
  onDeactivate: () => void;
  emitChange: (type: MindMapChangeType) => void;
}

// 折叠控制器：折叠开关的枚举/命中/悬浮区域与折叠切换（原 MindMap 内联逻辑）。
// hoverToggles 为悬浮展开态开关所属节点集合的唯一属主
export class CollapseController {
  // 悬浮展开态开关所属节点集合（− 按需显示的数据源）：鼠标压在「节点 + 到各可见子节点
  // 连线」构成的覆盖矩形（或其开关圆）内；父子区域嵌套时可同时命中多个
  hoverToggles = new Set<Text>();

  constructor(private deps: CollapseDeps) {}

  // 枚举当前应显示的折叠开关（有子节点且可见的节点），开关圆心在节点子侧边缘外。
  // 折叠态（+）常显；展开态（−）仅鼠标悬浮该节点时显示（拖拽/框选中一律隐藏）
  items(): { node: Text; x: number; y: number; collapsed: boolean }[] {
    const root = this.deps.model.root;
    if (!root) return [];
    const ltr = this.deps.direction === "right";
    // 拖拽或框选进行中隐藏全部展开态开关，避免与交互反馈叠加
    const busy = this.deps.isBusy();
    const out: { node: Text; x: number; y: number; collapsed: boolean }[] = [];
    const walk = (n: Text) => {
      // 隐藏子树整体跳过（折叠时子孙不可见，也不显示其开关）
      if (!n.visible) return;
      if (n.children.length && (n.collapsed || (!busy && this.hoverToggles.has(n)))) {
        const p = n.getWorldPoint();
        out.push({
          node: n,
          x: ltr ? p.x + n.width + TOGGLE_GAP : p.x - TOGGLE_GAP,
          y: p.y + n.height / 2,
          collapsed: n.collapsed,
        });
      }
      n.children.forEach((c) => walk(c as Text));
    };
    walk(root);
    return out;
  }

  // 世界坐标命中的折叠开关（留少量点击余量），未命中返回 null
  hit(w: { x: number; y: number }): Text | null {
    const slop = 4;
    for (const it of this.items()) {
      if (Math.hypot(w.x - it.x, w.y - it.y) <= TOGGLE_RADIUS + slop) {
        return it.node;
      }
    }
    return null;
  }

  // 切换折叠：翻转标志后重布局（内部统一联动可见性）；选中态指向被隐藏节点时清空。
  // 展开时鼠标正压在开关上，加入悬浮集合让 − 持续可见（否则松手即隐藏）
  async toggle(node: Text) {
    node.collapsed = !node.collapsed;
    if (node.collapsed) this.hoverToggles.delete(node);
    else this.hoverToggles.add(node);
    if ([...this.deps.sel.items].some((s) => !s.visible)) this.deps.onDeactivate();
    await this.deps.onRelayout();
    this.deps.emitChange("collapse");
  }

  // 画布悬浮驱动展开态开关显隐：压在连线覆盖矩形（或其开关圆）内显示 −，离开即隐藏；
  // 集合变化才重绘。激活节点被覆盖层遮住时 canvas 收不到 move，悬浮态保持不闪断
  onMove(w: { x: number; y: number }) {
    const next = this.hoverTargets(w);
    const cur = this.hoverToggles;
    const same =
      next.size === cur.size && [...next].every((n) => cur.has(n));
    if (!same) {
      this.hoverToggles = next;
      this.deps.requestRender();
    }
  }

  // 画布离开：清空悬浮集合
  onLeave() {
    if (this.hoverToggles.size) {
      this.hoverToggles.clear();
      this.deps.requestRender();
    }
  }

  // 节点到各可见子节点连线构成的覆盖矩形（不含节点自身盒体）：连线（三种 shape 皆然）
  // 始终落在 [节点近端边缘, 子锚点] × [父锚 y, 子锚 y] 的范围内。悬浮节点本体不触发显示，
  // 仅连线区域触发；无可见子节点返回 null（无连线即无区域）
  private toggleHoverRect(n: Text) {
    const ltr = this.deps.direction === "right";
    const p = n.getWorldPoint();
    // 起点为节点近端边缘（悬浮节点本体不算），纵向含父锚 y（连线由此引出）
    let x0 = ltr ? p.x + n.width : p.x;
    let x1 = x0;
    let y0 = p.y + n.height / 2;
    let y1 = y0;
    let has = false;
    n.children.forEach((c) => {
      const t = c as Text;
      if (!t.visible) return;
      const cp = t.getWorldPoint();
      const ax = ltr ? cp.x : cp.x + t.width;
      const ay = cp.y + t.height / 2;
      x0 = Math.min(x0, ax);
      x1 = Math.max(x1, ax);
      y0 = Math.min(y0, ay);
      y1 = Math.max(y1, ay);
      has = true;
    });
    return has ? { x0, y0, x1, y1 } : null;
  }

  // 悬浮命中集合：鼠标压在展开态节点的连线覆盖矩形（不含节点本体，或其开关圆）内即命中，
  // 折叠态不依赖悬浮（+ 常显）；父子区域嵌套时同一点可命中多个节点
  hoverTargets(w: { x: number; y: number }): Set<Text> {
    const out = new Set<Text>();
    const root = this.deps.model.root;
    if (!root) return out;
    const ltr = this.deps.direction === "right";
    const walk = (n: Text) => {
      if (!n.visible) return;
      if (n.children.length && !n.collapsed) {
        const r = this.toggleHoverRect(n);
        if (r && w.x >= r.x0 && w.x <= r.x1 && w.y >= r.y0 && w.y <= r.y1) {
          out.add(n);
        } else {
          // 矩形外但压在开关圆上（从节点移向开关的过渡区），保持显示
          const p = n.getWorldPoint();
          const cx = ltr ? p.x + n.width + TOGGLE_GAP : p.x - TOGGLE_GAP;
          const cy = p.y + n.height / 2;
          if (Math.hypot(w.x - cx, w.y - cy) <= TOGGLE_RADIUS + 4) out.add(n);
        }
      }
      n.children.forEach((c) => walk(c as Text));
    };
    walk(root);
    return out;
  }
}

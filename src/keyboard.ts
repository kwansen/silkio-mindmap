import type { Text } from "@silker/core";
import type { SelectionCapability } from "@silker/core";
import type { ActivationController } from "./editing";
import type { CollapseController } from "./collapse";
import type { NodeOperations } from "./operations";
import type { MindTree } from "./model";
import type { LayoutDirection } from "./types";

export interface KeyboardNavDeps {
  model: Pick<MindTree, "root" | "collectTexts">;
  sel: Pick<SelectionCapability<Text>, "items">;
  direction: LayoutDirection;
  activation: Pick<ActivationController, "active" | "activate" | "wake" | "keymapGuard">;
  collapse: Pick<CollapseController, "toggle">;
  operations: Pick<NodeOperations, "createRelated">;
}

// 键盘导航：方向键切换节点（垂直/层级）、Tab/Enter 新建、全局按键分发（原 MindMap 内联逻辑）
export class KeyboardNav {
  constructor(private deps: KeyboardNavDeps) {}

  // 全局按键（覆盖层常驻可编辑、持有焦点时由其自身两态机处理）：
  // 覆盖层失焦时重新聚焦交还输入（不吞键），方向键导航，Tab/Enter 新建节点
  onGlobalKeydown = (e: KeyboardEvent) => {
    // 撤销/重做/复制/粘贴/删除已注册为命令并绑定键位（构造器），由命令插件统一分发；
    // 此处只处理领域语义按键（Tab/Enter 新建、方向键导航、打字唤醒编辑态）
    if (!this.deps.activation.keymapGuard(e)) return;
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      if (this.deps.activation.active)
        void this.deps.operations.createRelated(e, this.deps.activation.active);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      this.navigate(e.key);
      return;
    }
    // 打字或 IME 组合：唤醒编辑态并聚焦常驻覆盖层，默认输入/组合直接落在其上（不吞键，IME 首字符不丢）
    if (
      (e.key.length === 1 || e.keyCode === 229 || e.key === "Process") &&
      this.deps.activation.active
    ) {
      this.deps.activation.wake();
    }
  };

  // 方向键导航：方向感知——横向布局（left/right）上下在整棵树内按视觉位置选垂直方向最近的
  // 节点（可跨分支），左右按布局方向进入首子节点或回父节点；纵向布局（down）层级与兄弟轴互换：
  // 上下进入首子节点/回父节点，左右按视觉位置选水平方向最近的兄弟（可跨分支）。
  // 多选时以选集左上角节点为锚点，先收敛为单选再导航（Tab/Enter 在多选下不生效，见 onGlobalKeydown）
  navigate(key: string) {
    const root = this.deps.model.root;
    if (!root) return;
    if (!this.deps.sel.items.length) {
      this.deps.activation.activate(root);
      return;
    }
    const current = this.deps.activation.active ?? this.topLeftSelection();
    if (!this.deps.activation.active) this.deps.activation.activate(current);
    if (this.deps.direction === "down") {
      // 纵向布局：↓ 进入首子节点，↑ 回父节点，←→ 水平导航兄弟
      if (key === "ArrowDown" || key === "ArrowUp") {
        const toChild = key === "ArrowDown";
        if (toChild) {
          if (!current.children.length) return;
          // 折叠节点进入首子节点前先展开
          if (current.collapsed) void this.deps.collapse.toggle(current);
          this.deps.activation.activate(current.children[0] as Text);
        } else {
          const parent = current.parent as Text | null;
          if (parent) this.deps.activation.activate(parent);
        }
        return;
      }
      this.navigateHorizontal(key as "ArrowLeft" | "ArrowRight", current);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      this.navigateVertical(key, current);
      return;
    }
    const parent = current.parent as Text | null;
    // direction 'right' 子节点在右侧：Right 进入首子节点，Left 回父节点；direction 'left' 相反
    const toChild =
      this.deps.direction === "right" ? key === "ArrowRight" : key === "ArrowLeft";
    if (toChild) {
      if (!current.children.length) return;
      // 折叠节点进入首子节点前先展开
      if (current.collapsed) void this.deps.collapse.toggle(current);
      this.deps.activation.activate(current.children[0] as Text);
    } else if (parent) {
      this.deps.activation.activate(parent);
    }
  }

  // 选集中最靠左上角的节点：先取最上（y 最小，0.5 容差抗浮点误差），同高取最左（x 最小）
  topLeftSelection(): Text {
    return [...this.deps.sel.items].reduce((best, n) => {
      const bp = best.getWorldPoint();
      const np = n.getWorldPoint();
      if (np.y < bp.y - 0.5) return n;
      if (np.y <= bp.y + 0.5 && np.x < bp.x) return n;
      return best;
    });
  }

  // 垂直导航：↑↓ 选择上/下方最近的可导航节点 —— 先取水平区间重叠者（正上/正下），
  // 无重叠时再取斜向矩形间距最近者（斜上/斜下），←→ 仍负责层级移动
  private navigateVertical(key: "ArrowUp" | "ArrowDown", current: Text) {
    const cp = current.getWorldPoint();
    const cur = {
      left: cp.x,
      right: cp.x + current.width,
      cy: cp.y + current.height / 2,
    };
    const below = key === "ArrowDown";
    const all: Text[] = [];
    this.deps.model.collectTexts(this.deps.model.root!, all);
    const cands = all.filter((n) => {
      // 折叠隐藏的节点不参与导航
      if (!n.visible) return false;
      if (n === current) return false;
      const p = n.getWorldPoint();
      const cy = p.y + n.height / 2;
      return below ? cy > cur.cy + 0.5 : cy < cur.cy - 0.5;
    });
    if (!cands.length) return;
    // 世界包围盒与垂直距离工具
    const rect = (n: Text) => {
      const p = n.getWorldPoint();
      return { left: p.x, right: p.x + n.width, cy: p.y + n.height / 2 };
    };
    const distY = (n: Text) => Math.abs(rect(n).cy - cur.cy);
    let best: Text | null = null;
    let bestScore = Infinity;
    // 第一优先：水平区间与当前节点重叠（正上/正下），垂直距离最近者
    for (const n of cands) {
      const r = rect(n);
      if (r.left < cur.right && r.right > cur.left && distY(n) < bestScore) {
        bestScore = distY(n);
        best = n;
      }
    }
    // 第二优先：斜上/斜下，按 水平间距 + 垂直距离 度量取最近（列相邻性优先于微小的高度差）
    if (best === null) {
      for (const n of cands) {
        const r = rect(n);
        const dx = Math.max(0, cur.left - r.right, r.left - cur.right);
        const d = dx + distY(n);
        if (d < bestScore) {
          bestScore = d;
          best = n;
        }
      }
    }
    if (best) this.deps.activation.activate(best);
  }

  // 水平导航（纵向布局 down 用）：←→ 选择左/右方最近的兄弟 —— 先取垂直区间重叠者
  // （正左/正右），无重叠时再取斜向矩形间距最近者（斜左/斜右），↑↓ 仍负责层级移动
  // （与 navigateVertical 同一骨架，度量轴互换）
  private navigateHorizontal(key: "ArrowLeft" | "ArrowRight", current: Text) {
    const cp = current.getWorldPoint();
    const cur = {
      top: cp.y,
      bottom: cp.y + current.height,
      cx: cp.x + current.width / 2,
    };
    const leftward = key === "ArrowLeft";
    const all: Text[] = [];
    this.deps.model.collectTexts(this.deps.model.root!, all);
    const cands = all.filter((n) => {
      // 折叠隐藏的节点不参与导航
      if (!n.visible) return false;
      if (n === current) return false;
      const p = n.getWorldPoint();
      const cx = p.x + n.width / 2;
      return leftward ? cx < cur.cx - 0.5 : cx > cur.cx + 0.5;
    });
    if (!cands.length) return;
    // 世界包围盒与水平距离工具
    const rect = (n: Text) => {
      const p = n.getWorldPoint();
      return { top: p.y, bottom: p.y + n.height, cx: p.x + n.width / 2 };
    };
    const distX = (n: Text) => Math.abs(rect(n).cx - cur.cx);
    let best: Text | null = null;
    let bestScore = Infinity;
    // 第一优先：垂直区间与当前节点重叠（正左/正右），水平距离最近者
    for (const n of cands) {
      const r = rect(n);
      if (r.top < cur.bottom && r.bottom > cur.top && distX(n) < bestScore) {
        bestScore = distX(n);
        best = n;
      }
    }
    // 第二优先：斜左/斜右，按 垂直间距 + 水平距离 度量取最近（行相邻性优先于微小的宽度差）
    if (best === null) {
      for (const n of cands) {
        const r = rect(n);
        const dy = Math.max(0, cur.top - r.bottom, r.top - cur.bottom);
        const d = dy + distX(n);
        if (d < bestScore) {
          bestScore = d;
          best = n;
        }
      }
    }
    if (best) this.deps.activation.activate(best);
  }
}

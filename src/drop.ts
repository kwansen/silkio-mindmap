import { Text } from "@silker/core";
import type { Node } from "@silker/core";
import type { LayoutDirection } from "./types";

// 落点判定间距上限（世界坐标）：合集左缘与左侧节点右缘间距在 0..DROP_RANGE 内视为候选（后期可能需要调整）
export const DROP_RANGE = 500;

// 落点候选判定：不做鼠标悬浮命中，按几何间距——
// 从左向右布局（direction 'right'）取合集左缘到左侧节点右缘的间距，
// 从右向左布局（direction 'left'）镜像取合集右缘到右侧节点左缘的间距；
// 间距在 0..DROP_RANGE 内为候选，多个候选取水平间距最小者（同层节点边缘对齐时间距相同，
// 退而取与合集中心垂直距离最近者）。被拖子树内的节点不作候选。
// 垂直命中带是节点的「子树纵向跨度」（自身 + 全部后代的 y 区间并集）而非节点自身：
// 悬浮在目标纵向范围之外（如一级节点下方的空白区）也能命中它；贴着某个后代悬浮时
// 后代水平间距更小仍优先，故深处节点不会被祖先抢走
export function dropTarget(
  children: readonly Node[],
  floatBox: { x: number; y: number; w: number; h: number } | null,
  subtree: Set<Node>,
  direction: LayoutDirection,
): Text | null {
  const f = floatBox;
  if (!f) return null;
  const ltr = direction === "right";
  const centerY = f.y + f.h / 2;
  let best: Text | null = null;
  let bestGap = Infinity;
  let bestDy = Infinity;
  // 后序遍历：返回以 n 为根的子树纵向跨度 [minY, maxY]（隐藏子树不参与跨度与候选）
  const walk = (n: Node): [number, number] => {
    if (!n.visible) return [Infinity, -Infinity];
    const p = n.getWorldPoint();
    let minY = p.y;
    let maxY = p.y + n.height;
    n.children.forEach((c) => {
      const [cy0, cy1] = walk(c);
      if (cy0 < minY) minY = cy0;
      if (cy1 > maxY) maxY = cy1;
    });
    if (n instanceof Text && !subtree.has(n)) {
      const vOverlap =
        Math.min(f.y + f.h, maxY) - Math.max(f.y, minY);
      if (vOverlap > 0) {
        const gap = ltr ? f.x - (p.x + n.width) : p.x - (f.x + f.w);
        if (gap >= 0 && gap <= DROP_RANGE) {
          const dy = Math.abs(centerY - (p.y + n.height / 2));
          if (gap < bestGap || (gap === bestGap && dy < bestDy)) {
            best = n;
            bestGap = gap;
            bestDy = dy;
          }
        }
      }
    }
    return [minY, maxY];
  };
  children.forEach(walk);
  return best;
}

// 落点插入位置：按拖拽合集垂直中点与目标现有子节点的垂直中点比较，
// 返回应插入的序号（子节点垂直堆叠，中点在其上方的都排在前面；无落点信息时兜底追加到末尾）
export function dropIndex(parent: Text, dropY: number): number {
  let index = 0;
  for (const child of parent.children) {
    const c = child as Text;
    // 折叠隐藏的子节点不占位统计
    if (!c.visible) continue;
    if (c.getWorldPoint().y + c.height / 2 < dropY) index++;
  }
  return index;
}

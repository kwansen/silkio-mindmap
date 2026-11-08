import { Text } from "@silker/core";
import type { Node } from "@silker/core";
import type { LayoutDirection } from "./types";

// 落点判定间距上限（世界坐标）：相邻节点边缘间距在 0..DROP_RANGE 内视为候选（后期可能需要调整）
export const DROP_RANGE = 500;

// 落点候选判定（横向布局）：不做鼠标悬浮命中，按几何间距——
// 取合集盒子到候选节点「子侧」边缘的间距（子侧由 sideOf 按节点逐个判定：
// 单侧布局全局一致，双向布局按节点与根的相对位置）；
// 间距在 0..DROP_RANGE 内为候选，多个候选取水平间距最小者（同层节点边缘对齐时间距相同，
// 退而取与合集中心垂直距离最近者）。被拖子树内的节点不作候选。
// 双向布局的根节点两侧均为子侧：左右两侧的间距取较小者参与竞争。
// 垂直命中带是节点的「子树纵向跨度」（自身 + 全部后代的 y 区间并集）而非节点自身：
// 悬浮在目标纵向范围之外（如一级节点下方的空白区）也能命中它；贴着某个后代悬浮时
// 后代水平间距更小仍优先，故深处节点不会被祖先抢走
function dropTargetH(
  children: readonly Node[],
  f: { x: number; y: number; w: number; h: number },
  subtree: Set<Node>,
  sideOf: (n: Text) => "left" | "right",
  both: boolean,
  root: Text | null,
): Text | null {
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
        const isLeft = sideOf(n) === "left";
        // 子侧间距：拖到节点子侧（右向布局在右、左向布局在左）即成为其子节点
        const childGap = isLeft ? p.x - (f.x + f.w) : f.x - (p.x + n.width);
        let gap = childGap;
        // 双向布局根节点两侧均可放置：另一侧间距有效（≥0）时取两侧较小者
        if (both && n === root) {
          const other = isLeft ? f.x - (p.x + n.width) : p.x - (f.x + f.w);
          if (other >= 0 && (gap < 0 || other < gap)) gap = other;
        }
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

// 落点候选判定（纵向布局 down，组织结构图）：横向判定的旋转版——
// 取合集顶缘到节点（子树）底缘的垂直间距，水平命中带是节点的「子树横向跨度」
// （自身 + 全部后代的 x 区间并集）：悬浮在子树横向范围之外也能命中它；
// 贴着某个后代悬浮时后代垂直间距更小仍优先，深处节点不会被祖先抢走
function dropTargetV(
  children: readonly Node[],
  f: { x: number; y: number; w: number; h: number },
  subtree: Set<Node>,
): Text | null {
  const centerX = f.x + f.w / 2;
  let best: Text | null = null;
  let bestGap = Infinity;
  let bestDx = Infinity;
  // 后序遍历：返回以 n 为根的子树横向跨度 [minX, maxX]（隐藏子树不参与跨度与候选）
  const walk = (n: Node): [number, number] => {
    if (!n.visible) return [Infinity, -Infinity];
    const p = n.getWorldPoint();
    let minX = p.x;
    let maxX = p.x + n.width;
    n.children.forEach((c) => {
      const [cx0, cx1] = walk(c);
      if (cx0 < minX) minX = cx0;
      if (cx1 > maxX) maxX = cx1;
    });
    if (n instanceof Text && !subtree.has(n)) {
      const hOverlap =
        Math.min(f.x + f.w, maxX) - Math.max(f.x, minX);
      if (hOverlap > 0) {
        const gap = f.y - (p.y + n.height);
        if (gap >= 0 && gap <= DROP_RANGE) {
          const dx = Math.abs(centerX - (p.x + n.width / 2));
          if (gap < bestGap || (gap === bestGap && dx < bestDx)) {
            best = n;
            bestGap = gap;
            bestDx = dx;
          }
        }
      }
    }
    return [minX, maxX];
  };
  children.forEach(walk);
  return best;
}

// 落点候选判定：按布局方向分发（横向左右 / 纵向 down 旋转版）；
// 横向布局逐节点判定子侧（sideOf），双向布局（both）下两侧节点各自镜像
export function dropTarget(
  children: readonly Node[],
  floatBox: { x: number; y: number; w: number; h: number } | null,
  subtree: Set<Node>,
  direction: LayoutDirection,
  sideOf: (n: Text) => "left" | "right",
  root: Text | null,
): Text | null {
  if (!floatBox) return null;
  if (direction === "down") return dropTargetV(children, floatBox, subtree);
  return dropTargetH(
    children,
    floatBox,
    subtree,
    sideOf,
    direction === "both",
    root,
  );
}

// 落点插入位置（横向布局）：按拖拽合集垂直中点与目标现有子节点的垂直中点比较，
// 返回应插入的序号（子节点垂直堆叠，中点在其上方的都排在前面）
function dropIndexH(parent: Text, dropY: number): number {
  let index = 0;
  for (const child of parent.children) {
    const c = child as Text;
    // 折叠隐藏的子节点不占位统计
    if (!c.visible) continue;
    if (c.getWorldPoint().y + c.height / 2 < dropY) index++;
  }
  return index;
}

// 落点插入位置（纵向布局 down）：子节点水平排列，按拖拽合集水平中点与
// 各子节点水平中点比较，中点在其左侧的都排在前面
function dropIndexV(parent: Text, dropX: number): number {
  let index = 0;
  for (const child of parent.children) {
    const c = child as Text;
    if (!c.visible) continue;
    if (c.getWorldPoint().x + c.width / 2 < dropX) index++;
  }
  return index;
}

// 落点插入位置：按布局方向分发（横向按 y 排序 / 纵向按 x 排序）；
// 无落点信息时兜底追加到末尾（dropPoint 传 Infinity 即满足该语义）
export function dropIndex(
  parent: Text,
  dropPoint: { x: number; y: number },
  direction: LayoutDirection,
): number {
  if (direction === "down") return dropIndexV(parent, dropPoint.x);
  return dropIndexH(parent, dropPoint.y);
}

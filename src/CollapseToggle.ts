import { Node } from "@silkor/core";

// 开关圆半径与到节点边缘的间距（世界坐标单位，随视口缩放）
export const TOGGLE_RADIUS = 9;
export const TOGGLE_GAP = 12;

// 开关项：圆心世界坐标 + 折叠态（决定画 − 还是 +）
export interface CollapseToggleItem {
  x: number;
  y: number;
  collapsed: boolean;
}

// 折叠开关覆盖层：为每个有子节点且可见的节点在子侧绘制圆形开关（− 展开 / + 折叠）。
// 位置由 MindMap 注入的 items 函数在渲染时实时枚举，节点移动/折叠后无需重定位
export class CollapseToggle extends Node {
  // 渲染时实时枚举当前应显示的开关项（MindMap 按 visible + 有子节点过滤）
  items: () => CollapseToggleItem[] = () => [];
  stroke = "#94a3b8";
  fill = "#ffffff";
  glyph = "#6b7280";

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const it of this.items()) {
      // 圆底
      ctx.beginPath();
      ctx.arc(it.x, it.y, TOGGLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = this.fill;
      ctx.fill();
      ctx.strokeStyle = this.stroke;
      ctx.stroke();
      // − 横线；折叠态加一条竖线构成 +
      const r = TOGGLE_RADIUS * 0.45;
      ctx.strokeStyle = this.glyph;
      ctx.beginPath();
      ctx.moveTo(it.x - r, it.y);
      ctx.lineTo(it.x + r, it.y);
      if (it.collapsed) {
        ctx.moveTo(it.x, it.y - r);
        ctx.lineTo(it.x, it.y + r);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

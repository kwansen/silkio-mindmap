import { Node } from "@silker/core";
import type { Text } from "@silker/core";

// 激活节点高亮环：渲染时实时读取目标节点包围盒描边，节点移动后无需重定位（元函数：跟随渲染）
// 支持多目标：框选激活多个节点时逐个描边
export class ActiveHighlight extends Node {
  targets: Text[] = [];
  // 高亮颜色：激活态蓝色、编辑态紫色（由 MindMap 按覆盖层两态切换）
  color = "#3b82f6";
  // 线宽与圆角按视口缩放折算，保证屏幕视觉粗细恒定
  getScale: () => number;

  constructor(getScale: () => number) {
    super();
    this.getScale = getScale;
  }

  render(ctx: CanvasRenderingContext2D) {
    const scale = this.getScale();
    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2 / scale;
    for (const t of this.targets) {
      const p = t.getWorldPoint();
      ctx.beginPath();
      // 紧贴节点包围盒（无外边距），圆角沿用节点自身圆角，视觉与节点形状一致
      ctx.roundRect(p.x, p.y, t.width, t.height, t.boxStyle.radius ?? 0);
      ctx.stroke();
    }
    ctx.restore();
  }
}

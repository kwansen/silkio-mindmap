import { Node } from "@silker/core";
import type { Text } from "@silker/core";
import { Edge } from "@silker/core";

// 拖拽视觉反馈层（渲染时实时读取状态，元函数：跟随渲染）：
// - 原位虚影：由 ActiveHighlight 虚线暗蓝环 + 被拖节点文字转暗色承担（不用 opacity，避免多层父节点透明度叠加后不可见）
// - 跟随鼠标：克隆首个被拖节点（dragChip，mindmap 挂为本节点子节点）半透明跟随，样式与原节点一致
// - 落点提示：与思维导图一致的贝塞尔连线，从命中节点边缘中点连到合集矩形边缘中点，表示可放置
export class DragGhost extends Node {
  // 跟随鼠标的合集包围盒（被按住节点的原始包围盒 + 拖拽位移）
  floatBox: { x: number; y: number; w: number; h: number } | null = null;
  // 候选落点目标节点（连线起点）
  target: Text | null = null;
  // 布局镜像：从右向左布局（direction 'left'）时连线锚点左右互换
  mirror = false;
  // 纵向布局（direction 'down'）：落点连线走垂直方向（目标底缘中点 → 合集矩形近端缘中点）
  vertical = false;
  // 落点连线：复用底层 Edge 绘制与思维导图一致的贝塞尔曲线
  private link = new Edge({ color: "rgba(255, 187, 235, 1)" });

  // 反馈层不参与点击命中测试
  hitNode(): Node | null {
    return null;
  }

  render(ctx: CanvasRenderingContext2D) {
    if (!this.floatBox || !this.target) return;
    ctx.save();
    const f = this.floatBox;
    const p = this.target.getWorldPoint();
    if (this.vertical) {
      // 纵向布局：目标底缘中点 → 合集矩形近端（上/下）缘中点，贝塞尔弯折轴为纵向
      // （底层 Edge 贝塞尔渲染器弯折轴为横向，这里直接绘制纵向曲线）
      const fromX = p.x + this.target.width / 2;
      const fromY = p.y + this.target.height;
      const below = f.y >= fromY;
      const toY = below ? f.y : f.y + f.h;
      const toX = f.x + f.w / 2;
      const my = (fromY + toY) / 2;
      ctx.strokeStyle = this.link.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.bezierCurveTo(fromX, my, toX, my, toX, toY);
      ctx.stroke();
      ctx.restore();
      return;
    }
    // 横向布局：命中节点边缘垂直中点 → 合集矩形边缘垂直中点，贝塞尔曲线与思维导图连线一致
    const fromX = this.mirror ? p.x : p.x + this.target.width;
    const toX = this.mirror ? f.x + f.w : f.x;
    this.link.from = { x: fromX, y: p.y + this.target.height / 2 };
    this.link.to = { x: toX, y: f.y + f.h / 2 };
    this.link.lineWidth = 1.5;
    this.link.render(ctx);
    ctx.restore();
  }
}

import { Node } from '@silker/core'
import type { Text } from '@silker/core'

// 拖拽视觉反馈层（渲染时实时读取状态，元函数：跟随渲染）：
// - 原位虚影：各被拖子树根的原始包围盒，虚线描边（节点本体由 opacity 降低形成透明虚影）
// - 跟随鼠标：合集包围盒双层半透明矩形（叠放隐喻），随位移整体移动
// - 落点提示：合集矩形与候选目标节点之间的虚线连线，表示可放置
export class DragGhost extends Node {
  // 被拖子树根的原始世界包围盒列表（拖拽开始时定格）
  ghostBoxes: { x: number; y: number; w: number; h: number }[] = []
  // 跟随鼠标的合集包围盒（原合集包围盒 + 拖拽位移）
  floatBox: { x: number; y: number; w: number; h: number } | null = null
  // 候选落点目标节点（连线终点）
  target: Text | null = null
  // 线宽按视口缩放折算，保证屏幕视觉粗细恒定
  getScale: () => number

  constructor(getScale: () => number) {
    super()
    this.getScale = getScale
  }

  // 反馈层不参与点击命中测试
  hitNode(): Node | null {
    return null
  }

  render(ctx: CanvasRenderingContext2D) {
    if (!this.ghostBoxes.length) return
    const s = 1 / this.getScale()
    ctx.save()
    // 落点连线：从合集矩形中心到目标节点中心，先画再叠矩形，线被半透明矩形自然压淡
    if (this.floatBox && this.target) {
      const f = this.floatBox
      const p = this.target.getWorldPoint()
      const tx = p.x + this.target.width / 2
      const ty = p.y + this.target.height / 2
      ctx.beginPath()
      ctx.moveTo(f.x + f.w / 2, f.y + f.h / 2)
      ctx.lineTo(tx, ty)
      ctx.setLineDash([6 * s, 4 * s])
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.9)'
      ctx.lineWidth = 1.5 * s
      ctx.stroke()
      // 目标端小圆点
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(tx, ty, 3 * s, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(168, 85, 247, 0.9)'
      ctx.fill()
    }
    // 原位虚影框：虚线描边
    ctx.setLineDash([5 * s, 4 * s])
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)'
    ctx.lineWidth = s
    for (const b of this.ghostBoxes) {
      ctx.strokeRect(b.x, b.y, b.w, b.h)
    }
    // 跟随鼠标的合集：固定屏幕尺寸（宽高除以视口缩放，拖拽与缩放下视觉大小恒定），
    // 双层半透明灰阶矩形（错位叠放）
    if (this.floatBox) {
      const w = this.floatBox.w * s
      const h = this.floatBox.h * s
      const f = { x: this.floatBox.x, y: this.floatBox.y, w, h }
      const off = 6 * s
      ctx.setLineDash([])
      // 底层矩形（右下偏移）
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'
      ctx.fillRect(f.x + off, f.y + off, w, h)
      ctx.strokeStyle = 'rgba(107, 114, 128, 0.35)'
      ctx.lineWidth = s
      ctx.strokeRect(f.x + off, f.y + off, w, h)
      // 顶层矩形
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)'
      ctx.fillRect(f.x, f.y, w, h)
      ctx.strokeStyle = 'rgba(55, 65, 81, 0.6)'
      ctx.strokeRect(f.x, f.y, w, h)
    }
    ctx.restore()
  }
}

import { Edge as BaseEdge } from "@silkor/core"
import type { Text } from "@silkor/core"

// 计算节点一侧边缘中点的世界坐标：
// 横向布局取左/右缘（right 为 true 取右缘，否则取左缘），
// 纵向布局取底/顶缘（bottom 为 true 取底缘，否则取顶缘）
function anchorOf(node: Text, right: boolean) {
  const p = node.getWorldTransform().transformPoint({ x: right ? node.width : 0, y: node.height / 2 })
  return { x: p.x, y: p.y }
}

function anchorVOf(node: Text, bottom: boolean) {
  const p = node.getWorldTransform().transformPoint({ x: node.width / 2, y: bottom ? node.height : 0 })
  return { x: p.x, y: p.y }
}

// 纵向贝塞尔渲染器：绘制起止坐标间的三次贝塞尔曲线（控制点落在两点 y 中点上，
// 为横向 renderBezier 的旋转版，用于父节点在下、子节点在上的纵向连线）
function renderVerticalBezier(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  lineWidth: number,
) {
  const my = (from.y + to.y) / 2
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.bezierCurveTo(from.x, my, to.x, my, to.x, to.y)
  ctx.stroke()
}

// 思维导图连线：基于底层坐标 Edge，保存父子节点引用并在渲染前刷新锚点。
// vertical 为 true 时（down 组织结构图布局）父底缘中点连子顶缘中点，弯折轴旋转为纵向
export class MindMapEdge extends BaseEdge {
  fromNode: Text
  toNode: Text
  // 纵向布局（down）：锚点取底/顶缘中点，渲染走纵向贝塞尔
  vertical: boolean

  // 根据父子节点创建连线，颜色暂用默认石板灰
  constructor(from: Text, to: Text, vertical = false) {
    super({ color: "#94a3b8" })
    this.fromNode = from
    this.toNode = to
    this.vertical = vertical
  }

  // 依据父子相对位置刷新连线起止锚点：
  // 横向布局——子在右则父右缘连子左缘，反之父左缘连子右缘；
  // 纵向布局——父底缘中点连子顶缘中点
  update() {
    if (this.vertical) {
      this.from = anchorVOf(this.fromNode, true)
      this.to = anchorVOf(this.toNode, false)
      return
    }
    const a = anchorOf(this.fromNode, true)
    const b = anchorOf(this.toNode, true)
    const right = a.x <= b.x
    this.from = right ? a : anchorOf(this.fromNode, false)
    this.to = right ? anchorOf(this.toNode, false) : b
  }

  // 渲染前刷新锚点再绘制（保证节点移动后连线跟随）；纵向布局走纵向贝塞尔渲染器
  render(ctx: CanvasRenderingContext2D) {
    this.update()
    if (this.vertical) {
      const { from, to } = this.getEndpoints()
      renderVerticalBezier(ctx, from, to, this.color, this.lineWidth)
      return
    }
    super.render(ctx)
  }
}

// 路径样式思维导图连线：横向布局父级锚点先水平直线引出至两锚点水平中点再接入子级锚点；
// 纵向布局父级锚点先垂直直线引出至两锚点垂直中点再接入子级锚点
// （横向基于统一 Edge 的 path / rPath 渲染器，纵向为本文件旋转版渲染器，
// 中点与弯折由渲染器内部计算，只声明终点）
export class MindPathEdge extends BaseEdge {
  fromNode: Text
  toNode: Text
  // 纵向布局（down）：锚点取底/顶缘中点，渲染走纵向渲染器
  vertical: boolean

  // 根据父子节点创建连线，颜色暂用默认石板灰；shape 透传给底层渲染器
  constructor(
    from: Text,
    to: Text,
    shape: "path" | "rPath" = "path",
    vertical = false,
  ) {
    super({ color: "#94a3b8", shape })
    this.fromNode = from
    this.toNode = to
    this.vertical = vertical
  }

  // 依据父子相对位置刷新起止锚点（锚点取舍规则与 MindMapEdge 一致）
  update() {
    if (this.vertical) {
      this.from = anchorVOf(this.fromNode, true)
      this.to = anchorVOf(this.toNode, false)
      this.segments = [{ to: anchorVOf(this.toNode, false) }]
      return
    }
    const a = anchorOf(this.fromNode, true)
    const b = anchorOf(this.toNode, true)
    const right = a.x <= b.x
    this.from = right ? a : anchorOf(this.fromNode, false)
    const to = right ? anchorOf(this.toNode, false) : b
    this.segments = [{ to }]
    // 同步刷新 this.to：渲染只读 from + segments，但基类 getBounds 把 to 计入
    // 包围盒（图片导出按包围盒取景）——不同步会残留旧布局的锚点撑大包围盒，
    // 导致导出图片内容不居中（如 down 切 both 后内容靠上）
    this.to = to
  }

  // 渲染前刷新锚点再绘制（保证节点移动后连线跟随）；纵向布局按 shape 走纵向渲染器
  render(ctx: CanvasRenderingContext2D) {
    this.update()
    if (this.vertical) {
      const { from } = this.getEndpoints()
      const to = this.segments[0]?.to
      if (!to) return
      if (this.shape === "path") this.renderVPath(ctx, from, to)
      else this.renderVRPath(ctx, from, to)
      return
    }
    super.render(ctx)
  }

  // 纵向折线：父级锚点垂直引出至两点 y 中点，水平转向后垂直接入目标点（横-竖-横的旋转版）
  private renderVPath(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) {
    const my = (from.y + to.y) / 2
    ctx.strokeStyle = this.color
    ctx.lineWidth = this.lineWidth
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(from.x, my)
    ctx.lineTo(to.x, my)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }

  // 纵向圆角折线：第一个弯折保持直角，第二个弯折用四分之一圆弧过渡后垂直接入目标点
  // （rPath 的旋转版，arcTo 圆角半径越界自动收缩）
  private renderVRPath(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) {
    const my = (from.y + to.y) / 2
    const dx = Math.sign(to.x - from.x)
    const r = Math.min(this.cornerRadius, Math.abs(to.x - from.x), Math.abs(to.y - my))
    ctx.strokeStyle = this.color
    ctx.lineWidth = this.lineWidth
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    // ① 竖：直线引出至 y 中点
    ctx.lineTo(from.x, my)
    // ② 横：直角转向后水平行至圆弧起点
    ctx.lineTo(to.x - dx * r, my)
    // ③ 弯：四分之一圆弧过渡（切点自动落在水平线终点与垂直线上）
    ctx.arcTo(to.x, my, to.x, to.y, r)
    // ④ 竖：直线接入目标点
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }
}

// 思维导图连线类型：贝塞尔单段（MindMapEdge）或直线引出接入（MindPathEdge，path / rPath）
export type MindEdge = MindMapEdge | MindPathEdge

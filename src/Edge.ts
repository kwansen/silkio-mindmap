import { Edge as BaseEdge } from "@silker/plugin-edge"
import type { Text } from "@silker/core"

// 计算节点一侧边缘中点的世界坐标（right 为 true 取右缘，否则取左缘）
function anchorOf(node: Text, right: boolean) {
  const p = node.getWorldTransform().transformPoint({ x: right ? node.width : 0, y: node.height / 2 })
  return { x: p.x, y: p.y }
}

// 思维导图连线：基于底层坐标 Edge，保存父子节点引用并在渲染前刷新锚点
export class MindMapEdge extends BaseEdge {
  fromNode: Text
  toNode: Text

  // 根据父子节点创建连线，颜色暂用默认石板灰
  constructor(from: Text, to: Text) {
    super({ color: "#94a3b8" })
    this.fromNode = from
    this.toNode = to
  }

  // 依据父子水平相对位置刷新连线起止锚点（子在右则父右缘连子左缘，反之父左缘连子右缘）
  update() {
    const a = anchorOf(this.fromNode, true)
    const b = anchorOf(this.toNode, true)
    const right = a.x <= b.x
    this.from = right ? a : anchorOf(this.fromNode, false)
    this.to = right ? anchorOf(this.toNode, false) : b
  }

  // 渲染前刷新锚点再绘制（保证节点移动后连线跟随）
  render(ctx: CanvasRenderingContext2D) {
    this.update()
    super.render(ctx)
  }
}

// 路径样式思维导图连线：父级锚点先水平直线引出至两锚点水平中点，再接入子级锚点
// （基于统一 Edge 的 path / zBezier 渲染器，中点与弯折由渲染器内部计算，只声明终点）
export class MindPathEdge extends BaseEdge {
  fromNode: Text
  toNode: Text

  // 根据父子节点创建连线，颜色暂用默认石板灰；shape 透传给底层渲染器
  constructor(from: Text, to: Text, shape: "path" | "zBezier" | "rPath" = "path") {
    super({ color: "#94a3b8", shape })
    this.fromNode = from
    this.toNode = to
  }

  // 依据父子水平相对位置刷新起止锚点（锚点取舍规则与 MindMapEdge 一致）
  update() {
    const a = anchorOf(this.fromNode, true)
    const b = anchorOf(this.toNode, true)
    const right = a.x <= b.x
    this.from = right ? a : anchorOf(this.fromNode, false)
    this.segments = [{ to: right ? anchorOf(this.toNode, false) : b }]
  }

  // 渲染前刷新锚点再绘制（保证节点移动后连线跟随）
  render(ctx: CanvasRenderingContext2D) {
    this.update()
    super.render(ctx)
  }
}

// 思维导图连线类型：贝塞尔单段（MindMapEdge）或直线引出接入（MindPathEdge，path / zBezier）
export type MindEdge = MindMapEdge | MindPathEdge

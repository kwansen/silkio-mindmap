import { Edge as BaseEdge } from "@silker/plugin-edge"
import type { Text } from "@silker/core"

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

  // 计算节点一侧边缘中点的世界坐标（right 为 true 取右缘，否则取左缘）
  anchor(node: Text, right: boolean) {
    const p = node.getWorldTransform().transformPoint({ x: right ? node.width : 0, y: node.height / 2 })
    return { x: p.x, y: p.y }
  }

  // 依据父子水平相对位置刷新连线起止锚点（子在右则父右缘连子左缘，反之父左缘连子右缘）
  update() {
    const a = this.anchor(this.fromNode, true)
    const b = this.anchor(this.toNode, true)
    const right = a.x <= b.x
    this.from = right ? a : this.anchor(this.fromNode, false)
    this.to = right ? this.anchor(this.toNode, false) : b
  }

  // 渲染前刷新锚点再绘制（保证节点移动后连线跟随）
  render(ctx: CanvasRenderingContext2D) {
    this.update()
    super.render(ctx)
  }
}

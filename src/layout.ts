import type { App, Node, Plugin, Text } from "@silkor/core"
import { AUTO_LAYOUT_CAPABILITY } from "./auto-layout"
import type { AutoLayoutCapability, AutoLayoutOptions } from "./auto-layout"

// 思维导图树形布局（官方实现）：参数契约见 ./auto-layout（AutoLayoutOptions），
// 实现直接采用能力契约类型，保证实现与契约天然一致。
// 横向布局（left/right/both）：子树纵向堆叠于父节点左/右侧（both 时根节点的子节点
// 按整体高度等分，前段在右、后段在左）；纵向布局（down，组织结构图）：
// 子树横向排列于父节点下方——同一递归骨架，度量轴按方向旋转
export function layout<T extends Node>(
  root: T,
  options: AutoLayoutOptions
): T {
  // 纵向布局（down）：递归布局子树，返回子树内容相对节点左缘的横向范围 [left, right]（left 可为负）
  function visitDown(node: Node): { left: number; right: number } {
    // 折叠节点视作叶子：子树不参与布局（保持原位，由可见性联动隐藏）
    if (node.collapsed || node.children.length === 0) {
      return { left: 0, right: node.width }
    }

    // 先递归布局各子树，拿到它们内容相对各自节点左缘的横向范围
    const extents = node.children.map(child => visitDown(child))

    // 按内容实际占位宽度横向排列兄弟子树（而非递归宽度），保证兄弟分支互不重叠
    let cursor = 0
    const offsets = node.children.map((child, i) => {
      const { left, right } = extents[i]
      const offset = cursor - left
      cursor += right - left + options.siblingGap
      return offset
    })
    const blockWidth = cursor - options.siblingGap

    // 将子节点块整体平移，使其相对父节点水平居中
    const shift = (node.width - blockWidth) / 2
    node.children.forEach((child, i) => {
      child.x = offsets[i] + shift
      child.y = node.height + options.levelGap
    })

    // 子树内容范围 = 节点自身与子节点块的并集
    return {
      left: Math.min(0, shift),
      right: Math.max(node.width, shift + blockWidth),
    }
  }

  // 横向布局（left/right/both）：递归布局子树，返回子树内容相对节点顶部的纵向范围 [top, bottom]（top 可为负）。
  // ltr 指明该子树的子节点流向（true 子在右侧 / false 子在左侧）——单侧布局全局一致，
  // 双向布局（both）按分堆结果逐侧传入
  function visit(node: Node, ltr: boolean): { top: number; bottom: number } {
    // 折叠节点视作叶子：子树不参与布局（保持原位，由可见性联动隐藏）
    if (node.collapsed || node.children.length === 0) {
      return { top: 0, bottom: node.height }
    }

    // 先递归布局各子树，拿到它们内容相对各自节点顶部的纵向范围
    const extents = node.children.map(child => visit(child, ltr))

    // 按内容实际占位高度纵向堆叠兄弟子树（而非递归高度），保证兄弟分支互不重叠
    let cursor = 0
    const offsets = node.children.map((child, i) => {
      const { top, bottom } = extents[i]
      const offset = cursor - top
      cursor += bottom - top + options.siblingGap
      return offset
    })
    const blockHeight = cursor - options.siblingGap

    // 将子节点块整体平移，使其相对父节点垂直居中
    const shift = (node.height - blockHeight) / 2
    node.children.forEach((child, i) => {
      child.x = ltr
        ? node.width + options.levelGap
        : -(child.width + options.levelGap)
      child.y = offsets[i] + shift
    })

    // 子树内容范围 = 节点自身与子节点块的并集
    return {
      top: Math.min(0, shift),
      bottom: Math.max(node.height, shift + blockHeight),
    }
  }

  if (options.direction === 'down') visitDown(root)
  else if (options.direction === 'both') {
    // 双向平衡布局：根节点的子节点按整体高度等分——保持 children 原有顺序，在累计
    // 高度过半处切一刀，前段放右、后段放左，两侧各相对根节点垂直居中。切点而非
    // 贪心分堆：成员划分只由一条顺序切点决定，节点增删/内容变化时切点最多移动
    // 一位，不会整体洗牌跳动。只写坐标不改结构，侧别由几何位置表达（节点在根
    // 左侧即左分，交互层按几何判定侧别）
    const children = root.children as Text[]
    // 子树纵向跨度（与 visit 的布局数学一致：span = max(自身高度, 子块总高)）
    const spanOf = (node: Node): number => {
      if (node.collapsed || node.children.length === 0) return node.height
      const block =
        node.children.reduce((s, c) => s + spanOf(c), 0) +
        options.siblingGap * (node.children.length - 1)
      return Math.max(node.height, block)
    }
    const spans = children.map(spanOf)
    // 前 k 个子节点的堆叠高度（含兄弟间隙）
    const prefixH = (k: number) => {
      let s = 0
      for (let i = 0; i < k; i++) s += spans[i]
      return s + options.siblingGap * Math.max(0, k - 1)
    }
    // 切点 k ∈ [1, n-1]（两侧至少各一个子节点）；单子节点全在右。
    // 后段高度 = 总高 - 前段 - 两侧之间的一个兄弟间隙
    let k = children.length
    if (children.length >= 2) {
      const total = prefixH(children.length)
      let best = Infinity
      for (let i = 1; i < children.length; i++) {
        const diff = Math.abs(prefixH(i) - (total - prefixH(i) - options.siblingGap))
        if (diff < best) {
          best = diff
          k = i
        }
      }
    }
    // 单侧堆叠：递归布局各子树内部，再按内容跨度纵向排布并相对根节点垂直居中
    const stack = (idxs: number[], ltr: boolean) => {
      if (!idxs.length) return
      let cursor = 0
      const offsets = idxs.map(i => {
        const { top, bottom } = visit(children[i], ltr)
        const offset = cursor - top
        cursor += bottom - top + options.siblingGap
        return offset
      })
      const blockHeight = cursor - options.siblingGap
      const shift = (root.height - blockHeight) / 2
      idxs.forEach((i, j) => {
        children[i].x = ltr
          ? root.width + options.levelGap
          : -(children[i].width + options.levelGap)
        children[i].y = offsets[j] + shift
      })
    }
    stack(children.map((_, i) => i).filter(i => i < k), true)
    stack(children.map((_, i) => i).filter(i => i >= k), false)
  }
  else visit(root, options.direction === 'right')

  return root
}

// 官方布局插件：install 时自注册 mindmap.auto-layout 能力。第三方布局插件按能力键
// 注册同名能力覆盖官方实现（App.provide 替换 + uninstall 恢复），不 import 本插件
export class BuiltinTreeLayout implements Plugin {
  install(app: App) {
    const impl: AutoLayoutCapability = {
      layout: (root, options: AutoLayoutOptions) => {
        void layout(root, options)
      },
    }
    app.provide(AUTO_LAYOUT_CAPABILITY, impl, {
      provider: "mindmap.builtin-tree-layout",
    })
  }
}

import type { Node } from "@silker/core"

// 思维导图布局参数：hGap 为父子水平间距，vGap 为兄弟垂直间距
export interface LayoutOptions {
  direction: 'left' | 'right'
  levelGap: number
  siblingGap: number
}

// export function layout<T extends Node>(
//   root: T,
//   options: LayoutOptions
// ): T {
//   function visit(node: Node): number {
//     if (node.children.length === 0) {
//       return node.height
//     }

//     let y = 0

//     for (const child of node.children) {
//       child.x = node.width + options.levelGap
//       child.y = y

//       const childHeight = visit(child)

//       y += childHeight + options.siblingGap
//     }

//     return Math.max(node.height, y - options.siblingGap)
//   }

//   visit(root)

//   return root
// }

export function layout<T extends Node>(
  root: T,
  options: LayoutOptions
): T {
  // 递归布局子树，返回子树内容相对节点顶部的纵向范围 [top, bottom]（top 可为负）
  function visit(node: Node): { top: number; bottom: number } {
    if (node.children.length === 0) {
      return { top: 0, bottom: node.height }
    }

    // 先递归布局各子树，拿到它们内容相对各自节点顶部的纵向范围
    const extents = node.children.map(child => visit(child))

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
      child.x = options.direction === 'left'
        ? -(child.width + options.levelGap)
        : node.width + options.levelGap
      child.y = offsets[i] + shift
    })

    // 子树内容范围 = 节点自身与子节点块的并集
    return {
      top: Math.min(0, shift),
      bottom: Math.max(node.height, shift + blockHeight),
    }
  }

  visit(root)

  return root
}